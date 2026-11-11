import { and, eq, inArray } from "drizzle-orm";
import { Type } from "@google/genai";
import type { DB } from "../db";
import { bugs, builds, projects, reports, stories, testCases, type ReportCounts } from "../db/schema";
import { audit } from "../audit";
import type { AiClient } from "../integrations/gemini";
import type { JiraClient } from "../integrations/jira";
import { buildRows, countStatuses, envScope, latestResults, ENV_LABEL } from "./execution";
import { bugCode, SEVERITY_LABEL } from "./bugs";
import { notify } from "./notify";

export async function computeCounts(db: DB, buildId: string): Promise<ReportCounts> {
  const [b] = await db.select().from(builds).where(eq(builds.id, buildId));
  const rows = await buildRows(db, buildId);
  const tcs = await db.select().from(testCases).where(eq(testCases.storyId, b.storyId));
  const scope = envScope(tcs, b.env);
  const latest = await latestResults(db, b.storyId, b.env);
  const envList = scope.map((t) => ({ status: latest.get(t.id)?.status ?? ("not_run" as const), us: t.usCode }));
  const usCodes = [...new Set(scope.map((t) => t.usCode))].sort();
  const open = await db
    .select()
    .from(bugs)
    .where(and(eq(bugs.storyId, b.storyId), inArray(bugs.status, ["open", "in_progress", "resolved"])));
  const closed = await db.select({ id: bugs.id }).from(bugs).where(and(eq(bugs.storyId, b.storyId), eq(bugs.status, "closed")));
  const blockers = [...new Set(scope.map((t) => latest.get(t.id)).filter((l) => l?.status === "blocked" && l.linkedIssueKey).map((l) => l!.linkedIssueKey!))];
  return {
    build: countStatuses(rows.map((r) => r.e)),
    env: countStatuses(envList),
    byUs: usCodes.map((us) => ({ us, ...countStatuses(envList.filter((x) => x.us === us)) })),
    openBugs: open.map((x) => ({ key: bugCode(x), title: x.title, severity: x.severity })),
    closedBugs: closed.length,
    blockers,
  };
}

export const passRate = (c: { passed: number; total: number }) => (c.total ? Math.round((c.passed / c.total) * 100) : 0);

function autoText(c: ReportCounts): string {
  const lines = [`Pass rate ${passRate(c.env)}% (${c.env.passed}/${c.env.total}).`];
  if (c.openBugs.length) lines.push(`Còn ${c.openBugs.length} bug mở: ${c.openBugs.map((b) => `${b.key} (${SEVERITY_LABEL[b.severity]})`).join(", ")}.`);
  if (c.blockers.length) lines.push(`TC bị chặn bởi: ${c.blockers.join(", ")}.`);
  if (c.env.notRun) lines.push(`${c.env.notRun} TC chưa chạy.`);
  return lines.join(" ");
}

const SUMMARY_SCHEMA = { type: Type.OBJECT, properties: { summary: { type: Type.STRING } }, required: ["summary"] };

/** Computes the numbers for a build and (optionally) asks AI for a short commentary. */
export async function generateReport(db: DB, ai: AiClient | null, buildId: string, userId: string) {
  const [b] = await db.select().from(builds).where(eq(builds.id, buildId));
  const [s] = await db.select().from(stories).where(eq(stories.id, b.storyId));
  const counts = await computeCounts(db, buildId);
  let aiSummary: string | null = null;
  if (ai) {
    const r = await ai.generateJson<{ summary: string }>({
      system: `Bạn là QC Lead. Viết nhận xét test report tiếng Việt, 3–5 câu, không dùng markdown: điểm ổn, rủi ro, đề xuất cho round sau hoặc có nên chuyển môi trường không. Chỉ dựa vào số liệu được cung cấp.`,
      prompt: `Story ${s.jiraKey} ${s.summary}, build ${b.name} (${ENV_LABEL[b.env]}).
Kết quả round này: ${JSON.stringify(counts.build)}
Kết quả tích luỹ của môi trường: ${JSON.stringify(counts.env)}
Theo User Story: ${JSON.stringify(counts.byUs)}
Bug còn mở: ${JSON.stringify(counts.openBugs)}
Bug đã đóng: ${counts.closedBugs}
Ticket đang chặn: ${counts.blockers.join(", ") || "không"}`,
      schema: SUMMARY_SCHEMA,
    });
    aiSummary = r.summary;
  }
  const [existing] = await db.select().from(reports).where(eq(reports.buildId, buildId));
  // Keep the QC's own wording: only replace text that is still exactly what was generated before.
  const generatedBefore = existing ? [existing.aiSummary ?? "", autoText(existing.counts)] : [];
  const edited = !!existing?.finalText && !generatedBefore.includes(existing.finalText);
  const finalText = edited || existing?.postedAt ? existing!.finalText : (aiSummary ?? existing?.aiSummary ?? autoText(counts));
  if (existing) await db.update(reports).set({ counts, aiSummary: aiSummary ?? existing.aiSummary, finalText, updatedAt: new Date() }).where(eq(reports.id, existing.id));
  else await db.insert(reports).values({ buildId, counts, aiSummary, finalText });
  await audit(db, { userId, action: `Tạo report ${b.name}${ai ? " (có nhận xét AI)" : ""}`, target: s.jiraKey });
}

export async function saveReportText(db: DB, userId: string, buildId: string, text: string) {
  await db.update(reports).set({ finalText: text.trim(), updatedAt: new Date() }).where(eq(reports.buildId, buildId));
}

export function reportText(storyKey: string, summary: string, buildName: string, env: string, c: ReportCounts, finalText: string): string {
  const row = (x: { passed: number; failed: number; blocked: number; notRun: number; total: number }) =>
    `Passed ${x.passed} · Failed ${x.failed} · Blocked ${x.blocked} · Not test ${x.notRun} / ${x.total}`;
  return [
    `[Test report] ${storyKey} ${summary} · ${buildName} (${env})`,
    `Round này: ${row(c.build)}`,
    `Tích luỹ ${env}: ${row(c.env)} · pass rate ${passRate(c.env)}%`,
    ...c.byUs.map((u) => `- ${u.us}: ${u.passed}/${u.total} passed${u.failed ? `, ${u.failed} failed` : ""}${u.blocked ? `, ${u.blocked} blocked` : ""}`),
    c.openBugs.length ? `Bug còn mở: ${c.openBugs.map((b) => `${b.key} (${SEVERITY_LABEL[b.severity]})`).join(", ")}` : "Không còn bug mở.",
    c.blockers.length ? `Bị chặn bởi: ${c.blockers.join(", ")}` : "",
    "",
    finalText,
  ]
    .filter((x) => x !== "")
    .join("\n");
}

export async function postReport(db: DB, jira: JiraClient | null, buildId: string, userId: string) {
  const [b] = await db.select().from(builds).where(eq(builds.id, buildId));
  const [s] = await db.select().from(stories).where(eq(stories.id, b.storyId));
  const [p] = await db.select().from(projects).where(eq(projects.id, s.projectId));
  const [r] = await db.select().from(reports).where(eq(reports.buildId, buildId));
  if (!r) throw new Error("Chưa tạo report cho build này.");
  const text = reportText(s.jiraKey, s.summary, b.name, ENV_LABEL[b.env], r.counts, r.finalText);
  const where: string[] = [];
  if (jira && !p.isDemo) {
    await jira.addComment(s.jiraKey, text);
    where.push("Jira");
  }
  if (await notify(db, text)) where.push("Slack");
  await db.update(reports).set({ postedAt: new Date(), postedBy: userId }).where(eq(reports.id, r.id));
  await audit(db, { userId, action: `Đăng report ${b.name}${where.length ? ` lên ${where.join(", ")}` : ""}`, target: s.jiraKey });
  return where;
}

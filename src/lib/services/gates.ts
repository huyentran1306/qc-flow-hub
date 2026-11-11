import { and, desc, eq, inArray } from "drizzle-orm";
import type { DB } from "../db";
import { bugs, builds, gateEvents, projects, reports, stories, testCases, type Env, type GateRule } from "../db/schema";
import { audit } from "../audit";
import type { JiraClient } from "../integrations/jira";
import { createNextBuild, envScope, latestResults, ENV_LABEL } from "./execution";
import { notify } from "./notify";

export const NEXT_ENV: Record<Env, Env | "done"> = { dev: "stg", stg: "prod", prod: "done" };
export const NEXT_LABEL: Record<Env, string> = { dev: "Staging", stg: "Production", prod: "Hoàn tất" };

export type GateCheck = { label: string; ok: boolean; detail: string };

export async function evaluateGate(db: DB, storyId: string) {
  const [s] = await db.select().from(stories).where(eq(stories.id, storyId));
  const [p] = await db.select().from(projects).where(eq(projects.id, s.projectId));
  const env = s.currentEnv;
  const rule: GateRule = p.gateRules[env];
  const scope = envScope(await db.select().from(testCases).where(eq(testCases.storyId, storyId)), env);
  const latest = await latestResults(db, storyId, env);
  const statuses = scope.map((t) => latest.get(t.id)?.status ?? "not_run");
  const passed = statuses.filter((x) => x === "passed").length;
  const blocked = statuses.filter((x) => x === "blocked").length;
  const notRun = statuses.filter((x) => x === "not_run").length;
  const rate = scope.length ? Math.round((passed / scope.length) * 100) : 0;
  const open = await db.select().from(bugs).where(and(eq(bugs.storyId, storyId), inArray(bugs.status, ["open", "in_progress", "resolved"])));
  const bySev = (sv: string) => open.filter((b) => b.severity === sv).length;
  const [lastBuild] = await db.select().from(builds).where(and(eq(builds.storyId, storyId), eq(builds.env, env))).orderBy(desc(builds.round)).limit(1);
  const [rep] = lastBuild ? await db.select().from(reports).where(eq(reports.buildId, lastBuild.id)) : [];

  const checks: GateCheck[] = [
    { label: "Có test case trong phạm vi", ok: scope.length > 0, detail: env === "prod" ? `${scope.length} happy case` : `${scope.length} TC đã duyệt` },
    { label: "Mọi TC đã được thực thi", ok: scope.length > 0 && notRun === 0, detail: notRun ? `${notRun} TC chưa chạy` : "đủ" },
    { label: `Pass rate ≥ ${rule.minPassRate}%`, ok: rate >= rule.minPassRate, detail: `hiện ${rate}% (${passed}/${scope.length})` },
    { label: `Bug Critical mở ≤ ${rule.maxOpenCritical}`, ok: bySev("critical") <= rule.maxOpenCritical, detail: `${bySev("critical")}` },
    { label: `Bug Major mở ≤ ${rule.maxOpenMajor}`, ok: bySev("major") <= rule.maxOpenMajor, detail: `${bySev("major")}` },
    { label: `Bug Minor mở ≤ ${rule.maxOpenMinor}`, ok: bySev("minor") <= rule.maxOpenMinor, detail: `${bySev("minor")}` },
    { label: `TC Blocked ≤ ${rule.maxBlocked}`, ok: blocked <= rule.maxBlocked, detail: `${blocked}` },
  ];
  if (rule.requireReport) checks.push({ label: "Report của round cuối đã đăng", ok: !!rep?.postedAt, detail: lastBuild ? (rep?.postedAt ? lastBuild.name : `${lastBuild.name} chưa đăng`) : "chưa có build" });
  return { story: s, project: p, env, next: NEXT_ENV[env], checks, pass: checks.every((c) => c.ok), rate };
}

/** Moves a story to the next environment. Failing checks need a written reason (QC Lead only — checked by the caller). */
export async function advanceStory(db: DB, jira: JiraClient | null, storyId: string, userId: string, overrideReason: string | null) {
  const g = await evaluateGate(db, storyId);
  if (g.story.qaStage === "done") throw new Error("Story đã hoàn tất.");
  const failed = g.checks.filter((c) => !c.ok).map((c) => `${c.label} (${c.detail})`);
  if (failed.length && !overrideReason?.trim()) throw new Error(`Chưa qua gate: ${failed.join("; ")}`);
  await db.insert(gateEvents).values({ storyId, fromEnv: g.env, toEnv: g.next, overridden: failed.length > 0, reason: overrideReason?.trim() || null, failedChecks: failed, userId });

  const s = g.story;
  let message: string;
  if (g.next === "done") {
    await db.update(stories).set({ qaStage: "done" }).where(eq(stories.id, storyId));
    message = `✅ ${s.jiraKey} ${s.summary}: đã chạy xong bộ happy case trên Production. QC đóng story.`;
  } else {
    await db.update(stories).set({ currentEnv: g.next }).where(eq(stories.id, storyId));
    message =
      g.next === "stg"
        ? `🚀 ${s.jiraKey} ${s.summary}: đã ổn trên DEV, nhờ dev deploy lên STAGING.`
        : `🚀 ${s.jiraKey} ${s.summary}: đã ổn trên STAGING, sẵn sàng release Production. Sau khi release QC sẽ chạy bộ happy case.`;
    try {
      await createNextBuild(db, storyId, g.next, userId);
    } catch (e) {
      message += ` (Chưa tạo được build: ${(e as Error).message})`;
    }
  }
  if (failed.length) message += `\nVượt gate, lý do: ${overrideReason}`;
  if (jira && !g.project.isDemo) await jira.addComment(s.jiraKey, message).catch((e) => console.error("[gate comment]", e));
  await notify(db, message);
  await audit(db, {
    userId,
    action: failed.length ? `Vượt gate ${ENV_LABEL[g.env]} → ${NEXT_LABEL[g.env]}` : `Qua gate ${ENV_LABEL[g.env]} → ${NEXT_LABEL[g.env]}`,
    target: s.jiraKey,
    detail: failed.length ? { message: overrideReason, failed } : undefined,
  });
  return g.next;
}

export function parseGateForm(fd: FormData) {
  const num = (k: string, d: number) => {
    const v = Number(String(fd.get(k) ?? "").trim());
    return Number.isFinite(v) && v >= 0 ? v : d;
  };
  const rule = (env: Env): GateRule => ({
    minPassRate: Math.min(100, num(`${env}.minPassRate`, 100)),
    maxOpenCritical: num(`${env}.maxOpenCritical`, 0),
    maxOpenMajor: num(`${env}.maxOpenMajor`, 0),
    maxOpenMinor: num(`${env}.maxOpenMinor`, 0),
    maxBlocked: num(`${env}.maxBlocked`, 0),
    requireReport: fd.get(`${env}.requireReport`) === "on",
  });
  return { dev: rule("dev"), stg: rule("stg"), prod: rule("prod") };
}

export async function saveGateRules(db: DB, userId: string, projectId: string, fd: FormData) {
  const rules = parseGateForm(fd);
  const [p] = await db.update(projects).set({ gateRules: rules }).where(eq(projects.id, projectId)).returning({ key: projects.key });
  await audit(db, { userId, action: "Sửa quy tắc gate", target: p.key, detail: rules as unknown as Record<string, unknown> });
}

export async function storyGateHistory(db: DB, storyId: string) {
  return db.select().from(gateEvents).where(eq(gateEvents.storyId, storyId)).orderBy(desc(gateEvents.at));
}

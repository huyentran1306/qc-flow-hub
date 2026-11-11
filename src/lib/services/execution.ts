import { and, asc, desc, eq, inArray, max } from "drizzle-orm";
import type { DB } from "../db";
import { builds, executions, projects, stories, testCases, type Env, type ExecStatus } from "../db/schema";
import { audit } from "../audit";
import type { TestLinkClient } from "../integrations/testlink";
import type { JiraClient } from "../integrations/jira";
import { tcCode } from "../format";

export const ENV_LABEL: Record<Env, string> = { dev: "DEV", stg: "STAGING", prod: "PRODUCTION" };

export function buildName(env: Env, round: number): string {
  if (env === "prod") return round === 1 ? "PROD-SMOKE" : `PROD-SMOKE-R${round}`;
  return `${env === "dev" ? "DEV" : "STG"}-R${round}`;
}

type Tc = typeof testCases.$inferSelect;

/** Test cases in scope for an environment: all approved ones, or only happy cases on production. */
export function envScope(tcs: Tc[], env: Env): Tc[] {
  return tcs.filter((t) => t.status === "approved" && (env !== "prod" || t.type === "happy"));
}

export type Latest = { status: ExecStatus; executionId: string; linkedIssueKey: string | null; buildName: string; blockerDone: boolean };

/** Latest executed result per test case in an environment (a later build's "not run" does not hide an earlier result). */
export async function latestResults(db: DB, storyId: string, env: Env): Promise<Map<string, Latest>> {
  const rows = await db
    .select({ e: executions, b: builds })
    .from(executions)
    .innerJoin(builds, eq(builds.id, executions.buildId))
    .where(and(eq(builds.storyId, storyId), eq(builds.env, env), eq(builds.kind, "round")))
    .orderBy(asc(builds.round));
  const out = new Map<string, Latest>();
  for (const { e, b } of rows) {
    const prev = out.get(e.testCaseId);
    if (e.status === "not_run" && prev && prev.status !== "not_run") continue;
    out.set(e.testCaseId, { status: e.status, executionId: e.id, linkedIssueKey: e.linkedIssueKey, buildName: b.name, blockerDone: e.blockerDone });
  }
  return out;
}

export async function createNextBuild(db: DB, storyId: string, env: Env, userId: string | null) {
  const [story] = await db.select().from(stories).where(eq(stories.id, storyId));
  const all = await db.select().from(testCases).where(eq(testCases.storyId, storyId)).orderBy(asc(testCases.seq));
  const scope = envScope(all, env);
  if (!scope.length) throw new Error(env === "prod" ? "Chưa có test case Happy nào được duyệt cho bộ smoke PROD." : "Chưa có test case nào được duyệt.");
  const [{ m }] = await db.select({ m: max(builds.round) }).from(builds).where(and(eq(builds.storyId, storyId), eq(builds.env, env), eq(builds.kind, "round")));
  const round = Number(m ?? 0) + 1;
  let picked = scope;
  if (round > 1) {
    const latest = await latestResults(db, storyId, env);
    picked = scope.filter((t) => latest.get(t.id)?.status !== "passed");
    if (!picked.length) throw new Error(`Mọi test case ở ${ENV_LABEL[env]} đã Passed, không cần round mới.`);
  }
  const [b] = await db.insert(builds).values({ storyId, env, round, name: buildName(env, round), createdBy: userId }).returning();
  await db.insert(executions).values(picked.map((t) => ({ buildId: b.id, testCaseId: t.id })));
  if (story.qaStage !== "testing" && story.qaStage !== "done") await db.update(stories).set({ qaStage: "testing" }).where(eq(stories.id, storyId));
  await audit(db, { userId, action: `Tạo build ${b.name} (${picked.length} TC)`, target: story.jiraKey, source: userId ? "ui" : "system" });
  return b;
}

export async function storyBuilds(db: DB, storyId: string) {
  return db.select().from(builds).where(eq(builds.storyId, storyId)).orderBy(asc(builds.env), desc(builds.round));
}

export async function buildRows(db: DB, buildId: string) {
  return db
    .select({ e: executions, tc: testCases })
    .from(executions)
    .innerJoin(testCases, eq(testCases.id, executions.testCaseId))
    .where(eq(executions.buildId, buildId))
    .orderBy(asc(testCases.seq));
}

export function countStatuses(list: { status: ExecStatus }[]) {
  const c = { passed: 0, failed: 0, blocked: 0, notRun: 0, total: list.length };
  for (const x of list) {
    if (x.status === "passed") c.passed++;
    else if (x.status === "failed") c.failed++;
    else if (x.status === "blocked") c.blocked++;
    else c.notRun++;
  }
  return c;
}

const KEY_RE = /^[A-Z][A-Z0-9_]+-\d+$/;

export async function setExecution(
  db: DB,
  userId: string,
  executionId: string,
  input: { status: ExecStatus; linkedIssueKey?: string | null; notes?: string },
  opts: { byAgent?: boolean } = {},
) {
  const key = input.linkedIssueKey?.trim().toUpperCase() || null;
  if (key && !KEY_RE.test(key) && !key.startsWith("LOCAL-")) throw new Error(`Mã ticket "${key}" không đúng dạng, ví dụ OP-111111.`);
  const [row] = await db.select({ e: executions, b: builds }).from(executions).innerJoin(builds, eq(builds.id, executions.buildId)).where(eq(executions.id, executionId));
  if (!row) throw new Error("Không tìm thấy lần thực thi.");
  const keepKey = input.status === "failed" || input.status === "blocked";
  await db
    .update(executions)
    .set({
      status: input.status,
      linkedIssueKey: keepKey ? (key ?? (row.e.status === input.status ? row.e.linkedIssueKey : null)) : null,
      blockerDone: false,
      notes: input.notes ?? row.e.notes,
      executedBy: userId,
      executedAt: input.status === "not_run" ? null : new Date(),
      byAgent: !!opts.byAgent,
      reviewed: !opts.byAgent,
    })
    .where(eq(executions.id, executionId));
}

export async function markReviewed(db: DB, userId: string, executionIds: string[]) {
  if (!executionIds.length) return 0;
  const r = await db.update(executions).set({ reviewed: true }).where(inArray(executions.id, executionIds)).returning({ id: executions.id });
  await audit(db, { userId, action: `Duyệt ${r.length} kết quả do agent ghi` });
  return r.length;
}

/** Problems that must be fixed before results leave the tool. */
export function buildProblems(rows: { e: typeof executions.$inferSelect; tc: Tc }[]): string[] {
  const out: string[] = [];
  for (const { e, tc } of rows) {
    if (e.status === "failed" && !e.linkedIssueKey) out.push(`${tcCode(tc.seq)} Failed chưa gắn bug`);
    if (e.status === "blocked" && !e.linkedIssueKey) out.push(`${tcCode(tc.seq)} Blocked chưa gắn ticket chặn`);
    if (e.byAgent && !e.reviewed) out.push(`${tcCode(tc.seq)} do agent ghi, chưa được QC duyệt`);
  }
  return out;
}

const TL_STATUS = { passed: "p", failed: "f", blocked: "b" } as const;

export async function pushBuildToTestlink(db: DB, tl: TestLinkClient, buildId: string, userId: string) {
  const [b] = await db.select().from(builds).where(eq(builds.id, buildId));
  const [s] = await db.select().from(stories).where(eq(stories.id, b.storyId));
  const [p] = await db.select().from(projects).where(eq(projects.id, s.projectId));
  if (!p.testlinkProjectName) throw new Error(`Dự án ${p.key} chưa ánh xạ project TestLink.`);
  const rows = await buildRows(db, buildId);
  const problems = buildProblems(rows);
  if (problems.length) throw new Error(`Chưa gửi được: ${problems.slice(0, 4).join("; ")}`);
  const missing = rows.filter((r) => !r.tc.testlinkExternalId).map((r) => tcCode(r.tc.seq));
  if (missing.length) throw new Error(`Các TC chưa có trên TestLink: ${missing.join(", ")}. Bấm “Đẩy lên TestLink” ở tab Tổng quan trước.`);
  const tp = await tl.projectByName(p.testlinkProjectName);
  const planId = b.testlinkPlanId ?? (await tl.ensureTestPlan(p.testlinkProjectName, `${s.jiraKey} ${s.summary}`));
  for (const r of rows) await tl.addToPlan(tp.id, planId, r.tc.testlinkExternalId!);
  const tlBuildId = b.testlinkBuildId ?? (await tl.createBuild(planId, b.name));
  await db.update(builds).set({ testlinkPlanId: planId, testlinkBuildId: tlBuildId }).where(eq(builds.id, buildId));
  let sent = 0;
  for (const r of rows) {
    if (r.e.status === "not_run") continue;
    if (r.e.pushedAt && r.e.executedAt && r.e.pushedAt >= r.e.executedAt) continue;
    await tl.reportResult({
      planId,
      buildName: b.name,
      externalId: r.tc.testlinkExternalId!,
      status: TL_STATUS[r.e.status],
      notes: r.e.notes || (r.e.byAgent ? "Agent thực thi, QC đã duyệt" : ""),
      bugId: r.e.status === "failed" && r.e.linkedIssueKey && !r.e.linkedIssueKey.startsWith("LOCAL-") ? r.e.linkedIssueKey : undefined,
    });
    await db.update(executions).set({ pushedAt: new Date() }).where(eq(executions.id, r.e.id));
    sent++;
  }
  await audit(db, { userId, action: `Gửi ${sent} kết quả ${b.name} lên TestLink`, target: s.jiraKey });
  return sent;
}

/** Marks Blocked results whose blocking ticket is now closed, so QC knows to retest. */
export async function refreshBlockers(db: DB, jira: JiraClient, storyId: string, closedNames: string[]) {
  const rows = await db
    .select({ e: executions })
    .from(executions)
    .innerJoin(builds, eq(builds.id, executions.buildId))
    .where(and(eq(builds.storyId, storyId), eq(executions.status, "blocked"), eq(executions.blockerDone, false)));
  const closed = closedNames.map((n) => n.toLowerCase());
  let n = 0;
  for (const { e } of rows) {
    if (!e.linkedIssueKey || e.linkedIssueKey.startsWith("LOCAL-")) continue;
    try {
      const st = await jira.issueStatus(e.linkedIssueKey);
      if (closed.includes(st.toLowerCase())) {
        await db.update(executions).set({ blockerDone: true }).where(eq(executions.id, e.id));
        n++;
      }
    } catch {
      /* ticket may be in another project the bot cannot see */
    }
  }
  return n;
}

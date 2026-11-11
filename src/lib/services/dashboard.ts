import { and, desc, eq, gte, inArray } from "drizzle-orm";
import { Type } from "@google/genai";
import type { DB } from "../db";
import { aiAnswers, autoRuns, bugs, builds, executions, questions, sprints, stories, testCases, users, type Severity } from "../db/schema";
import type { AiClient } from "../integrations/gemini";
import { audit } from "../audit";
import { envScope, latestResults, ENV_LABEL } from "./execution";
import { STAGE_LABEL } from "../format";

const DAY = 86400_000;
const vnDay = (d: Date) => new Date(d.getTime() + 7 * 3600_000).toISOString().slice(0, 10);

export type Dashboard = Awaited<ReturnType<typeof projectDashboard>>;

export async function projectDashboard(db: DB, projectId: string, sprintId: string | null, now = new Date()) {
  const storyRows = await db
    .select()
    .from(stories)
    .where(sprintId ? and(eq(stories.projectId, projectId), eq(stories.sprintId, sprintId)) : eq(stories.projectId, projectId));
  const storyIds = storyRows.map((s) => s.id);
  const [sprint] = sprintId ? await db.select().from(sprints).where(eq(sprints.id, sprintId)) : [];
  const tcs = storyIds.length ? await db.select().from(testCases).where(inArray(testCases.storyId, storyIds)) : [];
  const approved = tcs.filter((t) => t.status === "approved");
  const bugRows = storyIds.length ? await db.select().from(bugs).where(inArray(bugs.storyId, storyIds)) : [];
  const live = bugRows.filter((b) => b.status !== "draft");
  const execRows = storyIds.length
    ? await db.select({ e: executions, b: builds }).from(executions).innerJoin(builds, eq(builds.id, executions.buildId)).where(inArray(builds.storyId, storyIds))
    : [];

  // Latest result per test case in each story's current environment.
  const perStory = [];
  const totals = { passed: 0, failed: 0, blocked: 0, notRun: 0, total: 0 };
  for (const s of storyRows) {
    const scope = envScope(tcs.filter((t) => t.storyId === s.id), s.currentEnv);
    const latest = await latestResults(db, s.id, s.currentEnv);
    const c = { passed: 0, failed: 0, blocked: 0, notRun: 0, total: scope.length };
    for (const t of scope) {
      const st = latest.get(t.id)?.status ?? "not_run";
      if (st === "passed") c.passed++;
      else if (st === "failed") c.failed++;
      else if (st === "blocked") c.blocked++;
      else c.notRun++;
    }
    for (const k of ["passed", "failed", "blocked", "notRun", "total"] as const) totals[k] += c[k];
    const open = live.filter((b) => b.storyId === s.id && b.status !== "closed");
    const sev = (x: Severity) => open.filter((b) => b.severity === x).length;
    const qOpen = (await db.select({ id: questions.id }).from(questions).where(and(eq(questions.storyId, s.id), inArray(questions.status, ["open", "draft"])))).length;
    const rate = c.total ? Math.round((c.passed / c.total) * 100) : 0;
    const score = sev("critical") * 5 + sev("major") * 3 + sev("minor") + c.blocked * 2 + (c.total ? (100 - rate) / 10 : 3) + qOpen;
    const reasons = [
      sev("critical") ? `${sev("critical")} bug Critical` : "",
      sev("major") ? `${sev("major")} bug Major` : "",
      c.blocked ? `${c.blocked} TC Blocked` : "",
      c.total && rate < 80 ? `pass rate ${rate}%` : "",
      !c.total ? "chưa có test case" : "",
      qOpen ? `${qOpen} câu hỏi chưa trả lời` : "",
    ].filter(Boolean);
    perStory.push({ id: s.id, key: s.jiraKey, summary: s.summary, stage: s.qaStage, env: s.currentEnv, qcOwnerId: s.qcOwnerId, counts: c, rate, openBugs: open.length, qOpen, score, reasons });
  }

  // Daily results, last 14 days (all builds, by execution time).
  const since = new Date(now.getTime() - 13 * DAY);
  const days = Array.from({ length: 14 }, (_, i) => vnDay(new Date(since.getTime() + i * DAY)));
  const trend = days.map((d) => ({ day: d, passed: 0, blocked: 0, failed: 0 }));
  for (const { e } of execRows) {
    if (!e.executedAt || e.executedAt < since) continue;
    const t = trend.find((x) => x.day === vnDay(e.executedAt!));
    if (t && e.status !== "not_run") t[e.status]++;
  }

  // Burn-up across the sprint: test cases that have passed at least once (normal rounds) by each day.
  const start = sprint?.startDate ?? new Date(now.getTime() - 13 * DAY);
  const end = sprint?.endDate ?? now;
  const firstPass = new Map<string, Date>();
  for (const { e, b } of execRows) {
    if (b.kind !== "round" || e.status !== "passed" || !e.executedAt) continue;
    const prev = firstPass.get(e.testCaseId);
    if (!prev || e.executedAt < prev) firstPass.set(e.testCaseId, e.executedAt);
  }
  const burnDays: { day: string; done: number | null }[] = [];
  for (let t = start.getTime(); t <= end.getTime() + 1; t += DAY) {
    const day = vnDay(new Date(t));
    const future = day > vnDay(now);
    burnDays.push({ day, done: future ? null : [...firstPass.values()].filter((d) => vnDay(d) <= day).length });
  }

  // Bugs.
  const sevs: Severity[] = ["critical", "major", "minor"];
  const bugMatrix = sevs.map((sv) => ({
    severity: sv,
    open: live.filter((b) => b.severity === sv && (b.status === "open" || b.status === "in_progress")).length,
    resolved: live.filter((b) => b.severity === sv && b.status === "resolved").length,
    closed: live.filter((b) => b.severity === sv && b.status === "closed").length,
  }));
  const hours = (xs: number[]) => (xs.length ? Math.round(xs.reduce((a, z) => a + z, 0) / xs.length / 3600_000) : null);
  const fixHours = hours(live.filter((b) => b.resolvedAt).map((b) => b.resolvedAt!.getTime() - b.createdAt.getTime()));
  const verifyHours = hours(live.filter((b) => b.resolvedAt && b.closedAt).map((b) => b.closedAt!.getTime() - b.resolvedAt!.getTime()));

  // Automation share and workload (last 14 days).
  const recent = execRows.filter(({ e }) => e.executedAt && e.executedAt >= since && e.status !== "not_run");
  const autoShare = recent.length ? Math.round((recent.filter(({ e }) => e.byAgent).length / recent.length) * 100) : 0;
  const people = await db.select({ id: users.id, name: users.name }).from(users);
  const nameOf = new Map(people.map((p) => [p.id, p.name]));
  const work = new Map<string, { manual: number; auto: number; bugs: number; verified: number }>();
  const w = (id: string) => {
    if (!work.has(id)) work.set(id, { manual: 0, auto: 0, bugs: 0, verified: 0 });
    return work.get(id)!;
  };
  for (const { e } of recent) if (e.executedBy) w(e.executedBy)[e.byAgent ? "auto" : "manual"]++;
  for (const b of live) {
    if (b.createdBy && b.createdAt >= since) w(b.createdBy).bugs++;
    if (b.closedBy && b.closedAt && b.closedAt >= since) w(b.closedBy).verified++;
  }
  const workload = [...work.entries()].map(([id, v]) => ({ name: nameOf.get(id) ?? "—", ...v })).sort((a, z) => z.manual + z.auto - (a.manual + a.auto));

  const runs = storyIds.length
    ? await db
        .select({ r: autoRuns, b: builds })
        .from(autoRuns)
        .innerJoin(builds, eq(builds.id, autoRuns.buildId))
        .where(and(inArray(builds.storyId, storyIds), gte(autoRuns.startedAt, since)))
        .orderBy(desc(autoRuns.startedAt))
    : [];

  const stageCounts = (Object.keys(STAGE_LABEL) as (keyof typeof STAGE_LABEL)[]).map((st) => ({
    stage: st,
    label: STAGE_LABEL[st],
    count: storyRows.filter((s) => s.qaStage === st).length,
  }));
  const envCounts = (["dev", "stg", "prod"] as const).map((env) => ({ env, label: ENV_LABEL[env], count: storyRows.filter((s) => s.qaStage === "testing" && s.currentEnv === env).length }));

  return {
    sprint: sprint ?? null,
    kpi: {
      stories: storyRows.length,
      tcApproved: approved.length,
      tcDraft: tcs.filter((t) => t.status === "draft").length,
      passRate: totals.total ? Math.round((totals.passed / totals.total) * 100) : 0,
      totals,
      openBugs: live.filter((b) => b.status !== "closed").length,
      openCritical: live.filter((b) => b.status !== "closed" && b.severity === "critical").length,
      verifyQueue: live.filter((b) => b.status === "resolved").length,
      fixHours,
      verifyHours,
      autoShare,
      runs: runs.length,
    },
    trend,
    burn: { scope: approved.length, days: burnDays },
    bugMatrix,
    stageCounts,
    envCounts,
    workload,
    risky: perStory
      .filter((p) => p.reasons.length)
      .sort((a, z) => z.score - a.score)
      .slice(0, 6),
    perStory,
  };
}

/** Plain-language answer about the project's current state, grounded only in the computed numbers. */
export async function askProject(db: DB, ai: AiClient, projectId: string, sprintId: string | null, userId: string, question: string) {
  const q = question.trim();
  if (q.length < 4) throw new Error("Hãy nhập câu hỏi cụ thể hơn.");
  const d = await projectDashboard(db, projectId, sprintId);
  const storyIds = d.perStory.map((s) => s.id);
  const openBugs = storyIds.length ? await db.select().from(bugs).where(and(inArray(bugs.storyId, storyIds), inArray(bugs.status, ["open", "in_progress", "resolved"]))) : [];
  const keyOf = new Map(d.perStory.map((s) => [s.id, s.key]));
  const snapshot = {
    sprint: d.sprint ? { name: d.sprint.name, start: d.sprint.startDate, end: d.sprint.endDate } : null,
    kpi: d.kpi,
    stories: d.perStory.map((s) => ({ key: s.key, summary: s.summary, stage: s.stage, env: s.env, results: s.counts, passRate: s.rate, openBugs: s.openBugs, openQuestions: s.qOpen, risk: s.reasons })),
    openBugs: openBugs.map((b) => ({ story: keyOf.get(b.storyId), title: b.title, severity: b.severity, status: b.status, env: b.env })),
    trend14d: d.trend,
    bugsBySeverity: d.bugMatrix,
    workload: d.workload,
  };
  const r = await ai.generateJson<{ answer: string }>({
    system:
      "Bạn là trợ lý QC Lead. Trả lời câu hỏi về tình hình test của dự án bằng tiếng Việt, ngắn gọn (tối đa 8 câu hoặc gạch đầu dòng), không dùng markdown đậm/nghiêng. " +
      "Chỉ dựa vào dữ liệu JSON được cung cấp; nếu dữ liệu không đủ để trả lời thì nói rõ là không đủ. Nêu mã story/bug cụ thể khi có.",
    prompt: "Dữ liệu dự án (JSON):\n" + JSON.stringify(snapshot) + "\n\nCâu hỏi: " + q,
    schema: { type: Type.OBJECT, properties: { answer: { type: Type.STRING } }, required: ["answer"] },
  });
  await db.insert(aiAnswers).values({ userId, projectId, question: q.slice(0, 500), answer: (r.answer ?? "").slice(0, 4000) });
  await audit(db, { userId, action: "Hỏi AI về dữ liệu dự án", detail: { message: q.slice(0, 200) } });
}

export async function recentAnswers(db: DB, projectId: string, userId: string, limit = 4) {
  return db
    .select()
    .from(aiAnswers)
    .where(and(eq(aiAnswers.projectId, projectId), eq(aiAnswers.userId, userId)))
    .orderBy(desc(aiAnswers.createdAt))
    .limit(limit);
}

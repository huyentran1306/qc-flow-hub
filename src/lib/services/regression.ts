import { and, asc, desc, eq, inArray, max } from "drizzle-orm";
import type { DB } from "../db";
import { autoRuns, builds, executions, projects, regressionSuites, stories, suiteCases, suiteRuns, testCases, type Env, type SuiteSchedule } from "../db/schema";
import type { AiClient } from "../integrations/gemini";
import { audit } from "../audit";
import { holdSlot, isBusy, prepareRun, processRun, releaseSlot, type RunCounts } from "../autorun/runner";
import { notify } from "./notify";
import { notifyUsers, projectMemberIds } from "./notifications";
import { ENV_LABEL } from "./execution";

const VN_OFFSET_MS = 7 * 3600_000; // Asia/Ho_Chi_Minh, no DST

/** Next run time after `from` for a schedule, evaluated in Vietnam time. */
export function nextRunAt(schedule: SuiteSchedule, from = new Date()): Date | null {
  if (schedule.mode === "off") return null;
  const [h, m] = schedule.time.split(":").map(Number);
  if (!Number.isInteger(h) || !Number.isInteger(m) || h < 0 || h > 23 || m < 0 || m > 59) return null;
  const local = new Date(from.getTime() + VN_OFFSET_MS); // fields of this Date (UTC getters) = Vietnam wall clock
  for (let add = 0; add < 8; add++) {
    const cand = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + add, h, m) - VN_OFFSET_MS;
    const day = new Date(cand + VN_OFFSET_MS).getUTCDay();
    if (cand <= from.getTime()) continue;
    if (schedule.mode === "weekdays" && (day === 0 || day === 6)) continue;
    return new Date(cand);
  }
  return null;
}

export function parseSchedule(fd: FormData): SuiteSchedule {
  const mode = String(fd.get("mode") ?? "off");
  const time = String(fd.get("time") ?? "02:00").trim();
  if (!/^\d{2}:\d{2}$/.test(time)) throw new Error("Giờ chạy dạng HH:MM, ví dụ 02:00.");
  return { mode: mode === "daily" || mode === "weekdays" ? mode : "off", time };
}

export async function createSuite(db: DB, userId: string, projectId: string, input: { name: string; env: Env; description: string }) {
  if (!input.name.trim()) throw new Error("Đặt tên cho bộ regression.");
  const [s] = await db.insert(regressionSuites).values({ projectId, name: input.name.trim(), env: input.env, description: input.description.trim(), createdBy: userId }).returning();
  await audit(db, { userId, action: "Tạo bộ regression", target: s.name });
  return s.id;
}

export async function updateSuite(db: DB, userId: string, suiteId: string, input: { name: string; env: Env; description: string; schedule: SuiteSchedule }) {
  if (!input.name.trim()) throw new Error("Đặt tên cho bộ regression.");
  await db
    .update(regressionSuites)
    .set({ name: input.name.trim(), env: input.env, description: input.description.trim(), schedule: input.schedule, nextRunAt: nextRunAt(input.schedule) })
    .where(eq(regressionSuites.id, suiteId));
  await audit(db, { userId, action: "Sửa bộ regression", target: input.name, detail: input.schedule as unknown as Record<string, unknown> });
}

export async function setSuiteCases(db: DB, userId: string, suiteId: string, tcIds: string[]) {
  const [suite] = await db.select().from(regressionSuites).where(eq(regressionSuites.id, suiteId));
  const valid = tcIds.length
    ? await db
        .select({ id: testCases.id })
        .from(testCases)
        .innerJoin(stories, eq(stories.id, testCases.storyId))
        .where(and(inArray(testCases.id, tcIds), eq(stories.projectId, suite.projectId), eq(testCases.status, "approved")))
    : [];
  await db.delete(suiteCases).where(eq(suiteCases.suiteId, suiteId));
  if (valid.length) await db.insert(suiteCases).values(valid.map((v) => ({ suiteId, testCaseId: v.id })));
  await audit(db, { userId, action: `Chọn ${valid.length} test case cho bộ regression`, target: suite.name });
  return valid.length;
}

export async function deleteSuite(db: DB, userId: string, suiteId: string) {
  const [s] = await db.delete(regressionSuites).where(eq(regressionSuites.id, suiteId)).returning();
  if (s) await audit(db, { userId, action: "Xoá bộ regression", target: s.name });
}

export async function suiteRows(db: DB, projectId: string) {
  const suites = await db.select().from(regressionSuites).where(eq(regressionSuites.projectId, projectId)).orderBy(asc(regressionSuites.name));
  const out = [];
  for (const s of suites) {
    const cases = await db.select({ id: suiteCases.testCaseId }).from(suiteCases).where(eq(suiteCases.suiteId, s.id));
    const [last] = await db.select().from(suiteRuns).where(eq(suiteRuns.suiteId, s.id)).orderBy(desc(suiteRuns.startedAt)).limit(1);
    out.push({ suite: s, caseIds: cases.map((c) => c.id), last: last ?? null });
  }
  return out;
}

/** Creates one regression build per story in the suite and runs them one after another in the background. */
export async function startSuiteRun(db: DB, ai: AiClient, suiteId: string, o: { userId: string; trigger: "manual" | "schedule"; origin: string }) {
  if (isBusy()) throw new Error("Đang có một lượt chạy tự động khác. Chờ xong rồi chạy bộ regression.");
  const [suite] = await db.select().from(regressionSuites).where(eq(regressionSuites.id, suiteId));
  if (!suite) throw new Error("Không tìm thấy bộ regression.");
  const [project] = await db.select().from(projects).where(eq(projects.id, suite.projectId));
  if (!project.envUrls[suite.env]) throw new Error(`Dự án chưa có URL môi trường ${ENV_LABEL[suite.env]}.`);
  const cases = await db
    .select({ tc: testCases })
    .from(suiteCases)
    .innerJoin(testCases, eq(testCases.id, suiteCases.testCaseId))
    .where(and(eq(suiteCases.suiteId, suiteId), eq(testCases.status, "approved")))
    .orderBy(asc(testCases.storyId), asc(testCases.seq));
  if (!cases.length) throw new Error("Bộ regression chưa có test case nào.");
  const byStory = new Map<string, (typeof testCases.$inferSelect)[]>();
  for (const { tc } of cases) byStory.set(tc.storyId, [...(byStory.get(tc.storyId) ?? []), tc]);
  const buildIds: string[] = [];
  for (const [storyId, tcs] of byStory) {
    const [{ m }] = await db.select({ m: max(builds.round) }).from(builds).where(and(eq(builds.storyId, storyId), eq(builds.env, suite.env), eq(builds.kind, "regression")));
    const round = Number(m ?? 0) + 1;
    const [b] = await db
      .insert(builds)
      .values({ storyId, env: suite.env, kind: "regression", round, name: `REG-${round} ${suite.name}`.slice(0, 60), createdBy: o.userId })
      .returning();
    await db.insert(executions).values(tcs.map((t) => ({ buildId: b.id, testCaseId: t.id })));
    buildIds.push(b.id);
  }
  const [run] = await db.insert(suiteRuns).values({ suiteId, trigger: o.trigger, buildIds, total: cases.length, startedBy: o.userId, status: "running" }).returning();
  holdSlot(run.id);
  await audit(db, { userId: o.userId, action: `Chạy bộ regression (${o.trigger === "schedule" ? "theo lịch" : "thủ công"}): ${cases.length} TC`, target: suite.name, source: o.trigger === "schedule" ? "system" : "ui" });
  void (async () => {
    const total: RunCounts = { done: 0, passed: 0, failed: 0, blocked: 0 };
    try {
      for (const buildId of buildIds) {
        const [cur] = await db.select({ status: suiteRuns.status }).from(suiteRuns).where(eq(suiteRuns.id, run.id));
        if (cur?.status === "cancelled") break;
        const ids = (await db.select({ id: executions.id }).from(executions).where(eq(executions.buildId, buildId))).map((x) => x.id);
        const prep = await prepareRun(db, { buildId, userId: o.userId, headed: false, rerun: true, origin: o.origin, onlyIds: ids, suiteRunId: run.id, silent: true });
        const c = await processRun(db, ai, prep.runId, prep.targets, prep.ctx);
        for (const k of ["done", "passed", "failed", "blocked"] as const) total[k] += c[k];
        await db.update(suiteRuns).set({ passed: total.passed, failed: total.failed, blocked: total.blocked }).where(eq(suiteRuns.id, run.id));
      }
      const [cur] = await db.select({ status: suiteRuns.status }).from(suiteRuns).where(eq(suiteRuns.id, run.id));
      if (cur?.status !== "cancelled") await db.update(suiteRuns).set({ status: "done", finishedAt: new Date() }).where(eq(suiteRuns.id, run.id));
      const bad = total.failed + total.blocked;
      const title = `${bad ? "⚠️" : "✅"} Regression “${suite.name}” (${ENV_LABEL[suite.env]}): ${total.passed}/${total.done} passed${bad ? `, ${total.failed} failed, ${total.blocked} blocked` : ""}`;
      await notify(db, title);
      await notifyUsers(db, [suite.createdBy, ...(await projectMemberIds(db, suite.projectId, ["lead", "qc"]))], { kind: "regression", title, body: bad ? "Mở bộ regression để xem test case lỗi." : null, link: `/regression#s-${suite.id}` });
    } catch (e) {
      await db.update(suiteRuns).set({ status: "failed", error: (e as Error).message, finishedAt: new Date() }).where(eq(suiteRuns.id, run.id));
      await notifyUsers(db, [suite.createdBy], { kind: "regression", title: `Bộ regression “${suite.name}” chạy lỗi`, body: (e as Error).message, link: "/regression" });
    } finally {
      releaseSlot(run.id);
    }
  })();
  return run.id;
}

export async function cancelSuiteRun(db: DB, userId: string, runId: string) {
  await db.update(suiteRuns).set({ status: "cancelled", finishedAt: new Date() }).where(eq(suiteRuns.id, runId));
  await db.update(autoRuns).set({ status: "cancelled", finishedAt: new Date() }).where(and(eq(autoRuns.suiteRunId, runId), inArray(autoRuns.status, ["queued", "running"])));
  await audit(db, { userId, action: "Huỷ lượt chạy regression" });
}

/** Results of a suite run: every execution across its builds. */
export async function suiteRunResults(db: DB, buildIds: string[]) {
  if (!buildIds.length) return [];
  return db
    .select({ e: executions, tc: testCases, b: builds, s: stories })
    .from(executions)
    .innerJoin(testCases, eq(testCases.id, executions.testCaseId))
    .innerJoin(builds, eq(builds.id, executions.buildId))
    .innerJoin(stories, eq(stories.id, builds.storyId))
    .where(inArray(executions.buildId, buildIds))
    .orderBy(asc(stories.jiraKey), asc(testCases.seq));
}

/** Called every minute: starts suites whose scheduled time has come. */
export async function runDueSuites(db: DB, loadAi: () => Promise<AiClient | null>, origin: string, now = new Date()) {
  const due = (await db.select().from(regressionSuites)).filter((s) => s.schedule.mode !== "off" && s.nextRunAt && s.nextRunAt <= now);
  const started: string[] = [];
  for (const s of due) {
    if (isBusy()) break; // try again next minute
    await db.update(regressionSuites).set({ nextRunAt: nextRunAt(s.schedule, now) }).where(eq(regressionSuites.id, s.id));
    const ai = await loadAi();
    if (!ai || !s.createdBy) {
      await notifyUsers(db, [s.createdBy], { kind: "regression", title: `Không chạy được bộ “${s.name}” theo lịch: chưa kết nối Gemini`, link: "/admin/connections" });
      continue;
    }
    try {
      await startSuiteRun(db, ai, s.id, { userId: s.createdBy, trigger: "schedule", origin });
      started.push(s.id);
    } catch (e) {
      await notifyUsers(db, [s.createdBy], { kind: "regression", title: `Bộ “${s.name}” không chạy được theo lịch`, body: (e as Error).message, link: "/regression" });
    }
  }
  return started;
}

export async function sweepInterruptedSuites(db: DB) {
  const rows = await db.select().from(suiteRuns).where(inArray(suiteRuns.status, ["queued", "running"]));
  for (const r of rows) if (!isBusy()) await db.update(suiteRuns).set({ status: "failed", error: "Bị gián đoạn (tool đã khởi động lại)", finishedAt: new Date() }).where(eq(suiteRuns.id, r.id));
}

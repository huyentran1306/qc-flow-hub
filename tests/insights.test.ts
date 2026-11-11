import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { and, eq } from "drizzle-orm";
import { openDb, type DB } from "@/lib/db";
import { aiAnswers, builds, bugs, notifications, projects, regressionSuites, stories, suiteRuns, testCases } from "@/lib/db/schema";
import { createFirstAdmin, createUser, setMembership } from "@/lib/services/users";
import { seedDemo } from "@/lib/services/demo";
import { projectDashboard, askProject } from "@/lib/services/dashboard";
import { currentSprint } from "@/lib/services/stories";
import { applyJiraStatus, createDraftBug } from "@/lib/services/bugs";
import { markAllRead, unreadCount } from "@/lib/services/notifications";
import { nextRunAt, runDueSuites, startSuiteRun, suiteRunResults } from "@/lib/services/regression";
import { latestResults } from "@/lib/services/execution";
import { similarity, similarBugs } from "@/lib/services/similar";
import { acMatrix, parseAcs, addCoverageSuggestions, aiCoverage } from "@/lib/services/coverage";
import { toCsv } from "@/lib/csv";
import { demoHtml, handleDemoApi } from "@/lib/demoApp";
import type { AiClient } from "@/lib/integrations/gemini";

process.env.UPLOAD_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "qfh-ins-"));

let db: DB;
let admin: string;
let qc: string;
let server: http.Server;
let origin = "";

beforeAll(async () => {
  db = await openDb({ memory: true });
  admin = await createFirstAdmin(db, { email: "a@x.vn", name: "Admin", password: "password123" });
  qc = await createUser(db, admin, { email: "qc@x.vn", name: "Ngọc", password: "password123", isAdmin: false });
  await seedDemo(db, admin);
  const [p] = await db.select().from(projects).where(eq(projects.key, "DEMO"));
  await setMembership(db, admin, qc, p.id, "qc");
  server = http.createServer((req, res) => {
    const url = new URL(req.url!, "http://x");
    if (url.pathname === "/demo-app") return res.end(demoHtml());
    const r = handleDemoApi(req.method!, url.pathname.replace("/demo-app/api/", "").split("/"), url.searchParams);
    res.statusCode = r.status;
    res.end(r.status === 204 ? undefined : JSON.stringify(r.body));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());

const fixed = <T,>(v: T): AiClient => ({ model: "fixed", generateJson: async <R,>() => v as unknown as R });

describe("pure helpers", () => {
  it("schedules in Vietnam time", () => {
    // 2026-11-13 is a Friday. 20:00 UTC = 03:00 Saturday in Vietnam.
    const fri20utc = new Date("2026-11-13T20:00:00Z");
    expect(nextRunAt({ mode: "daily", time: "02:00" }, fri20utc)?.toISOString()).toBe("2026-11-14T19:00:00.000Z"); // Sun 02:00 VN
    expect(nextRunAt({ mode: "weekdays", time: "02:00" }, fri20utc)?.toISOString()).toBe("2026-11-15T19:00:00.000Z"); // Mon 02:00 VN
    expect(nextRunAt({ mode: "daily", time: "23:30" }, new Date("2026-11-13T10:00:00Z"))?.toISOString()).toBe("2026-11-13T16:30:00.000Z");
    expect(nextRunAt({ mode: "off", time: "02:00" })).toBeNull();
  });
  it("scores similar bug titles regardless of accents", () => {
    expect(similarity("Tìm kiếm phân biệt hoa thường", "tim kiem phan biet hoa thuong o trang Map deck")).toBeGreaterThan(0.5);
    expect(similarity("Nút xoá không hiện", "Sai định dạng ngày")).toBe(0);
  });
  it("reads acceptance criteria and maps them to test cases", () => {
    expect(parseAcs("Mô tả\n- AC-1: Hiện 4 cột\n- AC 2. Phân trang\nKhác")).toEqual([
      { code: "AC-1", text: "Hiện 4 cột" },
      { code: "AC-2", text: "Phân trang" },
    ]);
    const m = acMatrix("- AC-1: A\n- AC-2: B", [
      { seq: 1, requirementRef: "AC-1, AC-2", status: "approved" },
      { seq: 2, requirementRef: "AC-2", status: "draft" },
    ]);
    expect(m.map((x) => [x.code, x.tcs])).toEqual([
      ["AC-1", ["TC-01"]],
      ["AC-2", ["TC-01"]],
    ]);
  });
  it("writes Excel-safe CSV", () => {
    const csv = toCsv([["Tên", "Ghi chú"], ["a,b", '=HYPERLINK("x")'], [1, null]]);
    expect(csv.startsWith("﻿")).toBe(true);
    expect(csv).toContain('"a,b"');
    expect(csv).toContain(`"'=HYPERLINK(""x"")"`);
    expect(csv).toContain("1,\r\n");
  });
});

describe("dashboard, notifications, AI helpers", () => {
  it("computes the demo dashboard", async () => {
    const [p] = await db.select().from(projects).where(eq(projects.key, "DEMO"));
    const sp = await currentSprint(db, p.id);
    const d = await projectDashboard(db, p.id, sp!.id);
    expect(d.kpi.stories).toBe(3);
    expect(d.kpi.tcApproved).toBe(14);
    expect(d.kpi.totals).toMatchObject({ passed: 7, failed: 2, blocked: 2, notRun: 3, total: 14 });
    expect(d.kpi.passRate).toBe(50);
    expect(d.kpi.verifyQueue).toBe(1);
    expect(d.kpi.fixHours).toBe(48);
    expect(d.trend).toHaveLength(14);
    expect(d.trend.reduce((a, t) => a + t.passed + t.failed + t.blocked, 0)).toBe(11);
    expect(d.trend.filter((t) => t.passed + t.failed + t.blocked > 0).length).toBeGreaterThanOrEqual(4);
    expect(d.burn.scope).toBe(14);
    expect(d.risky[0].key).toBe("DEMO-110859");
    expect(d.workload[0]).toMatchObject({ name: "Admin", manual: 11 });
  });

  it("notifies QC members when a bug becomes Resolved", async () => {
    const [s] = await db.select().from(stories).where(eq(stories.jiraKey, "DEMO-110859"));
    const id = await createDraftBug(db, admin, { storyId: s.id, fields: { title: "Lỗi thử", steps: "", actual: "", expected: "", severity: "minor", env: "dev" }, source: "manual" });
    await db.update(bugs).set({ status: "open", jiraKey: "DEMO-999" }).where(eq(bugs.id, id));
    expect(await unreadCount(db, qc)).toBe(0);
    await applyJiraStatus(db, "DEMO-999", "Ready for QC");
    expect(await unreadCount(db, qc)).toBe(1);
    const [n] = await db.select().from(notifications).where(eq(notifications.userId, qc));
    expect(n).toMatchObject({ kind: "bug_resolved", title: "DEMO-999 chờ QC verify" });
    expect((await db.select().from(bugs).where(eq(bugs.id, id)))[0].resolvedAt).not.toBeNull();
    await markAllRead(db, qc);
    expect(await unreadCount(db, qc)).toBe(0);
  });

  it("flags likely duplicate bugs within the project", async () => {
    const [s] = await db.select().from(stories).where(eq(stories.jiraKey, "DEMO-110930"));
    const id = await createDraftBug(db, qc, { storyId: s.id, fields: { title: "[MapDeck][US1] Tìm kiếm Map deck phân biệt hoa thường", steps: "", actual: "Không có kết quả", expected: "", severity: "major", env: "dev" }, source: "manual" });
    const d = await similarBugs(db, id);
    expect(d[0].title).toBe("[MapDeck][US1] Tìm kiếm phân biệt hoa thường");
    expect(d[0].score).toBeGreaterThan(0.5);
  });

  it("stores AI coverage and turns suggestions into drafts", async () => {
    const [s] = await db.select().from(stories).where(eq(stories.jiraKey, "DEMO-110859"));
    const ai = fixed({
      items: [{ requirement: "AC-7 xoá nhiều", coveredBy: ["TC-10"], status: "partial", note: "Thiếu giới hạn số lượng" }],
      suggestions: [{ us: "US2", title: "Xoá 101 Map deck cùng lúc", type: "edge", priority: "medium", steps: [{ action: "Chọn 101 deck", expected: "Báo vượt giới hạn" }] }],
    });
    const c = await aiCoverage(db, ai, s.id, qc);
    expect(c.items[0].status).toBe("partial");
    const before = (await db.select().from(testCases).where(eq(testCases.storyId, s.id))).length;
    expect(await addCoverageSuggestions(db, s.id, qc)).toBe(1);
    const after = await db.select().from(testCases).where(eq(testCases.storyId, s.id));
    expect(after.length).toBe(before + 1);
    expect(after.find((t) => t.title === "Xoá 101 Map deck cùng lúc")).toMatchObject({ status: "draft", kind: "ui", seq: before + 1 });
  });

  it("answers questions from a data snapshot and keeps the history", async () => {
    const [p] = await db.select().from(projects).where(eq(projects.key, "DEMO"));
    let prompt = "";
    const ai: AiClient = { model: "x", generateJson: async <R,>(o: { prompt: string }) => ((prompt = o.prompt), { answer: "DEMO-110859 rủi ro nhất." } as unknown as R) };
    await askProject(db, ai, p.id, null, qc, "Story nào rủi ro nhất?");
    expect(prompt).toContain('"key":"DEMO-110859"');
    expect(prompt).toContain("Câu hỏi: Story nào rủi ro nhất?");
    const [a] = await db.select().from(aiAnswers);
    expect(a.answer).toBe("DEMO-110859 rủi ro nhất.");
  });
});

describe("regression suites", () => {
  it("runs a suite across stories as regression builds without touching story rounds", async () => {
    const [p] = await db.select().from(projects).where(eq(projects.key, "DEMO"));
    const [suite] = await db.select().from(regressionSuites).where(eq(regressionSuites.projectId, p.id));
    expect(suite.name).toBe("Smoke DEMO");
    const [s] = await db.select().from(stories).where(eq(stories.jiraKey, "DEMO-110859"));
    const before = await latestResults(db, s.id, "dev");
    const ai: AiClient = { model: "x", generateJson: async <R,>() => ({ action: "finish", verdict: "passed", note: "ok", observation: "Đúng mong đợi" }) as unknown as R };
    const runId = await startSuiteRun(db, ai, suite.id, { userId: admin, trigger: "manual", origin });
    let run;
    for (let i = 0; i < 120; i++) {
      [run] = await db.select().from(suiteRuns).where(eq(suiteRuns.id, runId));
      if (run.status !== "running") break;
      await new Promise((r) => setTimeout(r, 400));
    }
    expect(run).toMatchObject({ status: "done", passed: run!.total, failed: 0 });
    const regBuilds = await db.select().from(builds).where(and(eq(builds.storyId, s.id), eq(builds.kind, "regression")));
    expect(regBuilds[0].name).toBe("REG-1 Smoke DEMO");
    expect((await suiteRunResults(db, run!.buildIds)).every((r) => r.e.status === "passed" && r.e.agentSource === "auto")).toBe(true);
    // The story's own DEV results are unchanged by the regression run.
    const after = await latestResults(db, s.id, "dev");
    expect([...after.values()].map((x) => x.status)).toEqual([...before.values()].map((x) => x.status));
    const notes = await db.select().from(notifications).where(eq(notifications.kind, "regression"));
    expect(notes.length).toBeGreaterThan(0);
  }, 90_000);

  it("starts due suites from the scheduler and moves the next run forward", async () => {
    const [suite] = await db.select().from(regressionSuites);
    await db.update(regressionSuites).set({ schedule: { mode: "daily", time: "02:00" }, nextRunAt: new Date(Date.now() - 60_000) }).where(eq(regressionSuites.id, suite.id));
    const started = await runDueSuites(db, async () => null, origin);
    expect(started).toEqual([]); // no AI configured → skipped with a notification, schedule advanced
    const [after] = await db.select().from(regressionSuites).where(eq(regressionSuites.id, suite.id));
    expect(after.nextRunAt!.getTime()).toBeGreaterThan(Date.now());
    const [n] = await db.select().from(notifications).where(and(eq(notifications.userId, admin), eq(notifications.kind, "regression")));
    expect(n).toBeTruthy();
  });
});

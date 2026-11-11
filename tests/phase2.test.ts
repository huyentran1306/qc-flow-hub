import { beforeAll, describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { openDb, type DB } from "@/lib/db";
import { bugs, builds, executions, projects, reports, stories, testCases } from "@/lib/db/schema";
import { createFirstAdmin, createUser, setMembership } from "@/lib/services/users";
import { createProject } from "@/lib/services/projects";
import { seedDemo } from "@/lib/services/demo";
import { boardStories, currentSprint } from "@/lib/services/stories";
import { createNextBuild, latestResults, setExecution, buildRows, buildProblems, pushBuildToTestlink } from "@/lib/services/execution";
import { addEvidence, applyJiraStatus, createDraftBug, publishBug, verifyAndClose, addFixCommit, mapJiraStatus } from "@/lib/services/bugs";
import { computeCounts, generateReport, postReport } from "@/lib/services/reports";
import { advanceStory, evaluateGate } from "@/lib/services/gates";
import { authenticateMcp, createMcpToken, revokeMcpToken, listMcpTokens } from "@/lib/services/mcpTokens";
import { runTool, toolList } from "@/lib/agent/tools";
import { commitsFromPush, issueKeysIn, verifyGitWebhook } from "@/lib/integrations/git";
import type { JiraClient } from "@/lib/integrations/jira";
import type { TestLinkClient } from "@/lib/integrations/testlink";

process.env.UPLOAD_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "qfh-up-"));

let db: DB;
let admin: string;
let qc: string;
let dev: string;
let storyId: string;

const png = () => new File([new Uint8Array([137, 80, 78, 71])], "loi.png", { type: "image/png" });

function fakeJira() {
  const calls: { op: string; args: unknown[] }[] = [];
  const j = {
    calls,
    createIssue: async (i: unknown) => (calls.push({ op: "create", args: [i] }), "OP-900"),
    attachFile: async (...a: unknown[]) => void calls.push({ op: "attach", args: a }),
    addComment: async (...a: unknown[]) => (calls.push({ op: "comment", args: a }), "1"),
    transitionTo: async (...a: unknown[]) => (calls.push({ op: "transition", args: a }), "Closed"),
    issueStatus: async () => "Done",
  };
  return j as unknown as JiraClient & { calls: typeof calls };
}

beforeAll(async () => {
  db = await openDb({ memory: true });
  admin = await createFirstAdmin(db, { email: "admin@x.vn", name: "Admin", password: "password123" });
  qc = await createUser(db, admin, { email: "qc@x.vn", name: "QC", password: "password123", isAdmin: false });
  dev = await createUser(db, admin, { email: "dev@x.vn", name: "Dev", password: "password123", isAdmin: false });
  await seedDemo(db, qc); // qc becomes lead of DEMO
  const pid = await createProject(db, admin, { key: "OP", name: "OP", jiraBoardId: 1, testlinkProjectName: "OP TL", mapping: { storyIssueType: "Story", subBugIssueType: "Sub-bug", qcSubtaskLabel: "QC", severityField: "customfield_1" } });
  await setMembership(db, admin, qc, pid, "qc");
  await setMembership(db, admin, dev, pid, "dev");
  // Real (non-demo) story with 3 approved TCs, 1 of them happy.
  const [s] = await db.insert(stories).values({ projectId: pid, jiraKey: "OP-1", summary: "[MapDeck] Management" }).returning();
  storyId = s.id;
  await db.insert(testCases).values([
    { storyId, seq: 1, usCode: "US1", title: "Xem danh sách", type: "happy", priority: "high", steps: [{ action: "Mở", expected: "Thấy" }], source: "ai", status: "approved", testlinkExternalId: "OPTC-1" },
    { storyId, seq: 2, usCode: "US1", title: "Không có quyền", type: "negative", priority: "high", steps: [{ action: "Mở", expected: "403" }], source: "ai", status: "approved", testlinkExternalId: "OPTC-2" },
    { storyId, seq: 3, usCode: "US2", title: "Xoá", type: "edge", priority: "low", steps: [{ action: "Xoá", expected: "Hỏi lại" }], source: "ai", status: "approved", testlinkExternalId: "OPTC-3" },
    { storyId, seq: 4, usCode: "US2", title: "Nháp chưa duyệt", type: "happy", priority: "low", steps: [{ action: "a", expected: "b" }], source: "ai", status: "draft" },
  ]);
});

describe("demo seed", () => {
  it("ships a realistic DEV round", async () => {
    const [s] = await db.select().from(stories).where(eq(stories.jiraKey, "DEMO-110859"));
    const latest = await latestResults(db, s.id, "dev");
    const st = [...latest.values()].map((x) => x.status);
    expect(st.filter((x) => x === "passed")).toHaveLength(7);
    expect(st.filter((x) => x === "failed")).toHaveLength(2);
    expect(st.filter((x) => x === "blocked")).toHaveLength(2);
    const gate = await evaluateGate(db, s.id);
    expect(gate.pass).toBe(false);
    const sp = await currentSprint(db, s.projectId);
    const board = await boardStories(db, s.projectId, sp!.id);
    const row = board.find((r) => r.jiraKey === "DEMO-110859")!;
    expect(row).toMatchObject({ tcApproved: 12, tcDraft: 0, qOpen: 1, bugsOpen: 2, bugsVerify: 1, lastBuild: "DEV-R1", usTitles: "View Map deck · Delete Map deck" });
    expect(board.find((r) => r.jiraKey === "DEMO-110930")).toMatchObject({ tcApproved: 0, bugsOpen: 0, lastBuild: null });
  });
});

describe("rounds, bugs, reports, gates", () => {
  it("runs DEV round 1 → bug → round 2 → gate → STG → PROD smoke", async () => {
    const r1 = await createNextBuild(db, storyId, "dev", qc);
    expect(r1.name).toBe("DEV-R1");
    let rows = await buildRows(db, r1.id);
    expect(rows).toHaveLength(3); // drafts are excluded
    const ex = (seq: number) => rows.find((r) => r.tc.seq === seq)!.e.id;
    await setExecution(db, qc, ex(1), { status: "passed" });
    await setExecution(db, qc, ex(2), { status: "failed", notes: "Vẫn thấy menu" });
    await setExecution(db, qc, ex(3), { status: "blocked", linkedIssueKey: "op-22222" });
    rows = await buildRows(db, r1.id);
    expect(buildProblems(rows)).toEqual(["TC-02 Failed chưa gắn bug"]);
    await expect(setExecution(db, qc, ex(3), { status: "blocked", linkedIssueKey: "khong hop le" })).rejects.toThrow(/không đúng dạng/);

    // Bug from the failed TC, with evidence, published to (fake) Jira as a sub-task.
    const bugId = await createDraftBug(db, qc, { storyId, executionId: ex(2), fields: { title: "Menu vẫn hiện", steps: "1. Đăng nhập\n2. Mở menu", actual: "Thấy menu", expected: "Không thấy", severity: "major", env: "dev" }, source: "manual" });
    await addEvidence(db, qc, "bug", bugId, [png()]);
    const jira = fakeJira();
    expect(await publishBug(db, jira, bugId, qc)).toBe("OP-900");
    const create = jira.calls.find((c) => c.op === "create")!.args[0] as { parentKey: string; issueType: string; extraFields: Record<string, unknown>; description: string };
    expect(create.parentKey).toBe("OP-1");
    expect(create.issueType).toBe("Sub-bug");
    expect(create.extraFields.customfield_1).toEqual({ value: "Major" });
    expect(create.description).toContain("h4. Steps to reproduce\n# Đăng nhập\n# Mở menu");
    expect(jira.calls.filter((c) => c.op === "attach")).toHaveLength(1);
    rows = await buildRows(db, r1.id);
    expect(rows.find((r) => r.tc.seq === 2)!.e.linkedIssueKey).toBe("OP-900");
    expect(buildProblems(rows)).toEqual([]);

    // Push to TestLink: plan, build, results with bug id.
    const reported: { externalId: string; status: string; bugId?: string }[] = [];
    const tl = {
      projectByName: async () => ({ id: "7", prefix: "OPTC" }),
      ensureTestPlan: async () => "70",
      addToPlan: async () => undefined,
      createBuild: async () => "71",
      reportResult: async (r: { externalId: string; status: string; bugId?: string }) => void reported.push(r),
    } as unknown as TestLinkClient;
    expect(await pushBuildToTestlink(db, tl, r1.id, qc)).toBe(3);
    expect(reported.find((r) => r.externalId === "OPTC-2")).toMatchObject({ status: "f", bugId: "OP-900" });
    expect(await pushBuildToTestlink(db, tl, r1.id, qc)).toBe(0); // nothing new

    // Report + gate (fails), dev resolves the bug, QC verifies with fix evidence.
    await generateReport(db, null, r1.id, qc);
    const c = await computeCounts(db, r1.id);
    expect(c.env).toMatchObject({ passed: 1, failed: 1, blocked: 1, total: 3 });
    expect(c.byUs.map((u) => u.us)).toEqual(["US1", "US2"]);
    expect(c.openBugs).toEqual([{ key: "OP-900", title: "Menu vẫn hiện", severity: "major" }]);
    expect(c.blockers).toEqual(["OP-22222"]);
    expect((await evaluateGate(db, storyId)).pass).toBe(false);

    expect(await applyJiraStatus(db, "OP-900", "Resolved")).toBe(true);
    expect((await db.select().from(bugs).where(eq(bugs.id, bugId)))[0].status).toBe("resolved");
    await expect(verifyAndClose(db, jira, bugId, qc, "")).rejects.toThrow(/ảnh\/video chứng minh/);
    await addEvidence(db, qc, "bug_fix", bugId, [png()]);
    await verifyAndClose(db, jira, bugId, qc, "OK trên DEV-R2");
    expect(jira.calls.some((c) => c.op === "transition")).toBe(true);
    expect((await db.select().from(bugs).where(eq(bugs.id, bugId)))[0].status).toBe("closed");

    // Round 2 only contains what did not pass.
    const r2 = await createNextBuild(db, storyId, "dev", qc);
    expect(r2.name).toBe("DEV-R2");
    const rows2 = await buildRows(db, r2.id);
    expect(rows2.map((r) => r.tc.seq)).toEqual([2, 3]);
    // Before running R2 the cumulative view still shows R1 results.
    expect((await latestResults(db, storyId, "dev")).get(rows2[0].tc.id)?.status).toBe("failed");
    for (const r of rows2) await setExecution(db, qc, r.e.id, { status: "passed" });
    await generateReport(db, null, r2.id, qc);
    let gate = await evaluateGate(db, storyId);
    expect(gate.checks.find((x) => x.label.startsWith("Report"))?.ok).toBe(false);
    await expect(advanceStory(db, null, storyId, qc, null)).rejects.toThrow(/Chưa qua gate/);
    const where = await postReport(db, jira, r2.id, qc);
    expect(where).toEqual(["Jira"]);
    gate = await evaluateGate(db, storyId);
    expect(gate.pass).toBe(true);

    expect(await advanceStory(db, jira, storyId, qc, null)).toBe("stg");
    const stg = (await db.select().from(builds).where(and(eq(builds.storyId, storyId), eq(builds.env, "stg"))))[0];
    expect(stg.name).toBe("STG-R1");
    expect(await buildRows(db, stg.id)).toHaveLength(3); // full regression on staging

    // Lead override with a reason moves on even though STG has not been run.
    expect(await advanceStory(db, null, storyId, qc, "PO chấp nhận rủi ro")).toBe("prod");
    const prod = (await db.select().from(builds).where(and(eq(builds.storyId, storyId), eq(builds.env, "prod"))))[0];
    expect(prod.name).toBe("PROD-SMOKE");
    expect((await buildRows(db, prod.id)).map((r) => r.tc.seq)).toEqual([1]); // happy cases only
  });

  it("maps Jira statuses with the project's names", () => {
    const map = { resolved: ["Ready for QC"], closed: ["Done"], reopened: ["Reopened"] };
    expect(mapJiraStatus("ready for qc", map)).toBe("resolved");
    expect(mapJiraStatus("Done", map)).toBe("closed");
    expect(mapJiraStatus("In Progress", map)).toBe("in_progress");
    expect(mapJiraStatus("To Do", map)).toBe("open");
  });
});

describe("git webhook", () => {
  it("verifies GitLab tokens and GitHub signatures, and links commits", async () => {
    const body = JSON.stringify({ commits: [{ id: "abc1234def", message: "OP-900 fix menu\n\nmore", url: "https://git/c/abc", author: { name: "Tuấn" } }] });
    expect(verifyGitWebhook(new Headers({ "x-gitlab-token": "s3cret" }), body, "s3cret")).toBe("gitlab");
    expect(verifyGitWebhook(new Headers({ "x-gitlab-token": "nope" }), body, "s3cret")).toBeNull();
    const sig = "sha256=" + createHmac("sha256", "s3cret").update(body).digest("hex");
    expect(verifyGitWebhook(new Headers({ "x-hub-signature-256": sig }), body, "s3cret")).toBe("github");
    expect(verifyGitWebhook(new Headers({}), body, "s3cret")).toBeNull();
    const commits = commitsFromPush(JSON.parse(body));
    expect(issueKeysIn(commits[0].message)).toEqual(["OP-900"]);
    expect(await addFixCommit(db, "OP-900", commits[0])).toBe(true);
    expect(await addFixCommit(db, "OP-900", commits[0])).toBe(false); // idempotent
  });
});

describe("MCP tokens and agent tools", () => {
  it("authenticates, scopes and permission-checks agent calls", async () => {
    const write = await createMcpToken(db, qc, "Antigravity · Mac", "write", 30);
    const read = await createMcpToken(db, dev, "Dev read", "read", 30);
    expect(await authenticateMcp(db, "Bearer nope")).toBeNull();
    const qcAuth = (await authenticateMcp(db, `Bearer ${write}`))!;
    const devAuth = (await authenticateMcp(db, `Bearer ${read}`))!;
    expect(qcAuth.scope).toBe("write");
    expect(toolList("read").map((t) => t.name)).not.toContain("record_execution");

    const stories = (await runTool(db, qcAuth, "list_sprint_stories", {})) as { project: string }[];
    expect(stories.map((p) => p.project).sort()).toEqual(["DEMO", "OP"]);

    const b = (await runTool(db, qcAuth, "get_build_testcases", { storyKey: "OP-1" })) as { build: string; testCases: { executionId: string }[] };
    expect(b.build).toBe("PROD-SMOKE");
    const execId = b.testCases[0].executionId;
    await runTool(db, qcAuth, "record_execution", { executionId: execId, status: "failed", notes: "Nút không bấm được" });
    const [e] = await db.select().from(executions).where(eq(executions.id, execId));
    expect(e).toMatchObject({ status: "failed", byAgent: true, reviewed: false });
    const d = (await runTool(db, qcAuth, "draft_bug", { executionId: execId, title: "Nút hỏng", steps: "1. Bấm", actual: "Không gì", expected: "Mở popup" })) as { draftBug: string };
    expect(d.draftBug).toMatch(/^LOCAL-/);
    await runTool(db, qcAuth, "upload_evidence", { bugKey: d.draftBug, fileName: "a.png", mimeType: "image/png", contentBase64: Buffer.from("x").toString("base64") });
    const p = (await runTool(db, qcAuth, "propose_test_cases", { storyKey: "OP-1", testCases: [{ title: "Mới", steps: [{ action: "a", expected: "b" }] }, { title: "Không bước", steps: [] }] })) as { created: number };
    expect(p.created).toBe(1);
    const [drafted] = await db.select().from(testCases).where(and(eq(testCases.storyId, storyId), eq(testCases.source, "agent")));
    expect(drafted.status).toBe("draft");

    await expect(runTool(db, devAuth, "record_execution", { executionId: execId, status: "passed" })).rejects.toThrow(/chỉ có quyền đọc/);
    expect(((await runTool(db, devAuth, "get_story", { storyKey: "OP-1" })) as { key: string }).key).toBe("OP-1");
    await expect(runTool(db, devAuth, "get_story", { storyKey: "DEMO-110859" })).rejects.toThrow(/không có quyền/);

    const [t] = await listMcpTokens(db, qc);
    await revokeMcpToken(db, qc, t.id);
    expect(await authenticateMcp(db, `Bearer ${write}`)).toBeNull();
  });
});

describe("report rows", () => {
  it("stores one report per build", async () => {
    const rs = await db.select().from(reports);
    expect(new Set(rs.map((r) => r.buildId)).size).toBe(rs.length);
    const [p] = await db.select().from(projects).where(eq(projects.key, "OP"));
    expect(p.gateRules.dev.minPassRate).toBe(95);
  });
});

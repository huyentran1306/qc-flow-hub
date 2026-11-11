import { beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { openDb, type DB } from "@/lib/db";
import { auditLogs, projects, questions, stories, testCases, userStories } from "@/lib/db/schema";
import { createFirstAdmin, createUser, verifyLogin, setMembership } from "@/lib/services/users";
import { projectContext, createProject, roleIn } from "@/lib/services/projects";
import { seedDemo } from "@/lib/services/demo";
import { analyzeStory, generateTestCases } from "@/lib/services/ai";
import { approveTcs, pushToTestlink, deleteTc } from "@/lib/services/testcases";
import { publishQuestion, answerQuestion } from "@/lib/services/questions";
import { syncProjectFromJira, boardStories } from "@/lib/services/stories";
import { saveConnection, loadJira, listConnections } from "@/lib/services/connections";
import type { AiClient } from "@/lib/integrations/gemini";
import type { JiraClient } from "@/lib/integrations/jira";
import type { TestLinkClient } from "@/lib/integrations/testlink";

let db: DB;
let adminId: string;
let qcId: string;
let devId: string;

function fakeAi(responses: unknown[]): AiClient & { prompts: string[] } {
  const prompts: string[] = [];
  return {
    model: "fake-model",
    prompts,
    async generateJson<T>({ prompt }: { prompt: string }) {
      prompts.push(prompt);
      return responses.shift() as T;
    },
  };
}

beforeAll(async () => {
  db = await openDb({ memory: true });
  adminId = await createFirstAdmin(db, { email: "Admin@Noibo.local", name: "Quân", password: "password123" });
  qcId = await createUser(db, adminId, { email: "ngoc@noibo.local", name: "Ngọc", password: "password123", isAdmin: false });
  devId = await createUser(db, adminId, { email: "tuan@noibo.local", name: "Tuấn", password: "password123", isAdmin: false });
});

describe("users and projects", () => {
  it("allows only one first-run admin and normalises emails", async () => {
    await expect(createFirstAdmin(db, { email: "x@y.z", name: "X", password: "password123" })).rejects.toThrow(/đã có tài khoản/);
    expect((await verifyLogin(db, "admin@noibo.local", "password123"))?.isAdmin).toBe(true);
    expect(await verifyLogin(db, "admin@noibo.local", "wrong-pass")).toBeNull();
    await expect(createUser(db, adminId, { email: "ngoc@noibo.local", name: "N", password: "password123", isAdmin: false })).rejects.toThrow(/đã có/);
  });

  it("shows members only their projects; admins see all", async () => {
    await createProject(db, adminId, { key: "OP", name: "OP Platform", jiraBoardId: 42, testlinkProjectName: "OP Platform", mapping: { storyIssueType: "Story", subBugIssueType: "Sub-bug", qcSubtaskLabel: "QC" } });
    await createProject(db, adminId, { key: "CRM", name: "CRM", jiraBoardId: null, testlinkProjectName: null, mapping: { storyIssueType: "Story", subBugIssueType: "Sub-bug", qcSubtaskLabel: "QC" } });
    const [op] = await db.select().from(projects).where(eq(projects.key, "OP"));
    await setMembership(db, adminId, qcId, op.id, "qc");
    await setMembership(db, adminId, devId, op.id, "dev");
    const qc = await projectContext(db, { id: qcId, isAdmin: false }, "CRM");
    expect(qc.available.map((p) => p.key)).toEqual(["OP"]);
    expect(qc.project?.key).toBe("OP");
    expect(qc.role).toBe("qc");
    const admin = await projectContext(db, { id: adminId, isAdmin: true }, "CRM");
    expect(admin.available.map((p) => p.key)).toEqual(["CRM", "OP"]);
    expect(admin.role).toBeNull();
    expect(await roleIn(db, devId, op.id)).toBe("dev");
  });
});

describe("connections", () => {
  it("stores tokens encrypted and only exposes a hint", async () => {
    await saveConnection(db, adminId, "jira", { baseUrl: "https://x.atlassian.net", flavor: "cloud", email: "bot@x", junk: "drop me" }, "ATATT-secret-9F2a");
    const view = await listConnections(db);
    expect(view.jira?.secretHint).toBe("9F2a");
    expect(view.jira?.config).toEqual({ baseUrl: "https://x.atlassian.net", flavor: "cloud", email: "bot@x" });
    expect(JSON.stringify(view)).not.toContain("ATATT-secret");
    expect(await loadJira(db)).not.toBeNull();
    // Saving again without a secret keeps the stored token.
    await saveConnection(db, adminId, "jira", { baseUrl: "https://y.atlassian.net", flavor: "cloud", email: "bot@x" });
    expect((await listConnections(db)).jira?.secretHint).toBe("9F2a");
  });
});

describe("jira sync", () => {
  it("upserts stories of the active sprint", async () => {
    const [op] = await db.select().from(projects).where(eq(projects.key, "OP"));
    let summary = "[MapDeck] Management";
    const jira = {
      activeSprints: async () => [{ id: 900, name: "Sprint 42", state: "active", startDate: "2026-11-03T00:00:00Z", endDate: "2026-11-14T00:00:00Z" }],
      sprintStories: async () => [
        { key: "OP-110859", summary, description: "US1 - View", status: "In Progress", subtasks: [{ key: "OP-110862", summary: "QC – viết TC", status: "To Do", issueType: "Sub-task", labels: [] }] },
      ],
    } as unknown as JiraClient;
    expect(await syncProjectFromJira(db, jira, op, qcId)).toMatchObject({ created: 1, updated: 0 });
    summary = "[MapDeck] Management v2";
    expect(await syncProjectFromJira(db, jira, op, qcId)).toMatchObject({ created: 0, updated: 1 });
    const rows = await boardStories(db, op.id, null);
    expect(rows).toHaveLength(1);
    expect(rows[0].summary).toBe("[MapDeck] Management v2");
  });
});

describe("AI → Q&A → test cases → TestLink", () => {
  it("runs the phase-1 flow on the demo project", async () => {
    const key = await seedDemo(db, qcId);
    expect(key).toBe("DEMO");
    const [story] = await db.select().from(stories).where(eq(stories.jiraKey, "DEMO-110930"));

    const ai = fakeAi([
      {
        userStories: [
          { code: "US1", title: "View Map deck", description: "Xem danh sách" },
          { code: "US2", title: "Delete Map deck", description: "Xoá" },
        ],
        testPoints: ["Phân trang 20 dòng"],
        dependencies: [],
        risks: ["Phân quyền View/Manage"],
        questions: ["Xoá mềm hay xoá vĩnh viễn?", "  "],
      },
      {
        testCases: [
          { us: "US1", title: "Hiển thị đủ 4 cột", type: "happy", priority: "high", preconditions: "Có 25 deck", requirementRef: "AC-1", steps: [{ action: "Mở danh sách", expected: "Đủ 4 cột" }] },
          { us: "US9", title: "US không tồn tại", type: "weird", priority: "urgent", steps: [{ action: "a", expected: "b" }] },
          { us: "US2", title: "Không có bước", type: "edge", priority: "low", steps: [] },
        ],
        openQuestions: ["Xoá mềm hay xoá vĩnh viễn?", "Bulk delete tối đa bao nhiêu?"],
      },
    ]);

    const a = await analyzeStory(db, ai, story, qcId);
    expect(a).toEqual({ userStories: 2, questions: 1 });
    expect(ai.prompts[0]).toContain("DEMO-110930");
    const [afterAnalysis] = await db.select().from(stories).where(eq(stories.id, story.id));
    expect(afterAnalysis.qaStage).toBe("qna");
    expect(afterAnalysis.analysis?.model).toBe("fake-model");

    const [q] = await db.select().from(questions).where(eq(questions.storyId, story.id));
    expect(q.status).toBe("draft");
    await publishQuestion(db, qcId, q.id, "BA Lan", null);
    await answerQuestion(db, qcId, q.id, "Xoá mềm, giữ 30 ngày");

    const g = await generateTestCases(db, ai, afterAnalysis, qcId);
    expect(g).toEqual({ created: 2, questions: 1 }); // the step-less TC and the duplicate question are dropped
    expect(ai.prompts[1]).toContain("Trả lời: Xoá mềm, giữ 30 ngày");
    const tcs = await db.select().from(testCases).where(eq(testCases.storyId, story.id)).orderBy(testCases.seq);
    expect(tcs.map((t) => [t.seq, t.usCode, t.type, t.priority, t.status])).toEqual([
      [1, "US1", "happy", "high", "draft"],
      [2, "US1", "happy", "medium", "draft"],
    ]);

    expect(await approveTcs(db, qcId, story.id, "all-drafts")).toBe(2);
    const [ready] = await db.select().from(stories).where(eq(stories.id, story.id));
    expect(ready.qaStage).toBe("tc_ready");

    // Push: the demo project has no TestLink mapping, so point the story at OP for this check.
    const [op] = await db.select().from(projects).where(eq(projects.key, "OP"));
    await db.update(stories).set({ projectId: op.id }).where(eq(stories.id, story.id));
    const created: string[] = [];
    const tl = {
      projectByName: async (n: string) => ({ id: n === "OP Platform" ? "1" : "x", prefix: "OPTC" }),
      ensureSuite: async (_p: string, name: string) => (name.startsWith("DEMO-110930") ? "55" : "x"),
      createTestCase: async (i: { suiteId: string; name: string }) => {
        if (i.name.includes("4 cột") === false) throw new Error("boom");
        created.push(i.name);
        return { id: "900", externalId: "12" };
      },
    } as unknown as TestLinkClient;
    const r = await pushToTestlink(db, tl, story.id, qcId);
    expect(r.pushed).toBe(1);
    expect(r.failed[0]).toMatch(/^TC-02: boom/);
    const [pushed] = await db.select().from(testCases).where(and(eq(testCases.storyId, story.id), eq(testCases.seq, 1)));
    expect(pushed.testlinkExternalId).toBe("OPTC-12");
    await expect(deleteTc(db, qcId, pushed.id)).rejects.toThrow(/TestLink/);

    // Re-analysis replaces user stories instead of duplicating them.
    const ai2 = fakeAi([{ userStories: [{ code: "US1", title: "Gộp", description: "" }], testPoints: [], dependencies: [], risks: [], questions: [] }]);
    await analyzeStory(db, ai2, ready, qcId);
    expect(await db.select().from(userStories).where(eq(userStories.storyId, story.id))).toHaveLength(1);

    const log = await db.select().from(auditLogs);
    expect(log.map((l) => l.action)).toEqual(expect.arrayContaining(["AI phân tích requirement", "AI sinh test case", "Duyệt 2 test case", "Đẩy 1 test case lên TestLink"]));
  });
});

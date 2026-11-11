import { and, desc, eq, inArray } from "drizzle-orm";
import { insertWithNextSeq } from "../seq";
import type { DB } from "../db";
import { bugs, builds, executions, memberships, projects, questions, stories, testCases, userStories, type Env, type ExecStatus, type Severity } from "../db/schema";
import { can, type Perm } from "../rbac";
import { audit } from "../audit";
import { roleIn } from "../services/projects";
import { currentSprint, boardStories } from "../services/stories";
import { setExecution, buildRows, ENV_LABEL } from "../services/execution";
import { addEvidence, bugCode, createDraftBug } from "../services/bugs";
import { tcCode } from "../format";

export type AgentAuth = { user: { id: string; isAdmin: boolean; name: string }; scope: "read" | "write" };

type Tool = {
  name: string;
  description: string;
  write: boolean;
  inputSchema: Record<string, unknown>;
  run: (db: DB, auth: AgentAuth, args: Record<string, unknown>) => Promise<unknown>;
};

const str = (v: unknown, name: string) => {
  if (typeof v !== "string" || !v.trim()) throw new Error(`Thiếu tham số ${name}.`);
  return v.trim();
};

async function storyFor(db: DB, auth: AgentAuth, key: string, perm: Perm) {
  const [s] = await db.select().from(stories).where(eq(stories.jiraKey, key.toUpperCase()));
  if (!s) throw new Error(`Không tìm thấy story ${key}.`);
  const role = await roleIn(db, auth.user.id, s.projectId);
  if (!can({ isAdmin: auth.user.isAdmin, role }, perm)) throw new Error(`Bạn không có quyền ${perm} trong dự án của ${key}.`);
  return s;
}

async function execFor(db: DB, auth: AgentAuth, executionId: string) {
  const [row] = await db
    .select({ e: executions, b: builds, s: stories, tc: testCases })
    .from(executions)
    .innerJoin(builds, eq(builds.id, executions.buildId))
    .innerJoin(stories, eq(stories.id, builds.storyId))
    .innerJoin(testCases, eq(testCases.id, executions.testCaseId))
    .where(eq(executions.id, executionId));
  if (!row) throw new Error("executionId không tồn tại.");
  await storyFor(db, auth, row.s.jiraKey, "tc.edit");
  return row;
}

const stepsSchema = { type: "array", items: { type: "object", properties: { action: { type: "string" }, expected: { type: "string" } }, required: ["action", "expected"] } };

export const TOOLS: Tool[] = [
  {
    name: "list_sprint_stories",
    description: "Danh sách story trong sprint đang chạy của các dự án bạn tham gia, kèm giai đoạn QA và môi trường hiện tại.",
    write: false,
    inputSchema: { type: "object", properties: { projectKey: { type: "string", description: "Mã dự án, ví dụ OP. Bỏ trống để lấy mọi dự án." } } },
    async run(db, auth, args) {
      const ms = await db.select().from(memberships).where(eq(memberships.userId, auth.user.id));
      const ps = auth.user.isAdmin ? await db.select().from(projects) : ms.length ? await db.select().from(projects).where(inArray(projects.id, ms.map((m) => m.projectId))) : [];
      const out = [];
      for (const p of ps) {
        if (typeof args.projectKey === "string" && args.projectKey && p.key !== args.projectKey.toUpperCase()) continue;
        const sp = await currentSprint(db, p.id);
        const rows = await boardStories(db, p.id, sp?.id ?? null);
        const extra = rows.length ? await db.select({ id: stories.id, env: stories.currentEnv }).from(stories).where(inArray(stories.id, rows.map((r) => r.id))) : [];
        const envOf = new Map(extra.map((x) => [x.id, x.env]));
        out.push({ project: p.key, sprint: sp?.name ?? null, stories: rows.map((r) => ({ key: r.jiraKey, summary: r.summary, qaStage: r.qaStage, env: ENV_LABEL[envOf.get(r.id) ?? "dev"], approvedTestCases: r.tcApproved, openQuestions: r.qOpen })) });
      }
      return out;
    },
  },
  {
    name: "get_story",
    description: "Chi tiết story: requirement, User Story, Q&A đã trả lời, test case đã duyệt và bug đang mở.",
    write: false,
    inputSchema: { type: "object", properties: { storyKey: { type: "string" } }, required: ["storyKey"] },
    async run(db, auth, args) {
      const s = await storyFor(db, auth, str(args.storyKey, "storyKey"), "story.view");
      const us = await db.select().from(userStories).where(eq(userStories.storyId, s.id));
      const qs = await db.select().from(questions).where(and(eq(questions.storyId, s.id), eq(questions.status, "answered")));
      const tcs = await db.select().from(testCases).where(and(eq(testCases.storyId, s.id), eq(testCases.status, "approved")));
      const bs = await db.select().from(bugs).where(and(eq(bugs.storyId, s.id), inArray(bugs.status, ["open", "in_progress", "resolved"])));
      return {
        key: s.jiraKey,
        summary: s.summary,
        description: s.description,
        environment: ENV_LABEL[s.currentEnv],
        userStories: us.map((u) => ({ code: u.code, title: u.title, description: u.description })),
        answeredQuestions: qs.map((q) => ({ question: q.content, answer: q.answer })),
        testCases: tcs.sort((a, b) => a.seq - b.seq).map((t) => ({ code: tcCode(t.seq), us: t.usCode, type: t.type, title: t.title, preconditions: t.preconditions, steps: t.steps })),
        openBugs: bs.map((b) => ({ key: bugCode(b), title: b.title, severity: b.severity, status: b.status })),
      };
    },
  },
  {
    name: "propose_test_cases",
    description: "Gửi test case đề xuất. Test case vào hàng chờ duyệt của QC, chưa được dùng ngay.",
    write: true,
    inputSchema: {
      type: "object",
      properties: {
        storyKey: { type: "string" },
        testCases: {
          type: "array",
          items: {
            type: "object",
            properties: { us: { type: "string" }, title: { type: "string" }, type: { type: "string", enum: ["happy", "negative", "edge"] }, priority: { type: "string", enum: ["high", "medium", "low"] }, preconditions: { type: "string" }, steps: stepsSchema },
            required: ["title", "steps"],
          },
        },
      },
      required: ["storyKey", "testCases"],
    },
    async run(db, auth, args) {
      const s = await storyFor(db, auth, str(args.storyKey, "storyKey"), "tc.edit");
      const list = Array.isArray(args.testCases) ? (args.testCases as Record<string, unknown>[]) : [];
      const valid = list.filter((t) => typeof t.title === "string" && Array.isArray(t.steps) && (t.steps as unknown[]).length).slice(0, 50);
      const rows = await insertWithNextSeq(db, s.id, async (first) => {
        const out = valid.map((t, i) => ({
          storyId: s.id,
          seq: first + i,
          usCode: typeof t.us === "string" && t.us ? t.us : "US1",
          title: String(t.title),
          type: (["happy", "negative", "edge"].includes(String(t.type)) ? t.type : "happy") as "happy",
          priority: (["high", "medium", "low"].includes(String(t.priority)) ? t.priority : "medium") as "medium",
          preconditions: typeof t.preconditions === "string" ? t.preconditions : "",
          steps: (t.steps as { action?: unknown; expected?: unknown }[]).map((x) => ({ action: String(x.action ?? ""), expected: String(x.expected ?? "") })),
          source: "agent" as const,
          status: "draft" as const,
          createdBy: auth.user.id,
        }));
        if (out.length) await db.insert(testCases).values(out);
        return out;
      });
      await audit(db, { userId: auth.user.id, action: `Agent đề xuất ${rows.length} test case`, target: s.jiraKey, source: "mcp" });
      return { created: rows.length, note: "Đang chờ QC duyệt trong tool." };
    },
  },
  {
    name: "get_build_testcases",
    description: "Build đang chạy của story ở môi trường hiện tại: URL môi trường và danh sách test case cần chạy, mỗi dòng có executionId để ghi kết quả.",
    write: false,
    inputSchema: { type: "object", properties: { storyKey: { type: "string" }, env: { type: "string", enum: ["dev", "stg", "prod"], description: "Bỏ trống để dùng môi trường hiện tại của story." } }, required: ["storyKey"] },
    async run(db, auth, args) {
      const s = await storyFor(db, auth, str(args.storyKey, "storyKey"), "story.view");
      const env = (["dev", "stg", "prod"].includes(String(args.env)) ? args.env : s.currentEnv) as Env;
      const [b] = await db.select().from(builds).where(and(eq(builds.storyId, s.id), eq(builds.env, env))).orderBy(desc(builds.round)).limit(1);
      if (!b) return { message: `Chưa có build nào ở ${ENV_LABEL[env]}. QC cần tạo build trong tool trước.` };
      const [p] = await db.select().from(projects).where(eq(projects.id, s.projectId));
      const rows = await buildRows(db, b.id);
      return {
        build: b.name,
        environment: ENV_LABEL[env],
        environmentUrl: p.envUrls[env] ?? null,
        note: "Tài khoản test không được gửi qua đây; lấy từ trình quản lý mật khẩu của máy.",
        testCases: rows.map(({ e, tc }) => ({ executionId: e.id, code: tcCode(tc.seq), title: tc.title, preconditions: tc.preconditions, steps: tc.steps, currentStatus: e.status })),
      };
    },
  },
  {
    name: "record_execution",
    description: "Ghi kết quả một test case. Kết quả được đánh dấu là do agent ghi và chờ QC duyệt trước khi gửi TestLink.",
    write: true,
    inputSchema: {
      type: "object",
      properties: {
        executionId: { type: "string" },
        status: { type: "string", enum: ["passed", "failed", "blocked"] },
        notes: { type: "string", description: "Quan sát thực tế, đặc biệt khi failed." },
        linkedIssueKey: { type: "string", description: "Ticket đang chặn khi status = blocked." },
      },
      required: ["executionId", "status"],
    },
    async run(db, auth, args) {
      const row = await execFor(db, auth, str(args.executionId, "executionId"));
      const status = String(args.status) as ExecStatus;
      if (!["passed", "failed", "blocked"].includes(status)) throw new Error("status phải là passed, failed hoặc blocked.");
      await setExecution(db, auth.user.id, row.e.id, { status, notes: typeof args.notes === "string" ? args.notes : undefined, linkedIssueKey: typeof args.linkedIssueKey === "string" ? args.linkedIssueKey : null }, { byAgent: true });
      await audit(db, { userId: auth.user.id, action: `Agent ghi ${status} ${tcCode(row.tc.seq)}`, target: `${row.s.jiraKey} ${row.b.name}`, source: "mcp" });
      return { ok: true, next: status === "failed" ? "Gọi draft_bug với executionId này để tạo nháp bug." : undefined };
    },
  },
  {
    name: "upload_evidence",
    description: "Đính kèm ảnh hoặc video (base64) vào một lần thực thi hoặc một bug nháp.",
    write: true,
    inputSchema: {
      type: "object",
      properties: { executionId: { type: "string" }, bugKey: { type: "string" }, fileName: { type: "string" }, mimeType: { type: "string" }, contentBase64: { type: "string" } },
      required: ["fileName", "contentBase64"],
    },
    async run(db, auth, args) {
      const name = str(args.fileName, "fileName");
      const data = Buffer.from(str(args.contentBase64, "contentBase64"), "base64");
      const file = new File([new Uint8Array(data)], name, { type: typeof args.mimeType === "string" ? args.mimeType : "application/octet-stream" });
      if (typeof args.executionId === "string" && args.executionId) {
        const row = await execFor(db, auth, args.executionId);
        await addEvidence(db, auth.user.id, "execution", row.e.id, [file]);
        return { ok: true };
      }
      const key = str(args.bugKey, "bugKey hoặc executionId").toUpperCase();
      const all = await db.select().from(bugs);
      const bug = all.find((b) => bugCode(b) === key);
      if (!bug) throw new Error(`Không tìm thấy bug ${key}.`);
      const [s] = await db.select().from(stories).where(eq(stories.id, bug.storyId));
      await storyFor(db, auth, s.jiraKey, "tc.edit");
      await addEvidence(db, auth.user.id, "bug", bug.id, [file]);
      return { ok: true };
    },
  },
  {
    name: "draft_bug",
    description: "Tạo nháp sub-bug từ một test case failed. QC duyệt trong tool rồi mới tạo trên Jira.",
    write: true,
    inputSchema: {
      type: "object",
      properties: {
        executionId: { type: "string" },
        title: { type: "string" },
        steps: { type: "string", description: "Các bước đánh số, mỗi bước một dòng." },
        actual: { type: "string" },
        expected: { type: "string" },
        severity: { type: "string", enum: ["critical", "major", "minor"] },
      },
      required: ["executionId", "title", "steps", "actual", "expected"],
    },
    async run(db, auth, args) {
      const row = await execFor(db, auth, str(args.executionId, "executionId"));
      const severity = (["critical", "major", "minor"].includes(String(args.severity)) ? args.severity : "major") as Severity;
      const id = await createDraftBug(db, auth.user.id, {
        storyId: row.s.id,
        executionId: row.e.id,
        source: "agent",
        fields: { title: str(args.title, "title"), steps: String(args.steps ?? ""), actual: String(args.actual ?? ""), expected: String(args.expected ?? ""), severity, env: row.b.env },
      });
      return { draftBug: bugCode({ id, jiraKey: null }), note: "Nháp đang chờ QC duyệt trong tool. Có thể gọi upload_evidence với bugKey này." };
    },
  },
  {
    name: "get_bug",
    description: "Chi tiết một bug: các bước, kết quả, trạng thái, commit fix.",
    write: false,
    inputSchema: { type: "object", properties: { bugKey: { type: "string" } }, required: ["bugKey"] },
    async run(db, auth, args) {
      const key = str(args.bugKey, "bugKey").toUpperCase();
      const [byJira] = await db.select().from(bugs).where(eq(bugs.jiraKey, key));
      const bug = byJira ?? (await db.select().from(bugs)).find((b) => bugCode(b) === key);
      if (!bug) throw new Error(`Không tìm thấy bug ${key}.`);
      const [s] = await db.select().from(stories).where(eq(stories.id, bug.storyId));
      await storyFor(db, auth, s.jiraKey, "story.view");
      return { key: bugCode(bug), story: s.jiraKey, title: bug.title, steps: bug.steps, actual: bug.actual, expected: bug.expected, severity: bug.severity, environment: ENV_LABEL[bug.env], status: bug.status, jiraStatus: bug.jiraStatus, fixCommits: bug.fixCommits };
    },
  },
];

export function toolList(scope: "read" | "write") {
  return TOOLS.filter((t) => scope === "write" || !t.write).map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));
}

export async function runTool(db: DB, auth: AgentAuth, name: string, args: Record<string, unknown>) {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) throw new Error(`Không có tool ${name}.`);
  if (tool.write && auth.scope !== "write") throw new Error("Token này chỉ có quyền đọc.");
  return tool.run(db, auth, args ?? {});
}

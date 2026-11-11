import { eq } from "drizzle-orm";
import type { DB } from "../db";
import { bugs, builds, executions, memberships, projects, questions, sprints, stories, testCases, userStories, type TcPriority, type TcType } from "../db/schema";
import { audit } from "../audit";

const DEMO_STORIES = [
  {
    jiraKey: "DEMO-110859",
    summary: "[MapDeck] Management",
    jiraStatus: "In Progress",
    description: `US1 - View Map deck
Là Operator có quyền View, tôi muốn xem danh sách Map deck để quản lý.
Acceptance criteria:
- AC-1: Danh sách hiển thị cột Tên, Người tạo, Ngày cập nhật, Số layer.
- AC-2: Phân trang 20 dòng mỗi trang.
- AC-3: Tìm kiếm theo tên Map deck.
- AC-4: Mặc định sắp xếp theo Ngày cập nhật mới nhất.
- AC-5: User không có quyền View không thấy menu Map deck.

US2 - Delete Map deck
Là Operator có quyền Manage, tôi muốn xoá một hoặc nhiều Map deck.
Acceptance criteria:
- AC-6: Bấm Xoá hiển thị popup xác nhận có tên Map deck.
- AC-7: Cho phép chọn nhiều Map deck và xoá cùng lúc.
- AC-8: User chỉ có quyền View không thấy nút Xoá.`,
    subtasks: [
      { key: "DEMO-110860", summary: "FE – Danh sách Map deck", status: "Done", issueType: "Sub-task", labels: [] },
      { key: "DEMO-110861", summary: "BE – API xoá Map deck", status: "Done", issueType: "Sub-task", labels: [] },
      { key: "DEMO-110862", summary: "QC – Phân tích & viết TC", status: "In Progress", issueType: "Sub-task", labels: ["QC"] },
    ],
  },
  {
    jiraKey: "DEMO-110930",
    summary: "[Dashboard] Widget filter",
    jiraStatus: "To Do",
    description: `Là Operator, tôi muốn lọc dữ liệu trên từng widget của Dashboard theo khoảng thời gian và khu vực, và lưu bộ lọc để dùng lại.
Acceptance criteria:
- AC-1: Mỗi widget có nút Lọc, chọn được khoảng thời gian (Hôm nay, 7 ngày, 30 ngày, Tuỳ chọn) và khu vực.
- AC-2: Bộ lọc của widget không ảnh hưởng widget khác.
- AC-3: Bấm Lưu bộ lọc thì lần sau mở Dashboard vẫn giữ.`,
    subtasks: [{ key: "DEMO-110931", summary: "FE – Widget filter", status: "In Progress", issueType: "Sub-task", labels: [] }],
  },
  {
    jiraKey: "DEMO-110917",
    summary: "[User] Role permission",
    jiraStatus: "To Do",
    description: `Admin có thể gán vai trò cho user. Vai trò con kế thừa quyền của vai trò cha. Mọi thay đổi quyền được ghi lại.`,
    subtasks: [],
  },
];

/** Creates a demo project with sample stories so the team can try the tool before Jira is connected. */
export async function seedDemo(db: DB, userId: string): Promise<string> {
  let [p] = await db.select().from(projects).where(eq(projects.key, "DEMO"));
  if (!p) {
    [p] = await db.insert(projects).values({ key: "DEMO", name: "Dự án mẫu", isDemo: true }).returning();
  }
  await db.insert(memberships).values({ userId, projectId: p.id, role: "lead" }).onConflictDoNothing();
  const now = new Date();
  const [sp] = await db
    .insert(sprints)
    .values({ projectId: p.id, jiraId: 42, name: "Sprint 42 (mẫu)", state: "active", startDate: now, endDate: new Date(now.getTime() + 11 * 864e5) })
    .onConflictDoUpdate({ target: [sprints.projectId, sprints.jiraId], set: { state: "active" } })
    .returning();
  for (const s of DEMO_STORIES) {
    await db
      .insert(stories)
      .values({ ...s, projectId: p.id, sprintId: sp.id, syncedAt: now })
      .onConflictDoNothing({ target: stories.jiraKey });
  }
  await seedMapDeckRun(db, userId);
  await audit(db, { userId, action: "Tạo dự án mẫu", target: "DEMO" });
  return p.key;
}

type DemoTc = [string, TcType, TcPriority, string, string, [string, string][]];
const MAPDECK_TCS: DemoTc[] = [
  ["US1", "happy", "high", "Hiển thị danh sách Map deck đủ 4 cột", "User có quyền View, có ≥ 25 Map deck", [["Vào menu Map deck", "Danh sách có cột Tên, Người tạo, Ngày cập nhật, Số layer"]]],
  ["US1", "happy", "medium", "Phân trang 20 dòng mỗi trang", "Có 45 Map deck", [["Mở danh sách", "Trang 1 có 20 dòng, tổng 3 trang"], ["Bấm trang 3", "Hiển thị 5 dòng"]]],
  ["US1", "happy", "high", "Tìm kiếm theo tên không phân biệt hoa thường", "Có deck “Hanoi Traffic”", [["Nhập “hanoi”", "Kết quả có “Hanoi Traffic”"], ["Nhập “HANOI”", "Kết quả giống bước 1"]]],
  ["US1", "negative", "medium", "Tìm không có kết quả hiển thị empty state", "", [["Nhập “zzzz”", "Hiển thị “Không tìm thấy Map deck”"]]],
  ["US1", "edge", "low", "Mặc định sắp xếp theo ngày cập nhật mới nhất", "", [["Mở danh sách", "Dòng đầu có ngày cập nhật mới nhất"]]],
  ["US1", "negative", "high", "User không có quyền View không thấy menu", "User không có quyền View", [["Đăng nhập", "Không có menu Map deck"], ["Truy cập URL /mapdecks", "Trang 403"]]],
  ["US2", "happy", "high", "Xoá 1 Map deck có popup xác nhận", "User có quyền Manage", [["Bấm Xoá ở 1 dòng", "Popup xác nhận hiển thị tên deck"], ["Bấm Xác nhận", "Deck vào thùng rác (xoá mềm, theo Q1)"]]],
  ["US2", "happy", "medium", "Bấm Huỷ ở popup thì không xoá", "", [["Bấm Xoá, rồi Huỷ", "Popup đóng, deck vẫn còn"]]],
  ["US2", "edge", "high", "Xoá deck đang được chia sẻ hiện cảnh báo", "Deck chia sẻ cho 3 user", [["Bấm Xoá", "Popup có cảnh báo “đang được chia sẻ với 3 người” (Q2)"]]],
  ["US2", "happy", "medium", "Xoá nhiều Map deck cùng lúc", "", [["Chọn 3 deck, bấm Xoá", "Popup ghi “Xoá 3 Map deck”"], ["Xác nhận", "Cả 3 deck biến khỏi danh sách"]]],
  ["US2", "negative", "high", "User chỉ có quyền View không thấy nút Xoá", "User chỉ có quyền View", [["Mở danh sách", "Không có nút Xoá"]]],
  ["US2", "edge", "low", "Mất mạng khi xoá thì báo lỗi, dữ liệu giữ nguyên", "", [["Ngắt mạng, bấm Xoá → Xác nhận", "Toast lỗi, deck vẫn còn"]]],
];

/** Sample run for DEMO-110859: approved test cases, a finished DEV round 1 with failures, blockers and bugs. */
async function seedMapDeckRun(db: DB, userId: string) {
  const [s] = await db.select().from(stories).where(eq(stories.jiraKey, "DEMO-110859"));
  if (!s) return;
  const [has] = await db.select({ id: testCases.id }).from(testCases).where(eq(testCases.storyId, s.id)).limit(1);
  if (has) return;
  await db.insert(userStories).values([
    { storyId: s.id, code: "US1", title: "View Map deck", description: "Xem, tìm kiếm, phân trang danh sách Map deck", position: 0 },
    { storyId: s.id, code: "US2", title: "Delete Map deck", description: "Xoá một hoặc nhiều Map deck, có xác nhận", position: 1 },
  ]);
  await db.insert(questions).values([
    { storyId: s.id, content: "Xoá Map deck là xoá mềm hay xoá vĩnh viễn?", askedTo: "BA", answer: "Xoá mềm, giữ 30 ngày trong thùng rác.", status: "answered", createdBy: userId },
    { storyId: s.id, content: "Deck đang được chia sẻ: chặn xoá hay chỉ cảnh báo?", askedTo: "PO", answer: "Cảnh báo, vẫn cho xoá.", status: "answered", createdBy: userId },
    { storyId: s.id, content: "Xoá hàng loạt tối đa bao nhiêu bản ghi?", askedTo: "PO", status: "open", createdBy: userId },
  ]);
  const tcs = await db
    .insert(testCases)
    .values(MAPDECK_TCS.map(([us, type, priority, title, pre, steps], i) => ({ storyId: s.id, seq: i + 1, usCode: us, type, priority, title, preconditions: pre, steps: steps.map(([action, expected]) => ({ action, expected })), source: "ai" as const, status: "approved" as const, createdBy: userId, approvedBy: userId })))
    .returning();
  const [b] = await db.insert(builds).values({ storyId: s.id, env: "dev", round: 1, name: "DEV-R1", createdBy: userId }).returning();
  const result: Record<number, ["passed" | "failed" | "blocked" | "not_run", string | null, string]> = {
    3: ["failed", null, "Nhập “hanoi” không ra kết quả, phải gõ đúng “Hanoi”"],
    6: ["blocked", "DEMO-22222", "API phân quyền chưa xong"],
    9: ["failed", null, "Popup xác nhận chung, không có cảnh báo chia sẻ"],
    11: ["blocked", "DEMO-22222", "API phân quyền chưa xong"],
    12: ["not_run", null, ""],
  };
  const now = new Date();
  const execs = await db
    .insert(executions)
    .values(tcs.map((t) => {
      const [status, key, notes] = result[t.seq] ?? ["passed", null, ""];
      return { buildId: b.id, testCaseId: t.id, status, linkedIssueKey: key, notes, executedBy: status === "not_run" ? null : userId, executedAt: status === "not_run" ? null : now };
    }))
    .returning();
  const execOf = (seq: number) => execs.find((e) => e.testCaseId === tcs.find((t) => t.seq === seq)!.id)!;
  const [bug1] = await db
    .insert(bugs)
    .values({ storyId: s.id, executionId: execOf(3).id, title: "[MapDeck][US1] Tìm kiếm phân biệt hoa thường", steps: "1. Mở danh sách Map deck\n2. Nhập “hanoi” vào ô tìm kiếm", actual: "Không có kết quả", expected: "Có “Hanoi Traffic”", severity: "major", env: "dev", status: "resolved", jiraStatus: "Resolved", source: "ai", createdBy: userId, fixCommits: [{ sha: "a3f9c21e7b", message: "DEMO fix search ilike", author: "Tuấn" }] })
    .returning();
  const [bug2] = await db
    .insert(bugs)
    .values({ storyId: s.id, executionId: execOf(9).id, title: "[MapDeck][US2] Không cảnh báo khi xoá deck đang chia sẻ", steps: "1. Chọn deck đang chia sẻ cho 3 user\n2. Bấm Xoá", actual: "Popup xác nhận chung, không có cảnh báo", expected: "Popup cảnh báo “đang được chia sẻ với 3 người” (Q2)", severity: "major", env: "dev", status: "in_progress", jiraStatus: "In Progress", source: "manual", createdBy: userId })
    .returning();
  const code = (id: string) => `LOCAL-${id.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
  await db.update(executions).set({ linkedIssueKey: code(bug1.id) }).where(eq(executions.id, execOf(3).id));
  await db.update(executions).set({ linkedIssueKey: code(bug2.id) }).where(eq(executions.id, execOf(9).id));
  await db.update(stories).set({ qaStage: "testing", currentEnv: "dev" }).where(eq(stories.id, s.id));
}

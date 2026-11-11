import { asc, eq, inArray } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { bugs, builds, executions, stories, testCases } from "@/lib/db/schema";
import { currentUser, currentProjectContext } from "@/lib/session";
import { can } from "@/lib/rbac";
import { currentSprint } from "@/lib/services/stories";
import { projectDashboard } from "@/lib/services/dashboard";
import { bugCode, SEVERITY_LABEL, BUG_STATUS_LABEL } from "@/lib/services/bugs";
import { ENV_LABEL } from "@/lib/services/execution";
import { STAGE_LABEL, fmtDateTime, tcCode } from "@/lib/format";
import { toCsv } from "@/lib/csv";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: Promise<{ kind: string }> }) {
  const { kind } = await ctx.params;
  const user = await currentUser();
  if (!user) return new Response("Chưa đăng nhập", { status: 401 });
  const db = await getDb();
  const pc = await currentProjectContext(user, db);
  if (!pc.project || !can({ isAdmin: user.isAdmin, role: pc.role }, "story.view")) return new Response("Không có quyền", { status: 403 });
  const sprint = await currentSprint(db, pc.project.id);
  const d = await projectDashboard(db, pc.project.id, sprint?.id ?? null);
  const storyIds = d.perStory.map((s) => s.id);
  let rows: (string | number | null)[][];

  if (kind === "stories") {
    rows = [["Story", "Tiêu đề", "Giai đoạn", "Môi trường", "TC trong phạm vi", "Passed", "Failed", "Blocked", "Chưa chạy", "Pass rate %", "Bug mở", "Q&A chưa trả lời", "Cần chú ý"]];
    for (const s of d.perStory) rows.push([s.key, s.summary, STAGE_LABEL[s.stage], ENV_LABEL[s.env], s.counts.total, s.counts.passed, s.counts.failed, s.counts.blocked, s.counts.notRun, s.counts.total ? s.rate : null, s.openBugs, s.qOpen, s.reasons.join("; ")]);
  } else if (kind === "results") {
    rows = [["Story", "Build", "Môi trường", "Loại build", "Test case", "Tiêu đề", "Kiểm thử", "Kết quả", "Ticket liên kết", "Ghi chú", "Người/nguồn", "Thời gian"]];
    const list = storyIds.length
      ? await db
          .select({ e: executions, b: builds, tc: testCases, s: stories })
          .from(executions)
          .innerJoin(builds, eq(builds.id, executions.buildId))
          .innerJoin(testCases, eq(testCases.id, executions.testCaseId))
          .innerJoin(stories, eq(stories.id, builds.storyId))
          .where(inArray(builds.storyId, storyIds))
          .orderBy(asc(stories.jiraKey), asc(builds.createdAt), asc(testCases.seq))
      : [];
    const label = { passed: "Passed", failed: "Failed", blocked: "Blocked", not_run: "Not test" } as const;
    for (const { e, b, tc, s } of list)
      rows.push([s.jiraKey, b.name, ENV_LABEL[b.env], b.kind === "regression" ? "Regression" : "Round", tcCode(tc.seq), tc.title, tc.kind === "api" ? "API" : "Giao diện", label[e.status], e.linkedIssueKey, e.notes, e.byAgent ? (e.agentSource === "auto" ? "Tự động" : "Antigravity") : "QC", e.executedAt ? fmtDateTime(e.executedAt) : null]);
  } else if (kind === "bugs") {
    rows = [["Bug", "Story", "Tiêu đề", "Severity", "Môi trường", "Trạng thái", "Trạng thái Jira", "Tạo lúc", "Resolved lúc", "Đóng lúc", "Commit fix"]];
    const list = storyIds.length ? await db.select({ b: bugs, s: stories }).from(bugs).innerJoin(stories, eq(stories.id, bugs.storyId)).where(inArray(bugs.storyId, storyIds)) : [];
    for (const { b, s } of list)
      rows.push([bugCode(b), s.jiraKey, b.title, SEVERITY_LABEL[b.severity], ENV_LABEL[b.env], BUG_STATUS_LABEL[b.status], b.jiraStatus, fmtDateTime(b.createdAt), b.resolvedAt ? fmtDateTime(b.resolvedAt) : null, b.closedAt ? fmtDateTime(b.closedAt) : null, b.fixCommits.map((c) => c.sha.slice(0, 8)).join(" ")]);
  } else {
    return new Response("Không có loại xuất này", { status: 404 });
  }
  const name = `${pc.project.key}-${kind}-${new Date().toISOString().slice(0, 10)}.csv`;
  return new Response(toCsv(rows), {
    headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="${name}"` },
  });
}

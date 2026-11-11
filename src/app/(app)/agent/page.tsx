import Link from "next/link";
import { and, desc, eq, inArray } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { auditLogs, autoRuns, builds, executions, stories, testCases, users } from "@/lib/db/schema";
import { requireUser, currentProjectContext } from "@/lib/session";
import { can } from "@/lib/rbac";
import { listBugs } from "@/lib/services/bugs";
import { fmtDateTime, tcCode } from "@/lib/format";
import { Flash } from "@/components/Flash";
import { SubmitButton } from "@/components/SubmitButton";
import { reviewAgentResultsAction } from "@/app/actions/qa";
import { approveTcAction } from "@/app/actions/story";

export default async function AgentPage({ searchParams }: PageProps<"/agent">) {
  const sp = await searchParams;
  const user = await requireUser();
  const db = await getDb();
  const ctx = await currentProjectContext(user, db);
  const actor = { isAdmin: user.isAdmin, role: ctx.role };
  if (!ctx.project || !can(actor, "story.view")) return <div className="empty">Chưa chọn dự án.</div>;
  const pid = ctx.project.id;
  const draftTcs = await db
    .select({ storyId: stories.id, storyKey: stories.jiraKey, summary: stories.summary, source: testCases.source, n: testCases.id })
    .from(testCases)
    .innerJoin(stories, eq(stories.id, testCases.storyId))
    .where(and(eq(stories.projectId, pid), eq(testCases.status, "draft")));
  const byStory = new Map<string, { storyId: string; storyKey: string; summary: string; ai: number; agent: number }>();
  for (const t of draftTcs) {
    const x = byStory.get(t.storyKey) ?? { storyId: t.storyId, storyKey: t.storyKey, summary: t.summary, ai: 0, agent: 0 };
    if (t.source === "agent") x.agent++;
    else x.ai++;
    byStory.set(t.storyKey, x);
  }
  const draftBugs = (await listBugs(db, { projectId: pid, statuses: ["draft"] })).filter((r) => r.bug.source !== "manual");
  const pendingExec = await db
    .select({ e: executions, b: builds, s: stories, tc: testCases })
    .from(executions)
    .innerJoin(builds, eq(builds.id, executions.buildId))
    .innerJoin(stories, eq(stories.id, builds.storyId))
    .innerJoin(testCases, eq(testCases.id, executions.testCaseId))
    .where(and(eq(stories.projectId, pid), eq(executions.byAgent, true), eq(executions.reviewed, false)));
  const log = await db
    .select({ at: auditLogs.at, action: auditLogs.action, target: auditLogs.target, name: users.name })
    .from(auditLogs)
    .leftJoin(users, eq(users.id, auditLogs.userId))
    .where(inArray(auditLogs.source, ["mcp"]))
    .orderBy(desc(auditLogs.at))
    .limit(30);
  const aiLog = await db
    .select({ at: auditLogs.at, action: auditLogs.action, target: auditLogs.target, name: users.name })
    .from(auditLogs)
    .leftJoin(users, eq(users.id, auditLogs.userId))
    .where(inArray(auditLogs.action, ["AI phân tích requirement", "AI sinh test case"]))
    .orderBy(desc(auditLogs.at))
    .limit(10);
  const runs = await db
    .select({ r: autoRuns, b: builds, s: stories })
    .from(autoRuns)
    .innerJoin(builds, eq(builds.id, autoRuns.buildId))
    .innerJoin(stories, eq(stories.id, builds.storyId))
    .where(eq(stories.projectId, pid))
    .orderBy(desc(autoRuns.startedAt))
    .limit(8);
  const total = byStory.size + draftBugs.length + pendingExec.length;
  const canApprove = can(actor, "tc.approve");

  return (
    <>
      <div className="sh">
        <div>
          <h1>AI Agent</h1>
          <p>Mọi thứ AI tạo (Gemini trong tool, hoặc Antigravity qua MCP) nằm ở đây chờ QC duyệt trước khi dùng hoặc gửi đi.</p>
        </div>
        <Link className="btn" href="/profile#mcp">
          Kết nối Antigravity
        </Link>
      </div>
      <Flash ok={sp.ok} err={sp.err} />
      <div className="grid2">
        <div className="stack">
          <div className="card">
            <h2>Chờ duyệt ({total})</h2>
            {total === 0 && <p className="small muted">Không có gì chờ duyệt.</p>}
            {[...byStory.values()].map((x) => (
              <div className="inline" key={x.storyKey}>
                <span style={{ flex: 1 }}>
                  <b>{x.ai + x.agent} test case nháp</b> · <Link href={`/stories/${x.storyKey}#testcases`}>{x.storyKey}</Link> {x.summary}
                  <br />
                  <span className="small muted">
                    {x.ai ? `${x.ai} do Gemini` : ""}
                    {x.ai && x.agent ? " · " : ""}
                    {x.agent ? `${x.agent} do Antigravity` : ""}
                  </span>
                </span>
                {canApprove && (
                  <form action={approveTcAction}>
                    <input type="hidden" name="storyId" value={x.storyId} />
                    <input type="hidden" name="key" value={x.storyKey} />
                    <input type="hidden" name="all" value="1" />
                    <SubmitButton className="btn sm pri">Duyệt tất cả</SubmitButton>
                  </form>
                )}
                <Link className="btn sm" href={`/stories/${x.storyKey}#testcases`}>
                  Xem
                </Link>
              </div>
            ))}
            {draftBugs.map(({ bug, storyKey }) => (
              <div className="inline" key={bug.id}>
                <span style={{ flex: 1 }}>
                  <b>Nháp bug</b> · {bug.title}
                  <br />
                  <span className="small muted">
                    {storyKey} · {bug.source === "agent" ? "Antigravity" : "Gemini"} · {fmtDateTime(bug.createdAt)}
                  </span>
                </span>
                <Link className="btn sm" href={`/stories/${storyKey}/bugs?edit=${bug.id}#edit`}>
                  Xem và tạo
                </Link>
              </div>
            ))}
            {pendingExec.length > 0 && (
              <form action={reviewAgentResultsAction} style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                <input type="hidden" name="back" value="/agent" />
                <h3>Kết quả test do Antigravity ghi ({pendingExec.length})</h3>
                {pendingExec.map(({ e, b, s, tc }) => (
                  <label key={e.id} className="check small">
                    <input type="checkbox" name="executionId" value={e.id} defaultChecked />
                    <span>
                      <b>{e.status}</b> · {s.jiraKey} {b.name} {tcCode(tc.seq)} {tc.title}
                      {e.notes ? ` · “${e.notes}”` : ""}{" "}
                      <Link href={`/stories/${s.jiraKey}/run?build=${b.id}#e-${e.id}`}>Mở</Link>
                    </span>
                  </label>
                ))}
                {canApprove && (
                  <div>
                    <SubmitButton className="btn pri sm">Duyệt các kết quả đã chọn</SubmitButton>
                  </div>
                )}
              </form>
            )}
          </div>
        </div>
        <div className="stack">
        <div className="card">
          <h2>Chạy tự động gần đây</h2>
          {runs.length === 0 ? (
            <p className="small muted">Chưa có. Vào một story → Thực thi → Chạy tự động.</p>
          ) : (
            <ul className="list small">
              {runs.map(({ r, b, s: st }) => (
                <li key={r.id}>
                  <Link href={`/stories/${st.jiraKey}/run?build=${b.id}#autorun`}>
                    {st.jiraKey} {b.name}
                  </Link>{" "}
                  · {fmtDateTime(r.startedAt)} ·{" "}
                  {r.status === "running" || r.status === "queued" ? `đang chạy ${r.done}/${r.total}` : r.status === "done" ? `${r.passed} passed, ${r.failed} failed, ${r.blocked} blocked` : r.status === "cancelled" ? "đã huỷ" : `lỗi: ${r.error ?? ""}`}
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="card">
          <h2>Nhật ký Antigravity (MCP)</h2>
          {log.length === 0 ? (
            <p className="small muted">Chưa có lần gọi nào. Tạo token ở Hồ sơ rồi thêm MCP server vào Antigravity.</p>
          ) : (
            <ul className="list small">
              {log.map((l, i) => (
                <li key={i}>
                  <span className="mono muted">{fmtDateTime(l.at)}</span> · {l.name} · {l.action} {l.target ? `· ${l.target}` : ""}
                </li>
              ))}
            </ul>
          )}
          <h3>Lần chạy Gemini gần đây</h3>
          {aiLog.length === 0 ? (
            <p className="small muted">Chưa có.</p>
          ) : (
            <ul className="list small">
              {aiLog.map((l, i) => (
                <li key={i}>
                  <span className="mono muted">{fmtDateTime(l.at)}</span> · {l.name} · {l.action} · {l.target}
                </li>
              ))}
            </ul>
          )}
        </div>
        </div>
      </div>
    </>
  );
}

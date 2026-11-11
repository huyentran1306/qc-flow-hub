import Link from "next/link";
import { can } from "@/lib/rbac";
import { loadStoryPage } from "@/lib/storyPage";
import { listConnections } from "@/lib/services/connections";
import { buildProblems, buildRows, countStatuses, envScope, storyBuilds, ENV_LABEL } from "@/lib/services/execution";
import { evidenceOf } from "@/lib/services/bugs";
import { tcCode, fmtDateTime } from "@/lib/format";
import { Flash } from "@/components/Flash";
import { StoryHeader } from "@/components/StoryHeader";
import { SubmitButton } from "@/components/SubmitButton";
import { EvidenceList } from "@/components/Evidence";
import { FilePicker } from "@/components/FilePicker";
import { createBuildAction, setResultAction, pushResultsAction, refreshBlockersAction, newBugFromExecutionAction, reviewAgentResultsAction } from "@/app/actions/qa";
import type { ExecStatus } from "@/lib/db/schema";

const STATUS_LABEL: Record<ExecStatus, string> = { passed: "Passed", failed: "Failed", blocked: "Blocked", not_run: "Not test" };

export default async function RunPage({ params, searchParams }: PageProps<"/stories/[key]/run">) {
  const { key } = await params;
  const sp = await searchParams;
  const { db, data, role, actor, allowed } = await loadStoryPage(key);
  const { story, project, testCases } = data;
  if (!allowed) return <div className="flash err">Bạn không thuộc dự án {project.key}.</div>;
  const conns = await listConnections(db);
  const canRun = can(actor, "tc.edit");
  const all = await storyBuilds(db, story.id);
  const selected = all.find((b) => b.id === sp.build) ?? all.find((b) => b.env === story.currentEnv) ?? all[0];
  const rows = selected ? await buildRows(db, selected.id) : [];
  const ev = await evidenceOf(db, "execution", rows.map((r) => r.e.id));
  const c = countStatuses(rows.map((r) => r.e));
  const problems = buildProblems(rows);
  const scopeNow = envScope(testCases, story.currentEnv).length;
  const hidden = (
    <>
      <input type="hidden" name="storyId" value={story.id} />
      <input type="hidden" name="key" value={story.jiraKey} />
    </>
  );
  const unreviewed = rows.filter((r) => r.e.byAgent && !r.e.reviewed).map((r) => r.e.id);

  return (
    <>
      <StoryHeader story={story} role={role} tab="/run" />
      <Flash ok={sp.ok} err={sp.err} />

      {all.length > 0 && (
        <div className="buildbar">
          <span className="lbl">Build</span>
          {all.map((b) => (
            <Link key={b.id} href={`/stories/${story.jiraKey}/run?build=${b.id}`} className={`btn sm${b.id === selected?.id ? " pri" : ""}`}>
              {b.name}
            </Link>
          ))}
        </div>
      )}

      {!selected ? (
        <div className="empty">
          <span>
            Chưa có build nào. Build đầu tiên ở {ENV_LABEL[story.currentEnv]} sẽ gồm {scopeNow} test case{story.currentEnv === "prod" ? " Happy" : ""} đã duyệt.
          </span>
          {canRun && scopeNow > 0 && (
            <form action={createBuildAction}>
              {hidden}
              <input type="hidden" name="env" value={story.currentEnv} />
              <SubmitButton className="btn pri">Tạo build {ENV_LABEL[story.currentEnv]} round 1</SubmitButton>
            </form>
          )}
          {scopeNow === 0 && <Link href={`/stories/${story.jiraKey}#testcases`}>Duyệt test case trước</Link>}
        </div>
      ) : (
        <>
          <div className="card">
            <h2>
              <span>
                {selected.name} <span className="small muted">· {ENV_LABEL[selected.env]} · tạo {fmtDateTime(selected.createdAt)}</span>
              </span>
              <span className="actions">
                {canRun && selected.env === story.currentEnv && story.qaStage !== "done" && (
                  <form action={createBuildAction}>
                    {hidden}
                    <input type="hidden" name="env" value={selected.env} />
                    <SubmitButton className="btn">Tạo round tiếp theo</SubmitButton>
                  </form>
                )}
                {conns.jira && !project.isDemo && (
                  <form action={refreshBlockersAction}>
                    {hidden}
                    <input type="hidden" name="buildId" value={selected.id} />
                    <SubmitButton className="btn" pendingText="Đang kiểm tra…">
                      Kiểm tra ticket chặn
                    </SubmitButton>
                  </form>
                )}
                {can(actor, "testlink.push") && !project.isDemo && (
                  <form action={pushResultsAction}>
                    {hidden}
                    <input type="hidden" name="buildId" value={selected.id} />
                    <SubmitButton className="btn pri" pendingText="Đang gửi…">
                      Gửi kết quả lên TestLink
                    </SubmitButton>
                  </form>
                )}
                <Link className="btn" href={`/stories/${story.jiraKey}/reports?build=${selected.id}`}>
                  Báo cáo
                </Link>
              </span>
            </h2>
            <div className="small num">
              <b style={{ color: "var(--pass)" }}>{c.passed} Passed</b> · <b style={{ color: "var(--fail)" }}>{c.failed} Failed</b> · <b style={{ color: "var(--block)" }}>{c.blocked} Blocked</b> · <b>{c.notRun} Not test</b> · Pass rate{" "}
              {c.total ? Math.round((c.passed / c.total) * 100) : 0}%
            </div>
            <div className="stackbar" role="img" aria-label={`Passed ${c.passed}, Failed ${c.failed}, Blocked ${c.blocked}, Not test ${c.notRun}`}>
              <span style={{ width: `${(c.passed / (c.total || 1)) * 100}%`, background: "var(--pass)" }} />
              <span style={{ width: `${(c.failed / (c.total || 1)) * 100}%`, background: "var(--fail)" }} />
              <span style={{ width: `${(c.blocked / (c.total || 1)) * 100}%`, background: "var(--block)" }} />
            </div>
            <div className="legend">
              <span>
                <i style={{ background: "var(--pass)" }} />
                Passed
              </span>
              <span>
                <i style={{ background: "var(--fail)" }} />
                Failed
              </span>
              <span>
                <i style={{ background: "var(--block)" }} />
                Blocked
              </span>
              <span>Mẹo: sửa ghi chú, ticket hoặc thêm file rồi bấm lại đúng kết quả hiện tại để lưu.</span>
            </div>
            {problems.length > 0 && (
              <ul className="list small" style={{ color: "var(--block)" }}>
                {problems.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
            )}
            {unreviewed.length > 0 && can(actor, "tc.approve") && (
              <form action={reviewAgentResultsAction} className="inline">
                <input type="hidden" name="back" value={`/stories/${story.jiraKey}/run?build=${selected.id}`} />
                {unreviewed.map((id) => (
                  <input key={id} type="hidden" name="executionId" value={id} />
                ))}
                <span className="ai-label">{unreviewed.length} kết quả do Antigravity ghi, chờ bạn xem lại</span>
                <SubmitButton className="btn sm">Duyệt tất cả</SubmitButton>
              </form>
            )}
          </div>

          <div className="tbl-wrap">
            <table>
              <thead>
                <tr>
                  <th>Test case</th>
                  <th>Kết quả và ghi chú</th>
                  <th>Bug / ticket chặn</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(({ e, tc }) => {
                  const files = ev.filter((x) => x.ownerId === e.id);
                  return (
                    <tr key={e.id} id={`e-${e.id}`}>
                      <td style={{ minWidth: 240 }}>
                        <details>
                          <summary style={{ cursor: "pointer" }}>
                            <span className="key">{tcCode(tc.seq)}</span> {tc.title}
                          </summary>
                          {tc.preconditions && <p className="small muted">Điều kiện: {tc.preconditions}</p>}
                          <ol className="steps small">
                            {tc.steps.map((s, i) => (
                              <li key={i}>
                                {s.action}
                                <br />
                                <span>→ {s.expected}</span>
                              </li>
                            ))}
                          </ol>
                        </details>
                        <span className="small muted">
                          {tc.usCode} · {tc.type}
                          {e.byAgent && <span className="pill p-ai"> Agent{e.reviewed ? "" : " · chờ duyệt"}</span>}
                        </span>
                      </td>
                      <td style={{ minWidth: 320 }}>
                        {canRun ? (
                          <form action={setResultAction} className="execform">
                            <input type="hidden" name="key" value={story.jiraKey} />
                            <input type="hidden" name="buildId" value={selected.id} />
                            <input type="hidden" name="executionId" value={e.id} />
                            <div className="res" role="group" aria-label={`Kết quả ${tcCode(tc.seq)}`}>
                              {(["passed", "failed", "blocked", "not_run"] as ExecStatus[]).map((st) => (
                                <button key={st} type="submit" name="status" value={st} className={`r-${st}`} aria-pressed={e.status === st}>
                                  {STATUS_LABEL[st]}
                                </button>
                              ))}
                            </div>
                            <div className="rowx">
                              <input name="notes" defaultValue={e.notes} placeholder="Ghi chú: thực tế quan sát được" aria-label="Ghi chú" />
                              {(e.status === "blocked" || e.status === "failed") && (
                                <input
                                  name="linkedIssueKey"
                                  defaultValue={e.linkedIssueKey ?? ""}
                                  placeholder={e.status === "blocked" ? "Ticket chặn, vd OP-22222" : "Mã bug, vd OP-111111"}
                                  aria-label="Ticket liên kết"
                                />
                              )}
                            </div>
                            <FilePicker />
                          </form>
                        ) : (
                          <span className={`pill ${e.status === "passed" ? "p-pass" : e.status === "failed" ? "p-fail" : e.status === "blocked" ? "p-block" : "p-nr"}`}>{STATUS_LABEL[e.status]}</span>
                        )}
                        <EvidenceList items={files} />
                      </td>
                      <td style={{ minWidth: 200 }}>
                        {e.linkedIssueKey && <span className="key">{e.linkedIssueKey}</span>}
                        {e.blockerDone && (
                          <div>
                            <span className="pill p-pass">Ticket chặn đã xong, cần retest</span>
                          </div>
                        )}
                        {e.status === "failed" && !e.linkedIssueKey && canRun && (
                          <div className="actions" style={{ marginTop: 6 }}>
                            <form action={newBugFromExecutionAction}>
                              <input type="hidden" name="key" value={story.jiraKey} />
                              <input type="hidden" name="executionId" value={e.id} />
                              <SubmitButton className="btn sm">Log bug</SubmitButton>
                            </form>
                            <form action={newBugFromExecutionAction}>
                              <input type="hidden" name="key" value={story.jiraKey} />
                              <input type="hidden" name="executionId" value={e.id} />
                              <input type="hidden" name="ai" value="1" />
                              <SubmitButton className="btn sm ai" pendingText="AI đang viết…">
                                AI viết bug
                              </SubmitButton>
                            </form>
                          </div>
                        )}
                        {e.pushedAt && <div className="small muted">Đã gửi TestLink {fmtDateTime(e.pushedAt)}</div>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </>
  );
}

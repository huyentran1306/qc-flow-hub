import { can } from "@/lib/rbac";
import { loadStoryPage } from "@/lib/storyPage";
import { isQcSubtask, isSubBug } from "@/lib/services/stories";
import { listConnections } from "@/lib/services/connections";
import { stepsToText } from "@/lib/services/testcases";
import { questionCode } from "@/lib/services/questions";
import { acMatrix } from "@/lib/services/coverage";
import { aiCoverageAction, addCoverageSuggestionsAction } from "@/app/actions/extra";
import { fmtDateTime, tcCode } from "@/lib/format";
import { Flash } from "@/components/Flash";
import { StoryHeader } from "@/components/StoryHeader";
import { SubmitButton } from "@/components/SubmitButton";
import {
  analyzeAction,
  generateTcAction,
  addQuestionAction,
  publishQuestionAction,
  answerQuestionAction,
  deleteQuestionAction,
  syncRepliesAction,
  approveTcAction,
  deleteTcAction,
  saveTcAction,
  pushTestlinkAction,
} from "@/app/actions/story";
import type { testCases } from "@/lib/db/schema";

const TYPE_CLASS = { happy: "p-pass", negative: "p-fail", edge: "p-block" } as const;
const TYPE_LABEL = { happy: "Happy", negative: "Negative", edge: "Edge" } as const;
const PRIO_LABEL = { high: "Cao", medium: "Trung bình", low: "Thấp" } as const;

function TcFields({ tc, usCodes, idp }: { tc?: typeof testCases.$inferSelect; usCodes: string[]; idp: string }) {
  const codes = usCodes.length ? usCodes : ["US1"];
  return (
    <>
      <label className="full" htmlFor={`${idp}-title`}>
        Tiêu đề
        <input id={`${idp}-title`} name="title" defaultValue={tc?.title} required />
      </label>
      <label htmlFor={`${idp}-us`}>
        User Story
        <select id={`${idp}-us`} name="usCode" defaultValue={tc?.usCode ?? codes[0]}>
          {[...new Set([...codes, ...(tc ? [tc.usCode] : [])])].map((c) => (
            <option key={c}>{c}</option>
          ))}
        </select>
      </label>
      <div className="inline">
        <label htmlFor={`${idp}-type`} className="field" style={{ flex: 1 }}>
          Loại
          <select id={`${idp}-type`} name="type" defaultValue={tc?.type ?? "happy"}>
            <option value="happy">Happy</option>
            <option value="negative">Negative</option>
            <option value="edge">Edge</option>
          </select>
        </label>
        <label htmlFor={`${idp}-kind`} className="field" style={{ flex: 1 }}>
          Kiểm thử
          <select id={`${idp}-kind`} name="kind" defaultValue={tc?.kind ?? "ui"}>
            <option value="ui">Giao diện</option>
            <option value="api">API</option>
          </select>
        </label>
        <label htmlFor={`${idp}-prio`} className="field" style={{ flex: 1 }}>
          Ưu tiên
          <select id={`${idp}-prio`} name="priority" defaultValue={tc?.priority ?? "medium"}>
            <option value="high">Cao</option>
            <option value="medium">Trung bình</option>
            <option value="low">Thấp</option>
          </select>
        </label>
      </div>
      <label className="full" htmlFor={`${idp}-pre`}>
        Điều kiện trước
        <input id={`${idp}-pre`} name="preconditions" defaultValue={tc?.preconditions} />
      </label>
      <label className="full" htmlFor={`${idp}-steps`}>
        Các bước <span className="hint">mỗi dòng một bước, dạng: hành động =&gt; kết quả mong đợi</span>
        <textarea id={`${idp}-steps`} name="steps" rows={Math.max(3, (tc?.steps.length ?? 2) + 1)} defaultValue={tc ? stepsToText(tc.steps) : ""} required />
      </label>
    </>
  );
}

export default async function StoryPage({ params, searchParams }: PageProps<"/stories/[key]">) {
  const { key } = await params;
  const sp = await searchParams;
  const { db, user, data, role, actor, allowed, owner } = await loadStoryPage(key);
  const { story, project, userStories, questions, testCases: tcs } = data;
  if (!allowed) {
    return <div className="flash err">Bạn không thuộc dự án {project.key} nên không xem được story này.</div>;
  }
  const conns = await listConnections(db);
  const jiraUrl = !project.isDemo && conns.jira?.config.baseUrl ? `${conns.jira.config.baseUrl.replace(/\/+$/, "")}/browse/${story.jiraKey}` : null;
  const drafts = tcs.filter((t) => t.status === "draft");
  const approved = tcs.filter((t) => t.status === "approved");
  const notPushed = approved.filter((t) => !t.testlinkId).length;
  const usCodes = userStories.map((u) => u.code);
  const matrix = acMatrix(story.description, tcs);
  const hidden = (
    <>
      <input type="hidden" name="storyId" value={story.id} />
      <input type="hidden" name="key" value={story.jiraKey} />
    </>
  );

  const tcRow = (tc: typeof testCases.$inferSelect) => (
    <details className="tc" key={tc.id}>
      <summary>
        {tc.status === "draft" && can(actor, "tc.approve") ? (
          <input type="checkbox" name="tcId" value={tc.id} form="bulk-approve" aria-label={`Chọn ${tcCode(tc.seq)}`} />
        ) : (
          <span />
        )}
        <span className="key">{tcCode(tc.seq)}</span>
        <span>
          {tc.title}
          <br />
          <span className="small muted">
            {tc.usCode} · {PRIO_LABEL[tc.priority]}
            {tc.requirementRef ? ` · ${tc.requirementRef}` : ""}
            {tc.testlinkExternalId ? ` · TestLink ${tc.testlinkExternalId}` : tc.testlinkId ? " · đã có trên TestLink" : ""}
          </span>
        </span>
        <span className="inline">
          {tc.kind === "api" && <span className="tag">API</span>}
          <span className={`pill ${TYPE_CLASS[tc.type]}`}>{TYPE_LABEL[tc.type]}</span>
          {tc.source === "ai" ? <span className="pill p-ai">AI</span> : <span className="tag">Thủ công</span>}
        </span>
      </summary>
      <div className="body">
        {tc.preconditions && (
          <p className="small">
            <b>Điều kiện trước:</b> {tc.preconditions}
          </p>
        )}
        <ol className="steps">
          {tc.steps.map((s, i) => (
            <li key={i}>
              {s.action}
              <br />
              <span>→ {s.expected}</span>
            </li>
          ))}
        </ol>
        <div className="actions">
          {tc.status === "draft" && can(actor, "tc.approve") && (
            <form action={approveTcAction}>
              {hidden}
              <input type="hidden" name="tcId" value={tc.id} />
              <SubmitButton className="btn pri sm">Duyệt</SubmitButton>
            </form>
          )}
          {can(actor, "tc.edit") && !tc.testlinkId && (
            <form action={deleteTcAction}>
              {hidden}
              <input type="hidden" name="tcId" value={tc.id} />
              <SubmitButton className="btn sm danger">{tc.status === "draft" ? "Bỏ nháp" : "Xoá"}</SubmitButton>
            </form>
          )}
        </div>
        {can(actor, "tc.edit") && (
          <details>
            <summary className="small" style={{ cursor: "pointer", color: "var(--accent)" }}>
              Sửa test case
            </summary>
            <form action={saveTcAction} className="form" style={{ marginTop: 10 }}>
              {hidden}
              <input type="hidden" name="tcId" value={tc.id} />
              <TcFields tc={tc} usCodes={usCodes} idp={`e-${tc.id}`} />
              <div className="full actions">
                <SubmitButton className="btn pri sm">Lưu</SubmitButton>
                {tc.testlinkId && <span className="small muted">Lưu ở đây không tự cập nhật lên TestLink.</span>}
              </div>
            </form>
          </details>
        )}
      </div>
    </details>
  );

  return (
    <>
      <StoryHeader story={story} role={role} tab="" jiraUrl={jiraUrl} owner={owner} meId={user.id} />
      <Flash ok={sp.ok} err={sp.err} />

      <div className="grid2">
        <div className="stack">
          <div className="card">
            <h2>Requirement từ Jira</h2>
            <div className="pre small">{story.description || <span className="muted">Ticket chưa có mô tả.</span>}</div>
          </div>
          <div className="card">
            <h2>Subtask</h2>
            {story.subtasks.length === 0 ? (
              <p className="small muted">Chưa có subtask.</p>
            ) : (
              <div className="tbl-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Loại</th>
                      <th>Ticket</th>
                      <th>Tiêu đề</th>
                      <th>Trạng thái</th>
                    </tr>
                  </thead>
                  <tbody>
                    {story.subtasks.map((s) => (
                      <tr key={s.key}>
                        <td>
                          <span className="tag">{isSubBug(s, project.mapping) ? "Sub-bug" : isQcSubtask(s, project.mapping) ? "QC" : "Dev"}</span>
                        </td>
                        <td className="key">{s.key}</td>
                        <td>{s.summary}</td>
                        <td className="small">{s.status}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>

        <div className="stack">
          <div className="card aiz" id="analysis">
            <h2>
              <span className="ai-label">AI phân tích requirement</span>
              {can(actor, "ai.run") && (
                <form action={analyzeAction}>
                  {hidden}
                  <SubmitButton className="btn ai sm" pendingText="AI đang đọc ticket…">
                    {story.analysis ? "Phân tích lại" : "Phân tích"}
                  </SubmitButton>
                </form>
              )}
            </h2>
            {userStories.length > 0 && (
              <>
                <h3>User Story</h3>
                <ul className="list">
                  {userStories.map((u) => (
                    <li key={u.id}>
                      <b>{u.code}</b> · {u.title}
                      {u.description && <div className="small muted">{u.description}</div>}
                    </li>
                  ))}
                </ul>
              </>
            )}
            {story.analysis ? (
              <>
                {story.analysis.testPoints.length > 0 && (
                  <>
                    <h3>Điểm cần test</h3>
                    <ul className="list">
                      {story.analysis.testPoints.map((t, i) => (
                        <li key={i}>{t}</li>
                      ))}
                    </ul>
                  </>
                )}
                {story.analysis.dependencies.length > 0 && (
                  <>
                    <h3>Phụ thuộc</h3>
                    <ul className="list">
                      {story.analysis.dependencies.map((t, i) => (
                        <li key={i}>{t}</li>
                      ))}
                    </ul>
                  </>
                )}
                {story.analysis.risks.length > 0 && (
                  <>
                    <h3>Rủi ro</h3>
                    <ul className="list">
                      {story.analysis.risks.map((t, i) => (
                        <li key={i}>{t}</li>
                      ))}
                    </ul>
                  </>
                )}
                <p className="small muted">
                  {story.analysis.model} · {fmtDateTime(story.analysis.at)}. Kết quả AI chỉ để tham khảo, QC kiểm tra lại trước khi dùng.
                </p>
              </>
            ) : (
              <p className="small muted">Chưa phân tích. AI sẽ tách User Story, liệt kê điểm cần test và đề xuất câu hỏi Q&amp;A.</p>
            )}
          </div>

          <div className="card" id="qna">
            <h2>
              Q&amp;A với BA / PO
              {can(actor, "qna.manage") && !project.isDemo && conns.jira && questions.some((q) => q.jiraCommentId && q.status !== "answered") && (
                <form action={syncRepliesAction}>
                  {hidden}
                  <SubmitButton className="btn sm" pendingText="Đang đọc comment…">
                    Lấy trả lời từ Jira
                  </SubmitButton>
                </form>
              )}
            </h2>
            {questions.length === 0 && <p className="small muted">Chưa có câu hỏi.</p>}
            {questions.map((q, i) => (
              <div className="qa" key={q.id}>
                <span className="small">
                  <b>Q{i + 1}.</b> {q.content}
                </span>
                {q.status === "answered" ? (
                  <>
                    <span className="small muted">Trả lời: {q.answer}</span>
                    <span>
                      <span className="pill p-pass">Đã trả lời</span>
                    </span>
                  </>
                ) : q.status === "draft" ? (
                  <>
                    <span>
                      <span className="pill p-ai">Nháp do AI đề xuất</span>
                    </span>
                    {can(actor, "qna.manage") && (
                      <div className="inline">
                        <form action={publishQuestionAction} className="inline" style={{ flex: 1 }}>
                          <input type="hidden" name="key" value={story.jiraKey} />
                          <input type="hidden" name="questionId" value={q.id} />
                          <input name="askedTo" placeholder="Hỏi ai? (vd. BA Lan)" aria-label="Người được hỏi" />
                          {!project.isDemo && (
                            <label className="check small">
                              <input type="checkbox" name="toJira" value="1" defaultChecked={conns.jira?.status === "ok"} /> Gửi lên Jira
                            </label>
                          )}
                          <SubmitButton className="btn sm">Mở câu hỏi</SubmitButton>
                        </form>
                        <form action={deleteQuestionAction}>
                          <input type="hidden" name="key" value={story.jiraKey} />
                          <input type="hidden" name="questionId" value={q.id} />
                          <SubmitButton className="btn sm danger">Bỏ</SubmitButton>
                        </form>
                      </div>
                    )}
                  </>
                ) : (
                  <>
                    <span>
                      <span className="pill p-block">Chờ trả lời{q.askedTo ? ` · ${q.askedTo}` : ""}</span>
                      {q.jiraCommentId && <span className="small muted"> · đã gửi Jira, mã {questionCode(q.id)}</span>}
                    </span>
                    {q.jiraReply && (
                      <div className="small" style={{ borderLeft: "3px solid var(--accent)", paddingLeft: 8 }}>
                        Trả lời trên Jira{q.jiraReplyAuthor ? ` (${q.jiraReplyAuthor})` : ""}: {q.jiraReply}
                        {can(actor, "qna.answer") && (
                          <form action={answerQuestionAction} style={{ marginTop: 4 }}>
                            <input type="hidden" name="key" value={story.jiraKey} />
                            <input type="hidden" name="questionId" value={q.id} />
                            <input type="hidden" name="answer" value={q.jiraReply} />
                            <SubmitButton className="btn sm pri">Dùng câu trả lời này</SubmitButton>
                          </form>
                        )}
                      </div>
                    )}
                    {can(actor, "qna.answer") && (
                      <form action={answerQuestionAction} className="inline">
                        <input type="hidden" name="key" value={story.jiraKey} />
                        <input type="hidden" name="questionId" value={q.id} />
                        <input name="answer" placeholder="Ghi câu trả lời của BA/PO" aria-label="Câu trả lời" required />
                        <SubmitButton className="btn sm">Lưu</SubmitButton>
                      </form>
                    )}
                  </>
                )}
              </div>
            ))}
            {can(actor, "qna.manage") && (
              <form action={addQuestionAction} className="inline" style={{ borderTop: "1px solid var(--line)", paddingTop: 10 }}>
                {hidden}
                <input name="content" placeholder="Thêm câu hỏi mới" aria-label="Câu hỏi mới" required />
                <input name="askedTo" placeholder="Hỏi ai?" aria-label="Người được hỏi" style={{ maxWidth: 160 }} />
                <SubmitButton className="btn sm">Thêm</SubmitButton>
              </form>
            )}
          </div>
        </div>
      </div>

      <div className="card" id="coverage">
        <h2>
          <span>
            Độ phủ yêu cầu <span className="small muted">· AC trong mô tả ↔ test case đã duyệt (theo cột Ref)</span>
          </span>
          {can(actor, "ai.run") && (
            <form action={aiCoverageAction}>
              {hidden}
              <SubmitButton className="btn ai sm" pendingText="AI đang đối chiếu…">
                AI kiểm tra độ phủ
              </SubmitButton>
            </form>
          )}
        </h2>
        {matrix.length === 0 ? (
          <p className="small muted">Mô tả không có dòng dạng “AC-1: …” nên chưa lập được ma trận. Dùng nút AI kiểm tra độ phủ để AI tự đọc requirement.</p>
        ) : (
          <div className="tbl-wrap">
            <table>
              <thead>
                <tr>
                  <th>AC</th>
                  <th>Nội dung</th>
                  <th>Test case</th>
                </tr>
              </thead>
              <tbody>
                {matrix.map((m) => (
                  <tr key={m.code}>
                    <td className="key">{m.code}</td>
                    <td className="small">{m.text}</td>
                    <td className="small">{m.tcs.length ? <span className="cov-ok">✓ {m.tcs.join(", ")}</span> : <span className="cov-miss">Chưa có TC ghi Ref {m.code}</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {story.coverage && (
          <>
            <h3>
              AI đánh giá · {story.coverage.model} · {fmtDateTime(story.coverage.at)}
            </h3>
            <div className="tbl-wrap">
              <table>
                <tbody>
                  {story.coverage.items.map((it, i) => (
                    <tr key={i}>
                      <td style={{ width: 110 }}>
                        <span className={`pill ${it.status === "covered" ? "p-pass" : it.status === "partial" ? "p-block" : "p-fail"}`}>
                          {it.status === "covered" ? "Đủ" : it.status === "partial" ? "Chưa đủ" : "Thiếu"}
                        </span>
                      </td>
                      <td className="small">
                        {it.requirement}
                        {it.note && <div className="muted">{it.note}</div>}
                      </td>
                      <td className="small">{it.coveredBy.join(", ") || "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {story.coverage.suggestions.length > 0 && can(actor, "tc.edit") && (
              <form action={addCoverageSuggestionsAction} className="inline">
                {hidden}
                <span className="small">
                  AI gợi ý {story.coverage.suggestions.length} test case cho chỗ còn thiếu: {story.coverage.suggestions.map((x) => x.title).slice(0, 3).join("; ")}
                  {story.coverage.suggestions.length > 3 ? "…" : ""}
                </span>
                <SubmitButton className="btn sm pri">Thêm thành nháp</SubmitButton>
              </form>
            )}
          </>
        )}
      </div>

      <div className="card" id="testcases">
        <h2>
          <span>
            Test case <span className="small muted">· {approved.length} đã duyệt, {drafts.length} nháp</span>
          </span>
          <span className="actions">
            {can(actor, "ai.run") && (
              <form action={generateTcAction}>
                {hidden}
                <SubmitButton className="btn ai" pendingText="AI đang viết test case…">
                  AI sinh test case
                </SubmitButton>
              </form>
            )}
            <a className="btn" href={`/stories/${story.jiraKey}/testlink.xml`}>
              Tải XML TestLink
            </a>
            {can(actor, "testlink.push") && !project.isDemo && (
              <form action={pushTestlinkAction}>
                {hidden}
                <SubmitButton className="btn pri" pendingText="Đang đẩy…">
                  Đẩy lên TestLink{notPushed ? ` (${notPushed})` : ""}
                </SubmitButton>
              </form>
            )}
          </span>
        </h2>
        {userStories.length === 0 && can(actor, "ai.run") && (
          <p className="small muted">Nên chạy AI phân tích trước để có danh sách User Story, test case sẽ được gắn đúng US.</p>
        )}

        {drafts.length > 0 && (
          <>
            <div className="sh" style={{ alignItems: "center" }}>
              <h3>
                <span className="ai-label">Nháp chờ duyệt ({drafts.length})</span>
              </h3>
              {can(actor, "tc.approve") && (
                <div className="actions">
                  <form action={approveTcAction} id="bulk-approve">
                    {hidden}
                    <SubmitButton className="btn sm">Duyệt các TC đã chọn</SubmitButton>
                  </form>
                  <form action={approveTcAction}>
                    {hidden}
                    <input type="hidden" name="all" value="1" />
                    <SubmitButton className="btn sm pri">Duyệt tất cả nháp</SubmitButton>
                  </form>
                </div>
              )}
            </div>
            <div className="tbl-wrap">{drafts.map(tcRow)}</div>
          </>
        )}

        <h3>Đã duyệt ({approved.length})</h3>
        {approved.length ? <div className="tbl-wrap">{approved.map(tcRow)}</div> : <p className="small muted">Chưa có test case nào được duyệt.</p>}

        {can(actor, "tc.edit") && (
          <details>
            <summary className="btn" style={{ width: "fit-content" }}>
              + Thêm test case thủ công
            </summary>
            <form action={saveTcAction} className="form" style={{ marginTop: 12 }}>
              {hidden}
              <TcFields usCodes={usCodes} idp="new" />
              <div className="full">
                <SubmitButton className="btn pri">Thêm</SubmitButton>
              </div>
            </form>
          </details>
        )}
      </div>
    </>
  );
}

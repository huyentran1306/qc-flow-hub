import { can } from "@/lib/rbac";
import { loadStoryPage } from "@/lib/storyPage";
import { listBugs, evidenceOf, bugCode, SEVERITY_LABEL, BUG_STATUS_LABEL } from "@/lib/services/bugs";
import { similarBugs } from "@/lib/services/similar";
import { ENV_LABEL } from "@/lib/services/execution";
import { fmtDateTime } from "@/lib/format";
import { Flash } from "@/components/Flash";
import { StoryHeader } from "@/components/StoryHeader";
import { SubmitButton } from "@/components/SubmitButton";
import { EvidenceList } from "@/components/Evidence";
import { FilePicker } from "@/components/FilePicker";
import {
  newBlankBugAction,
  saveBugDraftAction,
  deleteBugDraftAction,
  uploadFixEvidenceAction,
  verifyBugAction,
  reopenBugAction,
  addCommitAction,
} from "@/app/actions/qa";
import type { BugStatus } from "@/lib/db/schema";

const STATUS_CLASS: Record<BugStatus, string> = { draft: "p-ai", open: "p-fail", in_progress: "p-block", resolved: "p-acc", closed: "p-pass" };

export default async function BugsPage({ params, searchParams }: PageProps<"/stories/[key]/bugs">) {
  const { key } = await params;
  const sp = await searchParams;
  const { db, user, data, role, actor, allowed, owner } = await loadStoryPage(key);
  const { story, project } = data;
  if (!allowed) return <div className="flash err">Bạn không thuộc dự án {project.key}.</div>;
  const canEdit = can(actor, "tc.edit");
  const list = (await listBugs(db, { storyId: story.id })).map((r) => r.bug);
  const ids = list.map((b) => b.id);
  const ev = await evidenceOf(db, "bug", ids);
  const fixEv = await evidenceOf(db, "bug_fix", ids);
  const editing = list.find((b) => b.id === sp.edit && b.status === "draft");
  const dupes = editing ? await similarBugs(db, editing.id) : [];
  const drafts = list.filter((b) => b.status === "draft" && b.id !== editing?.id);
  const live = list.filter((b) => b.status !== "draft");
  const kh = (
    <>
      <input type="hidden" name="key" value={story.jiraKey} />
    </>
  );

  return (
    <>
      <StoryHeader story={story} role={role} tab="/bugs" owner={owner} meId={user.id} />
      <Flash ok={sp.ok} err={sp.err} />
      <div className="sh">
        <p className="small muted">
          Sub-bug của story. Tạo bug nhanh nhất từ màn Thực thi (nút Log bug ở TC Failed). Bug gửi lên Jira là sub-task của {story.jiraKey}
          {project.isDemo ? "; dự án mẫu chỉ lưu trong tool." : "."}
        </p>
        {canEdit && (
          <form action={newBlankBugAction}>
            {kh}
            <input type="hidden" name="storyId" value={story.id} />
            <SubmitButton className="btn">+ Bug không gắn test case</SubmitButton>
          </form>
        )}
      </div>

      {editing && (
        <div className="card sel" id="edit">
          <h2>
            Nháp bug <span className="pill p-ai">{editing.source === "ai" ? "AI viết" : editing.source === "agent" ? "Antigravity viết" : "Nháp"}</span>
          </h2>
          {dupes.length > 0 && (
            <div className="flash err" role="status" style={{ flexDirection: "column", gap: 4 }}>
              <b>Có thể trùng với bug đã có, kiểm tra trước khi tạo:</b>
              {dupes.map((d) => (
                <span key={d.id} className="small">
                  <a className="key" href={`/stories/${d.storyKey}/bugs#b-${d.id}`}>
                    {d.code}
                  </a>{" "}
                  {d.title} · {d.storyKey} · giống {Math.round(d.score * 100)}%
                </span>
              ))}
            </div>
          )}
          <form action={saveBugDraftAction} className="form">
            {kh}
            <input type="hidden" name="bugId" value={editing.id} />
            <label className="full" htmlFor="b-title">
              Title
              <input id="b-title" name="title" defaultValue={editing.title} required />
            </label>
            <label htmlFor="b-sev">
              Severity
              <select id="b-sev" name="severity" defaultValue={editing.severity}>
                <option value="critical">Critical</option>
                <option value="major">Major</option>
                <option value="minor">Minor</option>
              </select>
            </label>
            <label htmlFor="b-env">
              Môi trường
              <select id="b-env" name="env" defaultValue={editing.env}>
                <option value="dev">DEV</option>
                <option value="stg">STAGING</option>
                <option value="prod">PRODUCTION</option>
              </select>
            </label>
            <label className="full" htmlFor="b-steps">
              Steps to reproduce <span className="hint">mỗi bước một dòng</span>
              <textarea id="b-steps" name="steps" rows={5} defaultValue={editing.steps} />
            </label>
            <label htmlFor="b-act">
              Actual
              <textarea id="b-act" name="actual" defaultValue={editing.actual} />
            </label>
            <label htmlFor="b-exp">
              Expected
              <textarea id="b-exp" name="expected" defaultValue={editing.expected} />
            </label>
            <div className="full field">
              <span>
                Evidence lỗi <span className="hint">ảnh hoặc video, tối đa 25 MB mỗi file</span>
              </span>
              <FilePicker id="b-files" />
            </div>
            <div className="full">
              <EvidenceList items={ev.filter((x) => x.ownerId === editing.id)} />
            </div>
            <div className="full actions">
              <SubmitButton className="btn pri" name="publish" value="1" pendingText="Đang tạo…">
                {project.isDemo ? "Tạo bug" : "Tạo sub-bug trên Jira"}
              </SubmitButton>
              <SubmitButton className="btn">Lưu nháp</SubmitButton>
            </div>
          </form>
          <form action={deleteBugDraftAction}>
            {kh}
            <input type="hidden" name="bugId" value={editing.id} />
            <SubmitButton className="btn sm danger">Bỏ nháp</SubmitButton>
          </form>
        </div>
      )}

      {drafts.length > 0 && (
        <div className="card aiz">
          <h2>Nháp chờ hoàn thiện ({drafts.length})</h2>
          {drafts.map((b) => (
            <div className="inline" key={b.id}>
              <span className="pill p-ai">{b.source === "agent" ? "Antigravity" : b.source === "ai" ? "AI" : "Nháp"}</span>
              <span style={{ flex: 1 }}>{b.title}</span>
              <a className="btn sm" href={`/stories/${story.jiraKey}/bugs?edit=${b.id}#edit`}>
                Mở
              </a>
            </div>
          ))}
        </div>
      )}

      {live.length === 0 && !editing && !drafts.length && <div className="empty">Chưa có bug nào cho story này.</div>}

      {live.map((b) => {
        const fixes = fixEv.filter((x) => x.ownerId === b.id);
        return (
          <div className="card" key={b.id} id={`b-${b.id}`}>
            <h2>
              <span>
                <span className="key">{bugCode(b)}</span> {b.title}
              </span>
              <span className="inline">
                <span className="tag">{SEVERITY_LABEL[b.severity]}</span>
                <span className="tag">{ENV_LABEL[b.env]}</span>
                <span className={`pill ${STATUS_CLASS[b.status]}`}>
                  {BUG_STATUS_LABEL[b.status]}
                  {b.jiraStatus && b.jiraStatus !== BUG_STATUS_LABEL[b.status] ? ` · Jira: ${b.jiraStatus}` : ""}
                </span>
              </span>
            </h2>
            <div className="grid2">
              <div className="small">
                <p>
                  <b>Steps</b>
                </p>
                <div className="pre">{b.steps || "—"}</div>
                <p style={{ marginTop: 8 }}>
                  <b>Actual:</b> {b.actual || "—"}
                </p>
                <p>
                  <b>Expected:</b> {b.expected || "—"}
                </p>
                <p className="muted" style={{ marginTop: 6 }}>
                  Tạo {fmtDateTime(b.createdAt)}
                  {b.closedAt ? ` · đóng ${fmtDateTime(b.closedAt)}` : ""}
                </p>
                <EvidenceList items={ev.filter((x) => x.ownerId === b.id)} />
              </div>
              <div className="stack" style={{ gap: 10 }}>
                <div>
                  <h3>Commit fix</h3>
                  {b.fixCommits.length ? (
                    <ul className="list small">
                      {b.fixCommits.map((c) => (
                        <li key={c.sha}>
                          {c.url ? (
                            <a className="mono" href={c.url} target="_blank" rel="noreferrer">
                              {c.sha.slice(0, 8)}
                            </a>
                          ) : (
                            <span className="mono">{c.sha.slice(0, 8)}</span>
                          )}{" "}
                          {c.message}
                          {c.author ? ` · ${c.author}` : ""}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="small muted">Chưa có. Commit có mã {bugCode(b)} trong message sẽ tự gắn khi có Git webhook.</p>
                  )}
                  {canEdit && b.status !== "closed" && (
                    <form action={addCommitAction} className="inline" style={{ marginTop: 6 }}>
                      {kh}
                      <input type="hidden" name="bugId" value={b.id} />
                      <input name="commit" placeholder="Dán link hoặc mã commit" aria-label="Commit" />
                      <SubmitButton className="btn sm">Gắn</SubmitButton>
                    </form>
                  )}
                </div>
                <div>
                  <h3>Evidence đã fix (QC)</h3>
                  <EvidenceList items={fixes} />
                  {!fixes.length && <p className="small muted">Chưa có.</p>}
                </div>
                {canEdit && b.status !== "closed" && (
                  <form action={verifyBugAction} className="form" style={{ gridTemplateColumns: "minmax(0,1fr)" }}>
                    {kh}
                    <input type="hidden" name="bugId" value={b.id} />
                    <div className="field">
                      <span>Ảnh/video chứng minh đã fix</span>
                      <FilePicker id={`fx-${b.id}`} label="Chọn file" />
                    </div>
                    <label htmlFor={`note-${b.id}`}>
                      Ghi chú verify
                      <input id={`note-${b.id}`} name="note" placeholder="Đã kiểm tra trên build …" />
                    </label>
                    <div className="actions">
                      <SubmitButton className="btn pri" pendingText="Đang đóng…">
                        Verify và đóng bug
                      </SubmitButton>
                      {b.status !== "resolved" && <span className="small muted">Dev chưa chuyển Resolved.</span>}
                    </div>
                  </form>
                )}
                {canEdit && (b.status === "resolved" || b.status === "closed") && (
                  <form action={reopenBugAction} className="inline">
                    {kh}
                    <input type="hidden" name="bugId" value={b.id} />
                    <input name="note" placeholder="Lý do mở lại" aria-label="Lý do mở lại" />
                    <SubmitButton className="btn sm danger">Mở lại</SubmitButton>
                  </form>
                )}
                {canEdit && b.status !== "closed" && (
                  <form action={uploadFixEvidenceAction} className="inline">
                    {kh}
                    <input type="hidden" name="bugId" value={b.id} />
                    <FilePicker label="Chọn file" />
                    <SubmitButton className="btn sm">Chỉ đính kèm</SubmitButton>
                  </form>
                )}
              </div>
            </div>
          </div>
        );
      })}
    </>
  );
}

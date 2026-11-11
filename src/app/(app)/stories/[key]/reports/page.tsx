import Link from "next/link";
import { eq } from "drizzle-orm";
import { reports } from "@/lib/db/schema";
import { can } from "@/lib/rbac";
import { loadStoryPage } from "@/lib/storyPage";
import { storyBuilds, ENV_LABEL } from "@/lib/services/execution";
import { passRate, reportText } from "@/lib/services/reports";
import { SEVERITY_LABEL } from "@/lib/services/bugs";
import { fmtDateTime } from "@/lib/format";
import { Flash } from "@/components/Flash";
import { StoryHeader } from "@/components/StoryHeader";
import { SubmitButton } from "@/components/SubmitButton";
import { CopyButton } from "@/components/CopyButton";
import { generateReportAction, saveReportAction, postReportAction } from "@/app/actions/qa";

type C = { passed: number; failed: number; blocked: number; notRun: number; total: number };

function Bar({ label, c }: { label: string; c: C }) {
  const w = (n: number) => `${(n / (c.total || 1)) * 100}%`;
  return (
    <div className="bar">
      <span>{label}</span>
      <div className="stackbar" role="img" aria-label={`${label}: ${c.passed} passed, ${c.failed} failed, ${c.blocked} blocked, ${c.notRun} chưa chạy`}>
        <span style={{ width: w(c.passed), background: "var(--pass)" }} />
        <span style={{ width: w(c.failed), background: "var(--fail)" }} />
        <span style={{ width: w(c.blocked), background: "var(--block)" }} />
        <span style={{ width: w(c.notRun), background: "var(--nr)", opacity: 0.4 }} />
      </div>
      <span className="num">
        {c.passed}/{c.total}
      </span>
    </div>
  );
}

export default async function ReportsPage({ params, searchParams }: PageProps<"/stories/[key]/reports">) {
  const { key } = await params;
  const sp = await searchParams;
  const { db, data, role, actor, allowed } = await loadStoryPage(key);
  const { story, project } = data;
  if (!allowed) return <div className="flash err">Bạn không thuộc dự án {project.key}.</div>;
  const canEdit = can(actor, "tc.edit");
  const all = await storyBuilds(db, story.id);
  const b = all.find((x) => x.id === sp.build) ?? all.find((x) => x.env === story.currentEnv) ?? all[0];
  const [r] = b ? await db.select().from(reports).where(eq(reports.buildId, b.id)) : [];
  const hidden = b ? (
    <>
      <input type="hidden" name="key" value={story.jiraKey} />
      <input type="hidden" name="buildId" value={b.id} />
    </>
  ) : null;

  return (
    <>
      <StoryHeader story={story} role={role} tab="/reports" />
      <Flash ok={sp.ok} err={sp.err} />
      {!b ? (
        <div className="empty">Chưa có build nào. Tạo build ở tab Thực thi trước.</div>
      ) : (
        <>
          <div className="buildbar">
            <span className="lbl">Build</span>
            {all.map((x) => (
              <Link key={x.id} href={`/stories/${story.jiraKey}/reports?build=${x.id}`} className={`btn sm${x.id === b.id ? " pri" : ""}`}>
                {x.name}
              </Link>
            ))}
          </div>
          <div className="sh">
            <div>
              <h2 style={{ fontSize: 18 }}>
                Test report · {b.name} · {ENV_LABEL[b.env]}
              </h2>
              <p className="small muted">{r ? `Cập nhật ${fmtDateTime(r.updatedAt)}${r.postedAt ? ` · đã đăng ${fmtDateTime(r.postedAt)}` : " · chưa đăng"}` : "Chưa tạo report cho build này."}</p>
            </div>
            {canEdit && (
              <div className="actions">
                <form action={generateReportAction}>
                  {hidden}
                  <input type="hidden" name="ai" value="1" />
                  <SubmitButton className="btn ai" pendingText="AI đang viết…">
                    {r ? "Tạo lại kèm nhận xét AI" : "Tạo report kèm nhận xét AI"}
                  </SubmitButton>
                </form>
                <form action={generateReportAction}>
                  {hidden}
                  <SubmitButton className="btn">Tính lại số liệu</SubmitButton>
                </form>
              </div>
            )}
          </div>
          {r && (
            <>
              <div className="kpis">
                <div className="kpi">
                  <small>TC trong round</small>
                  <b>{r.counts.build.total}</b>
                </div>
                <div className="kpi">
                  <small>Passed</small>
                  <b style={{ color: "var(--pass)" }}>{r.counts.build.passed}</b>
                </div>
                <div className="kpi">
                  <small>Failed</small>
                  <b style={{ color: "var(--fail)" }}>{r.counts.build.failed}</b>
                </div>
                <div className="kpi">
                  <small>Blocked</small>
                  <b style={{ color: "var(--block)" }}>{r.counts.build.blocked}</b>
                </div>
                <div className="kpi">
                  <small>Not test</small>
                  <b>{r.counts.build.notRun}</b>
                </div>
                <div className="kpi">
                  <small>Pass rate tích luỹ {ENV_LABEL[b.env]}</small>
                  <b>{passRate(r.counts.env)}%</b>
                </div>
              </div>
              <div className="grid2">
                <div className="card">
                  <h2>Theo User Story (tích luỹ {ENV_LABEL[b.env]})</h2>
                  <div className="bars">
                    {r.counts.byUs.map((u) => (
                      <Bar key={u.us} label={u.us} c={u} />
                    ))}
                    <Bar label="Tổng" c={r.counts.env} />
                  </div>
                  <div className="legend">
                    <span style={{ color: "var(--pass)" }}>Passed</span>
                    <span style={{ color: "var(--fail)" }}>Failed</span>
                    <span style={{ color: "var(--block)" }}>Blocked</span>
                    <span>Chưa chạy</span>
                  </div>
                  <h3>Bug còn mở ({r.counts.openBugs.length})</h3>
                  {r.counts.openBugs.length ? (
                    <ul className="list small">
                      {r.counts.openBugs.map((x) => (
                        <li key={x.key}>
                          <span className="key">{x.key}</span> {x.title} · {SEVERITY_LABEL[x.severity]}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="small muted">Không có. Đã đóng {r.counts.closedBugs} bug.</p>
                  )}
                  {r.counts.blockers.length > 0 && <p className="small">Bị chặn bởi: {r.counts.blockers.join(", ")}</p>}
                </div>
                <div className="card aiz">
                  <h2>
                    <span className="ai-label">Nhận xét{r.aiSummary ? " (AI viết, QC sửa trước khi đăng)" : ""}</span>
                  </h2>
                  {canEdit ? (
                    <form action={postReportAction} className="form" style={{ gridTemplateColumns: "minmax(0,1fr)" }}>
                      {hidden}
                      <label htmlFor="finalText">
                        Nội dung kết luận
                        <textarea id="finalText" name="finalText" rows={7} defaultValue={r.finalText} />
                      </label>
                      <div className="actions">
                        <SubmitButton className="btn pri" pendingText="Đang đăng…">
                          {project.isDemo ? "Đánh dấu đã đăng" : "Đăng lên Jira / Slack"}
                        </SubmitButton>
                        <button type="submit" className="btn" formAction={saveReportAction}>
                          Chỉ lưu
                        </button>
                        <CopyButton text={reportText(story.jiraKey, story.summary, b.name, ENV_LABEL[b.env], r.counts, r.finalText)} label="Copy nội dung report" />
                      </div>
                    </form>
                  ) : (
                    <p className="pre small">{r.finalText}</p>
                  )}
                </div>
              </div>
            </>
          )}
        </>
      )}
    </>
  );
}

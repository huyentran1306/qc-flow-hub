import Link from "next/link";
import { getDb } from "@/lib/db";
import { requireUser, currentProjectContext } from "@/lib/session";
import { can } from "@/lib/rbac";
import { boardStories, currentSprint, isQcSubtask, isSubBug } from "@/lib/services/stories";
import { listConnections } from "@/lib/services/connections";
import { STAGE_LABEL, fmtDate } from "@/lib/format";
import { Icon } from "@/components/Icon";
import { syncJiraAction, seedDemoAction } from "@/app/actions/story";
import { Flash } from "@/components/Flash";
import { SubmitButton } from "@/components/SubmitButton";
import type { QaStage } from "@/lib/db/schema";

const STAGE_CLASS: Record<QaStage, string> = { analyzing: "p-nr", qna: "p-block", tc_ready: "p-acc", testing: "p-acc", done: "p-pass" };

export default async function BoardPage({ searchParams }: PageProps<"/board">) {
  const sp = await searchParams;
  const user = await requireUser();
  const db = await getDb();
  const ctx = await currentProjectContext(user, db);
  const actor = { isAdmin: user.isAdmin, role: ctx.role };
  const conns = user.isAdmin ? await listConnections(db) : {};

  const setupSteps = user.isAdmin
    ? [conns.jira?.status === "ok", conns.testlink?.status === "ok", conns.gemini?.status === "ok", ctx.available.some((p) => p.key !== "DEMO")]
    : [];
  const setupDone = setupSteps.filter(Boolean).length;
  const setup =
    user.isAdmin && setupDone < setupSteps.length ? (
      <div className="setupbar">
        <Icon name="rocket" />
        <span>
          <b>Thiết lập {setupDone}/{setupSteps.length + 1} bước</b> <span className="muted">· kết nối Jira, TestLink, Gemini và tạo dự án thật để dùng với dữ liệu thật</span>
        </span>
        <span className="meter" aria-hidden="true">
          <span style={{ width: `${(setupDone / (setupSteps.length + 1)) * 100}%` }} />
        </span>
        <Link className="btn sm" href="/admin/setup">
          Tiếp tục thiết lập
        </Link>
      </div>
    ) : null;

  if (!ctx.project) {
    return (
      <>
        <div className="sh">
          <div>
            <h1>Sprint board</h1>
            <p>{user.isAdmin ? "Chưa có dự án nào." : "Bạn chưa được gán vào dự án nào. Hãy nhờ Admin thêm bạn vào dự án."}</p>
          </div>
        </div>
        <Flash ok={sp.ok} err={sp.err} />
        {setup}
        {user.isAdmin && (
          <div className="empty">
            <span>Muốn thử ngay khi chưa có Jira? Tạo một dự án mẫu với 3 story có sẵn.</span>
            <form action={seedDemoAction}>
              <SubmitButton className="btn pri" pendingText="Đang tạo…">
                Tạo dự án mẫu
              </SubmitButton>
            </form>
          </div>
        )}
      </>
    );
  }

  const sprint = await currentSprint(db, ctx.project.id);
  const rows = await boardStories(db, ctx.project.id, sprint?.id ?? null);
  const totals = rows.reduce(
    (a, r) => ({ tc: a.tc + r.tcApproved, draft: a.draft + r.tcDraft, q: a.q + r.qOpen, bugs: a.bugs + r.bugsOpen, verify: a.verify + r.bugsVerify }),
    { tc: 0, draft: 0, q: 0, bugs: 0, verify: 0 },
  );
  const ENV_STEP = { dev: 0, stg: 1, prod: 2 } as const;

  return (
    <>
      <div className="sh">
        <div>
          <h1>{sprint ? sprint.name : "Sprint board"}</h1>
          <p>
            {ctx.project.key} · {ctx.project.name}
            {sprint ? ` · ${fmtDate(sprint.startDate)} – ${fmtDate(sprint.endDate)}` : " · chưa có sprint, hãy đồng bộ Jira"}
            {ctx.project.isDemo ? " · dự án mẫu" : ""}
          </p>
        </div>
        <div className="actions">
          {can(actor, "jira.sync") && !ctx.project.isDemo && (
            <form action={syncJiraAction}>
              <SubmitButton className="btn pri" pendingText="Đang đồng bộ…">
                <Icon name="refresh" size={16} /> Đồng bộ Jira
              </SubmitButton>
            </form>
          )}
        </div>
      </div>
      <Flash ok={sp.ok} err={sp.err} />
      {setup}
      <div className="kpis">
        <div className="kpi">
          <small>
            <Icon name="layers" size={15} /> Story trong sprint
          </small>
          <b>{rows.length}</b>
        </div>
        <div className="kpi">
          <small>
            <Icon name="check" size={15} /> Test case đã duyệt
          </small>
          <b>{totals.tc}</b>
        </div>
        <Link className="kpi" href="/agent">
          <small>
            <Icon name="sparkles" size={15} /> TC nháp chờ duyệt
          </small>
          <b style={{ color: totals.draft ? "var(--ai)" : undefined }}>{totals.draft}</b>
        </Link>
        <div className="kpi">
          <small>
            <Icon name="message" size={15} /> Q&amp;A chưa trả lời
          </small>
          <b style={{ color: totals.q ? "var(--block)" : undefined }}>{totals.q}</b>
        </div>
        <Link className="kpi" href="/bugs?f=open">
          <small>
            <Icon name="bug" size={15} /> Sub-bug đang mở
          </small>
          <b style={{ color: totals.bugs ? "var(--fail)" : undefined }}>{totals.bugs}</b>
        </Link>
        <Link className="kpi" href="/bugs?f=verify">
          <small>
            <Icon name="shield" size={15} /> Chờ QC verify
          </small>
          <b style={{ color: totals.verify ? "var(--accent)" : undefined }}>{totals.verify}</b>
        </Link>
      </div>
      {rows.length === 0 ? (
        <div className="empty">
          <span>Chưa có story nào. {can(actor, "jira.sync") ? "Bấm Đồng bộ Jira để lấy story của sprint đang chạy." : "Chờ QC đồng bộ từ Jira."}</span>
        </div>
      ) : (
        <div className="tbl-wrap">
          <table>
            <thead>
              <tr>
                <th>Story</th>
                <th>Chức năng / US</th>
                <th>Giai đoạn QA</th>
                <th>Môi trường</th>
                <th>Test case</th>
                <th>Q&amp;A mở</th>
                <th>Bug mở</th>
                <th>Subtask</th>
                <th>Jira</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const qc = r.subtasks.filter((s) => isQcSubtask(s, ctx.project!.mapping)).length;
                const bugs = r.subtasks.filter((s) => isSubBug(s, ctx.project!.mapping)).length;
                const dev = r.subtasks.length - qc - bugs;
                return (
                  <tr key={r.id}>
                    <td>
                      <Link className="key" href={`/stories/${r.jiraKey}`}>
                        {r.jiraKey}
                      </Link>
                    </td>
                    <td>
                      <Link href={`/stories/${r.jiraKey}`} className="title-link">
                        {r.summary}
                      </Link>
                      <br />
                      <span className="small muted">{r.usTitles ?? "chưa tách US"}</span>
                    </td>
                    <td>
                      <span className={`pill ${STAGE_CLASS[r.qaStage]}`}>{STAGE_LABEL[r.qaStage]}</span>
                    </td>
                    <td>
                      <div className="envbar" role="img" aria-label={r.qaStage === "done" ? "Đã xong cả 3 môi trường" : `Đang ở ${r.currentEnv.toUpperCase()}`}>
                        {[0, 1, 2].map((i) => (
                          <span key={i} className={r.qaStage === "done" || i < ENV_STEP[r.currentEnv] ? "d" : i === ENV_STEP[r.currentEnv] && r.qaStage === "testing" ? "a" : ""} />
                        ))}
                      </div>
                      <span className="small muted">{r.lastBuild ?? "chưa có build"}</span>
                    </td>
                    <td className="num">
                      {r.tcApproved}
                      {r.tcDraft ? <span className="small" style={{ color: "var(--ai)" }}> +{r.tcDraft} nháp</span> : null}
                    </td>
                    <td className="num" style={{ color: r.qOpen ? "var(--block)" : undefined, fontWeight: r.qOpen ? 600 : undefined }}>
                      {r.qOpen}
                    </td>
                    <td className="num" style={{ color: r.bugsOpen ? "var(--fail)" : undefined, fontWeight: r.bugsOpen ? 600 : undefined }}>
                      {r.bugsOpen}
                      {r.bugsVerify ? <span className="small" style={{ color: "var(--accent)" }}> · {r.bugsVerify} chờ verify</span> : null}
                    </td>
                    <td>
                      <span className="chips">
                        <span className="tag">Dev {dev}</span>
                        <span className="tag">QC {qc}</span>
                        {bugs > 0 && <span className="tag">Bug {bugs}</span>}
                      </span>
                    </td>
                    <td className="small muted">{r.jiraStatus}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

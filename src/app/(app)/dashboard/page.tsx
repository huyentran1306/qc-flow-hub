import Link from "next/link";
import { getDb } from "@/lib/db";
import { requireUser, currentProjectContext } from "@/lib/session";
import { can } from "@/lib/rbac";
import { currentSprint } from "@/lib/services/stories";
import { projectDashboard, recentAnswers } from "@/lib/services/dashboard";
import { listConnections } from "@/lib/services/connections";
import { ENV_LABEL } from "@/lib/services/execution";
import { STAGE_LABEL, fmtDate, fmtDateTime } from "@/lib/format";
import { Flash } from "@/components/Flash";
import { Icon } from "@/components/Icon";
import { SubmitButton } from "@/components/SubmitButton";
import { BugStacks, BurnUp, DailyResults, HBars } from "@/components/Charts";
import { askAiAction } from "@/app/actions/extra";

const hrs = (h: number | null) => (h == null ? "—" : h >= 48 ? `${Math.round(h / 24)} ngày` : `${h} giờ`);

export default async function DashboardPage({ searchParams }: PageProps<"/dashboard">) {
  const sp = await searchParams;
  const user = await requireUser();
  const db = await getDb();
  const ctx = await currentProjectContext(user, db);
  if (!ctx.project || !can({ isAdmin: user.isAdmin, role: ctx.role }, "story.view")) {
    return (
      <div className="empty">
        Chưa có dự án. <Link href="/board">Mở Sprint board</Link> để tạo dự án mẫu hoặc nhờ Admin thêm bạn vào dự án.
      </div>
    );
  }
  const sprint = await currentSprint(db, ctx.project.id);
  const d = await projectDashboard(db, ctx.project.id, sprint?.id ?? null);
  const answers = await recentAnswers(db, ctx.project.id, user.id);
  const hasAi = !!(await listConnections(db)).gemini;
  const k = d.kpi;

  return (
    <>
      <div className="sh">
        <div>
          <h1>Dashboard</h1>
          <p>
            {ctx.project.key} · {ctx.project.name}
            {sprint ? ` · ${sprint.name} (${fmtDate(sprint.startDate)} – ${fmtDate(sprint.endDate)})` : " · toàn bộ story"}
          </p>
        </div>
        <div className="actions">
          <span className="small muted">Xuất Excel (CSV):</span>
          <a className="btn sm" href="/export/stories" download>
            Story
          </a>
          <a className="btn sm" href="/export/results" download>
            Kết quả test
          </a>
          <a className="btn sm" href="/export/bugs" download>
            Bug
          </a>
        </div>
      </div>
      <Flash ok={sp.ok} err={sp.err} />

      <div className="kpis">
        <div className="kpi">
          <small>
            <Icon name="check" size={15} /> Pass rate hiện tại
          </small>
          <b>{k.passRate}%</b>
          <span className="sub">
            {k.totals.passed}/{k.totals.total} TC ở môi trường hiện tại
          </span>
        </div>
        <div className="kpi">
          <small>
            <Icon name="list" size={15} /> Chưa chạy
          </small>
          <b>{k.totals.notRun}</b>
          <span className="sub">
            {k.totals.failed} failed · {k.totals.blocked} blocked
          </span>
        </div>
        <Link className="kpi" href="/bugs?f=open">
          <small>
            <Icon name="bug" size={15} /> Bug đang mở
          </small>
          <b style={{ color: k.openBugs ? "var(--fail)" : undefined }}>{k.openBugs}</b>
          <span className="sub">{k.openCritical} Critical</span>
        </Link>
        <Link className="kpi" href="/bugs?f=verify">
          <small>
            <Icon name="shield" size={15} /> Chờ QC verify
          </small>
          <b style={{ color: k.verifyQueue ? "var(--accent)" : undefined }}>{k.verifyQueue}</b>
          <span className="sub">bug dev đã fix</span>
        </Link>
        <div className="kpi">
          <small>
            <Icon name="clock" size={15} /> Thời gian fix TB
          </small>
          <b>{hrs(k.fixHours)}</b>
          <span className="sub">verify TB {hrs(k.verifyHours)}</span>
        </div>
        <div className="kpi">
          <small>
            <Icon name="sparkles" size={15} /> Chạy tự động
          </small>
          <b>{k.autoShare}%</b>
          <span className="sub">lượt chạy 14 ngày · {k.runs} lượt</span>
        </div>
      </div>

      <div className="dash-grid">
        <div className="card">
          <h2>Kết quả test 14 ngày qua</h2>
          <DailyResults data={d.trend} />
        </div>
        <div className="card">
          <h2>Tiến độ {sprint ? "sprint" : "test"}</h2>
          <BurnUp scope={d.burn.scope} days={d.burn.days} />
        </div>
        <div className="card">
          <h2>Bug theo mức độ</h2>
          <BugStacks rows={d.bugMatrix} />
        </div>
        <div className="card">
          <h2>Story theo giai đoạn</h2>
          <HBars items={d.stageCounts.filter((s) => s.stage !== "testing").map((s) => ({ label: s.label, value: s.count }))} />
          <h3>Đang test theo môi trường</h3>
          <HBars items={d.envCounts.map((e) => ({ label: e.label, value: e.count }))} color="var(--ai)" />
        </div>
      </div>

      <div className="dash-grid">
        <div className="card">
          <h2>Story cần chú ý</h2>
          {d.risky.length === 0 ? (
            <p className="small muted">Không có story nào đáng lo.</p>
          ) : (
            <div className="tbl-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Story</th>
                    <th>Môi trường</th>
                    <th>Pass rate</th>
                    <th>Lý do</th>
                  </tr>
                </thead>
                <tbody>
                  {d.risky.map((r) => (
                    <tr key={r.id}>
                      <td>
                        <Link className="key" href={`/stories/${r.key}`}>
                          {r.key}
                        </Link>
                        <div className="small">{r.summary}</div>
                      </td>
                      <td className="small">{r.stage === "testing" ? ENV_LABEL[r.env] : STAGE_LABEL[r.stage]}</td>
                      <td className="num">{r.counts.total ? `${r.rate}%` : "—"}</td>
                      <td className="small">{r.reasons.join(" · ")}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
        <div className="card">
          <h2>Khối lượng việc 14 ngày</h2>
          {d.workload.length === 0 ? (
            <p className="small muted">Chưa có ai chấm kết quả trong 14 ngày.</p>
          ) : (
            <div className="tbl-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Người</th>
                    <th>Chấm tay</th>
                    <th>Tự động / agent</th>
                    <th>Bug đã log</th>
                    <th>Bug đã verify</th>
                  </tr>
                </thead>
                <tbody>
                  {d.workload.map((w) => (
                    <tr key={w.name}>
                      <td>{w.name}</td>
                      <td className="num">{w.manual}</td>
                      <td className="num">{w.auto}</td>
                      <td className="num">{w.bugs}</td>
                      <td className="num">{w.verified}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      <div className="card aiz" id="ask">
        <h2>
          <span className="ai-label">
            <Icon name="sparkles" /> Hỏi AI về dự án
          </span>
          <span className="small muted">AI chỉ trả lời dựa trên số liệu của dự án đang chọn</span>
        </h2>
        {hasAi ? (
          <form action={askAiAction} className="inline">
            <input name="question" placeholder="Ví dụ: Sprint này story nào rủi ro nhất? Có kịp lên Staging thứ 6 không?" aria-label="Câu hỏi cho AI" required minLength={4} />
            <SubmitButton className="btn ai" pendingText="AI đang đọc dữ liệu…">
              Hỏi
            </SubmitButton>
          </form>
        ) : (
          <p className="small muted">Cần kết nối Gemini ở Quản trị → Kết nối.</p>
        )}
        <div className="chips">
          {["Story nào rủi ro nhất và vì sao?", "Bug nào cần verify trước?", "Tóm tắt tình hình test cho standup"].map((q) => (
            <span key={q} className="tag">
              {q}
            </span>
          ))}
        </div>
        {answers.map((a) => (
          <div key={a.id} className="answer">
            <div className="q">
              {a.question} <span className="small muted">· {fmtDateTime(a.createdAt)}</span>
            </div>
            {a.answer}
          </div>
        ))}
      </div>
    </>
  );
}

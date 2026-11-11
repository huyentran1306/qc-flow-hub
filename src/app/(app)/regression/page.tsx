import Link from "next/link";
import { and, asc, eq, inArray } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { apiCalls, stories, testCases } from "@/lib/db/schema";
import { requireUser, currentProjectContext } from "@/lib/session";
import { can } from "@/lib/rbac";
import { suiteRows, suiteRunResults, sweepInterruptedSuites } from "@/lib/services/regression";
import { ENV_LABEL } from "@/lib/services/execution";
import { fmtDateTime, tcCode } from "@/lib/format";
import { Flash } from "@/components/Flash";
import { Icon } from "@/components/Icon";
import { SubmitButton } from "@/components/SubmitButton";
import { AutoRefresh } from "@/components/AutoRefresh";
import { CheckHelper } from "@/components/CheckHelper";
import { cancelSuiteRunAction, createSuiteAction, deleteSuiteAction, runSuiteAction, updateSuiteAction } from "@/app/actions/extra";

const STATUS = { passed: "Passed", failed: "Failed", blocked: "Blocked", not_run: "Chưa chạy" } as const;
const PILL = { passed: "p-pass", failed: "p-fail", blocked: "p-block", not_run: "p-nr" } as const;

function scheduleText(s: { mode: string; time: string }) {
  if (s.mode === "daily") return `Hằng ngày lúc ${s.time}`;
  if (s.mode === "weekdays") return `Thứ 2 – thứ 6 lúc ${s.time}`;
  return "Không lên lịch";
}

export default async function RegressionPage({ searchParams }: PageProps<"/regression">) {
  const sp = await searchParams;
  const user = await requireUser();
  const db = await getDb();
  const ctx = await currentProjectContext(user, db);
  const actor = { isAdmin: user.isAdmin, role: ctx.role };
  if (!ctx.project || !can(actor, "story.view")) return <div className="empty">Chưa chọn dự án.</div>;
  const canEdit = can(actor, "tc.edit");
  await sweepInterruptedSuites(db);
  const suites = await suiteRows(db, ctx.project.id);
  const rows = await Promise.all(
    suites.map(async (x) => {
      const results = x.last ? await suiteRunResults(db, x.last.buildIds) : [];
      const calls = results.length ? await db.select().from(apiCalls).where(inArray(apiCalls.executionId, results.map((r) => r.e.id))) : [];
      return { ...x, results, calls };
    }),
  );
  const running = suites.some((s) => s.last && (s.last.status === "running" || s.last.status === "queued"));
  const editing = suites.find((s) => s.suite.id === sp.edit);
  const allTcs = editing
    ? await db
        .select({ tc: testCases, s: stories })
        .from(testCases)
        .innerJoin(stories, eq(stories.id, testCases.storyId))
        .where(and(eq(stories.projectId, ctx.project.id), eq(testCases.status, "approved")))
        .orderBy(asc(stories.jiraKey), asc(testCases.seq))
    : [];
  const grouped = new Map<string, { key: string; summary: string; tcs: (typeof testCases.$inferSelect)[] }>();
  for (const { tc, s } of allTcs) {
    const g = grouped.get(s.id) ?? { key: s.jiraKey, summary: s.summary, tcs: [] };
    g.tcs.push(tc);
    grouped.set(s.id, g);
  }

  return (
    <>
      <AutoRefresh active={running} ms={3000} />
      <div className="sh">
        <div>
          <h1>Regression</h1>
          <p>Bộ test gom từ nhiều story, chạy tự động ngay hoặc theo lịch. Lịch chỉ chạy khi tool đang mở. Kết quả vào hàng chờ duyệt, báo Slack và thông báo khi xong.</p>
        </div>
      </div>
      <Flash ok={sp.ok} err={sp.err} />

      {suites.length === 0 && <div className="empty">Chưa có bộ regression nào. Tạo bộ đầu tiên ở dưới, ví dụ “Smoke STAGING”.</div>}

      {rows.map(({ suite, caseIds, last, results, calls }) => {
        const isRunning = !!last && (last.status === "running" || last.status === "queued");
        const done = results.filter((r) => r.e.status !== "not_run").length;
        return (
          <div key={suite.id} className={`card${editing?.suite.id === suite.id ? " sel" : ""}`} id={`s-${suite.id}`}>
            <h2>
              <span>
                {suite.name} <span className="tag">{ENV_LABEL[suite.env]}</span> <span className="small muted">· {caseIds.length} test case</span>
              </span>
              <span className="actions">
                {canEdit && !isRunning && (
                  <form action={runSuiteAction}>
                    <input type="hidden" name="suiteId" value={suite.id} />
                    <SubmitButton className="btn pri sm" pendingText="Đang khởi động…">
                      <Icon name="play" size={14} /> Chạy ngay
                    </SubmitButton>
                  </form>
                )}
                {canEdit && (
                  <Link className="btn sm" href={`/regression?edit=${suite.id}#s-${suite.id}`}>
                    Sửa và chọn TC
                  </Link>
                )}
              </span>
            </h2>
            <p className="small muted">
              {suite.description ? `${suite.description} · ` : ""}
              {scheduleText(suite.schedule)}
              {suite.nextRunAt && suite.schedule.mode !== "off" ? ` · lần tới ${fmtDateTime(suite.nextRunAt)}` : ""}
            </p>
            {last && (
              <>
                <div className="inline small">
                  {isRunning ? <span className="livedot" /> : null}
                  <span>
                    Lượt {last.trigger === "schedule" ? "theo lịch" : "thủ công"} {fmtDateTime(last.startedAt)}:{" "}
                    {isRunning ? `đang chạy ${done}/${last.total}` : last.status === "done" ? `${last.passed}/${last.total} passed` : last.status === "cancelled" ? "đã huỷ" : `lỗi: ${last.error ?? ""}`}
                    {!isRunning && (last.failed || last.blocked) ? ` · ${last.failed} failed, ${last.blocked} blocked` : ""}
                  </span>
                  {isRunning && canEdit && (
                    <form action={cancelSuiteRunAction}>
                      <input type="hidden" name="runId" value={last.id} />
                      <SubmitButton className="btn sm danger">Huỷ</SubmitButton>
                    </form>
                  )}
                </div>
                {isRunning && (
                  <div className="progress" role="progressbar" aria-valuemin={0} aria-valuemax={last.total} aria-valuenow={done}>
                    <span style={{ width: `${(done / Math.max(1, last.total)) * 100}%` }} />
                  </div>
                )}
                {results.length > 0 && (
                  <details open={!isRunning && !!(last.failed || last.blocked)}>
                    <summary className="small" style={{ cursor: "pointer", color: "var(--accent)" }}>
                      Kết quả lượt này
                    </summary>
                    <div className="tbl-wrap" style={{ marginTop: 8 }}>
                      <table>
                        <thead>
                          <tr>
                            <th>Test case</th>
                            <th>Kết quả</th>
                            <th>Ghi chú</th>
                            <th>API</th>
                          </tr>
                        </thead>
                        <tbody>
                          {results.map(({ e, tc, b, s }) => {
                            const c = calls.filter((x) => x.executionId === e.id);
                            const bad = c.filter((x) => x.status == null || x.status >= 400).length;
                            return (
                              <tr key={e.id}>
                                <td>
                                  <Link className="key" href={`/stories/${s.jiraKey}/run?build=${b.id}#e-${e.id}`}>
                                    {s.jiraKey} {tcCode(tc.seq)}
                                  </Link>
                                  <div className="small">{tc.title}</div>
                                </td>
                                <td>
                                  <span className={`pill ${PILL[e.status]}`}>{STATUS[e.status]}</span>
                                </td>
                                <td className="small">{e.notes}</td>
                                <td className="small">{c.length ? `${c.length} lời gọi${bad ? `, ${bad} lỗi` : ""}` : "—"}</td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </details>
                )}
              </>
            )}

            {editing?.suite.id === suite.id && canEdit && (
              <form action={updateSuiteAction} className="form" id={`f-${suite.id}`} style={{ marginTop: 8 }}>
                <input type="hidden" name="suiteId" value={suite.id} />
                <label htmlFor={`n-${suite.id}`}>
                  Tên bộ
                  <input id={`n-${suite.id}`} name="name" defaultValue={suite.name} required />
                </label>
                <label htmlFor={`e-${suite.id}`}>
                  Môi trường
                  <select id={`e-${suite.id}`} name="env" defaultValue={suite.env}>
                    <option value="dev">DEV</option>
                    <option value="stg">STAGING</option>
                    <option value="prod">PRODUCTION</option>
                  </select>
                </label>
                <label className="full" htmlFor={`d-${suite.id}`}>
                  Mô tả
                  <input id={`d-${suite.id}`} name="description" defaultValue={suite.description} />
                </label>
                <label htmlFor={`m-${suite.id}`}>
                  Lịch chạy <span className="hint">giờ Việt Nam; chỉ chạy khi tool đang mở</span>
                  <select id={`m-${suite.id}`} name="mode" defaultValue={suite.schedule.mode}>
                    <option value="off">Không lên lịch</option>
                    <option value="daily">Hằng ngày</option>
                    <option value="weekdays">Thứ 2 – thứ 6</option>
                  </select>
                </label>
                <label htmlFor={`t-${suite.id}`}>
                  Giờ chạy
                  <input id={`t-${suite.id}`} name="time" type="time" defaultValue={suite.schedule.time} />
                </label>
                <div className="full field">
                  <span className="inline" style={{ justifyContent: "space-between" }}>
                    <span>Test case trong bộ ({caseIds.length} đang chọn)</span>
                    <CheckHelper formId={`f-${suite.id}`} />
                  </span>
                  {[...grouped.values()].map((g) => (
                    <div key={g.key} className="card" style={{ padding: "10px 14px", gap: 6, boxShadow: "none" }}>
                      <b className="small">
                        {g.key} {g.summary}
                      </b>
                      {g.tcs.map((tc) => (
                        <label key={tc.id} className="check small">
                          <input type="checkbox" name="tcId" value={tc.id} defaultChecked={caseIds.includes(tc.id)} data-type={tc.type} data-kind={tc.kind} />
                          <span className="key">{tcCode(tc.seq)}</span> {tc.title} {tc.kind === "api" && <span className="tag">API</span>} <span className="tag">{tc.type}</span>
                        </label>
                      ))}
                    </div>
                  ))}
                  {grouped.size === 0 && <span className="small muted">Dự án chưa có test case đã duyệt.</span>}
                </div>
                <div className="full actions">
                  <SubmitButton className="btn pri">Lưu bộ regression</SubmitButton>
                  <Link className="btn" href="/regression">
                    Đóng
                  </Link>
                </div>
              </form>
            )}
            {editing?.suite.id === suite.id && canEdit && (
              <form action={deleteSuiteAction}>
                <input type="hidden" name="suiteId" value={suite.id} />
                <SubmitButton className="btn sm danger">Xoá bộ này</SubmitButton>
              </form>
            )}
          </div>
        );
      })}

      {canEdit && (
        <div className="card">
          <h2>Tạo bộ regression</h2>
          <form action={createSuiteAction} className="form">
            <label htmlFor="ns-name">
              Tên bộ
              <input id="ns-name" name="name" placeholder="Smoke STAGING" required />
            </label>
            <label htmlFor="ns-env">
              Môi trường
              <select id="ns-env" name="env" defaultValue="stg">
                <option value="dev">DEV</option>
                <option value="stg">STAGING</option>
                <option value="prod">PRODUCTION</option>
              </select>
            </label>
            <label className="full" htmlFor="ns-desc">
              Mô tả
              <input id="ns-desc" name="description" placeholder="Happy case các chức năng chính, chạy mỗi đêm" />
            </label>
            <div className="full">
              <SubmitButton className="btn pri">Tạo và chọn test case</SubmitButton>
            </div>
          </form>
        </div>
      )}
    </>
  );
}

import Link from "next/link";
import { can } from "@/lib/rbac";
import { loadStoryPage } from "@/lib/storyPage";
import { buildRows, countStatuses, storyBuilds, ENV_LABEL } from "@/lib/services/execution";
import { evaluateGate, storyGateHistory, NEXT_LABEL } from "@/lib/services/gates";
import { fmtDateTime } from "@/lib/format";
import { Flash } from "@/components/Flash";
import { StoryHeader } from "@/components/StoryHeader";
import { SubmitButton } from "@/components/SubmitButton";
import { advanceAction } from "@/app/actions/qa";
import { ENVS } from "@/lib/db/schema";

export default async function EnvPage({ params, searchParams }: PageProps<"/stories/[key]/env">) {
  const { key } = await params;
  const sp = await searchParams;
  const { db, user, data, role, actor, allowed, owner } = await loadStoryPage(key);
  const { story, project } = data;
  if (!allowed) return <div className="flash err">Bạn không thuộc dự án {project.key}.</div>;
  const all = await storyBuilds(db, story.id);
  const stats = await Promise.all(all.map(async (b) => ({ b, c: countStatuses((await buildRows(db, b.id)).map((r) => r.e)) })));
  const gate = await evaluateGate(db, story.id);
  const history = await storyGateHistory(db, story.id);
  const envIdx = ENVS.indexOf(story.currentEnv);
  const done = story.qaStage === "done";

  return (
    <>
      <StoryHeader story={story} role={role} tab="/env" owner={owner} meId={user.id} />
      <Flash ok={sp.ok} err={sp.err} />
      <div className="pipe">
        {ENVS.map((env, i) => {
          const bs = stats.filter((x) => x.b.env === env).sort((a, z) => a.b.round - z.b.round);
          const state = done || i < envIdx ? "done" : i === envIdx ? "now" : "";
          return (
            <div key={env} className={`stage ${state}`}>
              <span className="env">{ENV_LABEL[env]}</span>
              <b>{state === "done" ? "Đã qua" : state === "now" ? "Đang test" : "Chưa tới"}</b>
              {bs.length ? (
                bs.map(({ b, c }) => (
                  <Link key={b.id} href={`/stories/${story.jiraKey}/run?build=${b.id}`} className="small">
                    {b.name}: {c.passed}/{c.total} passed{c.failed ? `, ${c.failed} failed` : ""}
                    {c.blocked ? `, ${c.blocked} blocked` : ""}
                  </Link>
                ))
              ) : (
                <span className="small muted">{env === "prod" ? "Chỉ chạy happy case" : "Chạy toàn bộ TC"}</span>
              )}
            </div>
          );
        })}
      </div>

      {done ? (
        <div className="flash ok">Story đã hoàn tất trên Production.</div>
      ) : (
        <div className="grid2">
          <div className="card">
            <h2>
              Gate {ENV_LABEL[gate.env]} → {NEXT_LABEL[gate.env]} <span className={`pill ${gate.pass ? "p-pass" : "p-block"}`}>{gate.pass ? "Đạt" : "Chưa đạt"}</span>
            </h2>
            {gate.checks.map((c) => (
              <div className="chk" key={c.label}>
                <span className={`ic ${c.ok ? "ok" : "no"}`} aria-hidden="true">
                  {c.ok ? "✓" : "!"}
                </span>
                <span>
                  {c.label} <span className="muted">· {c.detail}</span>
                </span>
              </div>
            ))}
            <p className="small muted">
              Ngưỡng do dự án cấu hình ở <Link href="/gates">Quy tắc gate</Link>.
            </p>
          </div>
          <div className="card">
            <h2>Chuyển môi trường</h2>
            <p className="small">
              {gate.env === "dev" && "Khi qua gate: comment lên Jira và nhắn Slack nhờ dev deploy STAGING, tạo sẵn build STG-R1 với toàn bộ TC."}
              {gate.env === "stg" && "Khi qua gate: báo sẵn sàng release, tạo build PROD-SMOKE chỉ gồm TC Happy để chạy sau khi release."}
              {gate.env === "prod" && "Khi qua gate: đóng story, báo hoàn tất lên Jira và Slack."}
            </p>
            {can(actor, "tc.edit") ? (
              gate.pass ? (
                <form action={advanceAction}>
                  <input type="hidden" name="key" value={story.jiraKey} />
                  <input type="hidden" name="storyId" value={story.id} />
                  <SubmitButton className="btn pri" pendingText="Đang chuyển…">
                    {gate.env === "prod" ? "Hoàn tất story" : `Báo dev deploy ${NEXT_LABEL[gate.env]}`}
                  </SubmitButton>
                </form>
              ) : role === "lead" ? (
                <form action={advanceAction} className="form" style={{ gridTemplateColumns: "minmax(0,1fr)" }}>
                  <input type="hidden" name="key" value={story.jiraKey} />
                  <input type="hidden" name="storyId" value={story.id} />
                  <label htmlFor="reason">
                    Vượt gate (QC Lead) <span className="hint">lý do được lưu và gửi kèm thông báo</span>
                    <input id="reason" name="reason" required placeholder="Ví dụ: bug Minor đã có PO đồng ý" />
                  </label>
                  <SubmitButton className="btn danger">Vượt gate và chuyển tiếp</SubmitButton>
                </form>
              ) : (
                <p className="small muted">Chưa đạt gate. Chỉ QC Lead được vượt gate.</p>
              )
            ) : (
              <p className="small muted">Bạn chỉ có quyền xem.</p>
            )}
          </div>
        </div>
      )}

      <div className="card">
        <h2>Lịch sử chuyển môi trường</h2>
        {history.length ? (
          <ul className="list small">
            {history.map((h) => (
              <li key={h.id}>
                {fmtDateTime(h.at)} · {ENV_LABEL[h.fromEnv]} → {h.toEnv === "done" ? "Hoàn tất" : ENV_LABEL[h.toEnv as "stg"]}
                {h.overridden ? ` · vượt gate: ${h.reason}` : ""}
              </li>
            ))}
          </ul>
        ) : (
          <p className="small muted">Chưa chuyển môi trường lần nào.</p>
        )}
      </div>
    </>
  );
}

import { redirect } from "next/navigation";
import { getDb } from "@/lib/db";
import { requireUser, currentProjectContext } from "@/lib/session";
import { saveGatesAction } from "@/app/actions/qa";
import { Flash } from "@/components/Flash";
import { SubmitButton } from "@/components/SubmitButton";
import { ENVS, type Env } from "@/lib/db/schema";
import { ENV_LABEL } from "@/lib/services/execution";
import { NEXT_LABEL } from "@/lib/services/gates";

const FIELDS: [keyof import("@/lib/db/schema").GateRule, string][] = [
  ["minPassRate", "Pass rate tối thiểu (%)"],
  ["maxOpenCritical", "Bug Critical còn mở tối đa"],
  ["maxOpenMajor", "Bug Major còn mở tối đa"],
  ["maxOpenMinor", "Bug Minor còn mở tối đa"],
  ["maxBlocked", "TC Blocked tối đa"],
];

export default async function GatesPage({ searchParams }: PageProps<"/gates">) {
  const sp = await searchParams;
  const user = await requireUser();
  const ctx = await currentProjectContext(user, await getDb());
  if (!ctx.project) redirect("/board");
  const canEdit = user.isAdmin || ctx.role === "lead";
  const rules = ctx.project.gateRules;
  return (
    <>
      <div className="sh">
        <div>
          <h1>Quy tắc gate · {ctx.project.key}</h1>
          <p>Điều kiện để story được chuyển sang môi trường tiếp theo. {canEdit ? "Admin và QC Lead sửa được." : "Bạn chỉ xem được."}</p>
        </div>
      </div>
      <Flash ok={sp.ok} err={sp.err} />
      <form action={saveGatesAction}>
        <input type="hidden" name="projectId" value={ctx.project.id} />
        <div className="tbl-wrap">
          <table>
            <thead>
              <tr>
                <th>Điều kiện</th>
                {ENVS.map((e: Env) => (
                  <th key={e}>
                    {ENV_LABEL[e]} → {NEXT_LABEL[e]}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {FIELDS.map(([f, label]) => (
                <tr key={f}>
                  <td>{label}</td>
                  {ENVS.map((e) => (
                    <td key={e}>
                      <input type="number" min={0} max={f === "minPassRate" ? 100 : 999} name={`${e}.${f}`} defaultValue={Number(rules[e][f])} disabled={!canEdit} aria-label={`${label} ${ENV_LABEL[e]}`} style={{ width: 90 }} />
                    </td>
                  ))}
                </tr>
              ))}
              <tr>
                <td>Bắt buộc đã đăng report của round cuối</td>
                {ENVS.map((e) => (
                  <td key={e}>
                    <input type="checkbox" name={`${e}.requireReport`} defaultChecked={rules[e].requireReport} disabled={!canEdit} aria-label={`Bắt buộc report ${ENV_LABEL[e]}`} />
                  </td>
                ))}
              </tr>
              <tr>
                <td>Ai được vượt gate</td>
                {ENVS.map((e) => (
                  <td key={e} className="small">
                    QC Lead, kèm lý do
                  </td>
                ))}
              </tr>
            </tbody>
          </table>
        </div>
        <p className="small muted" style={{ margin: "10px 0" }}>
          Ở PRODUCTION pass rate tính trên bộ happy case. Bug Resolved vẫn tính là còn mở cho tới khi QC verify và đóng.
        </p>
        {canEdit && <SubmitButton className="btn pri">Lưu quy tắc</SubmitButton>}
      </form>
    </>
  );
}

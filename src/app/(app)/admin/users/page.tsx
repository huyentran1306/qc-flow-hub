import { redirect } from "next/navigation";
import { getDb } from "@/lib/db";
import { projects } from "@/lib/db/schema";
import { requireUser } from "@/lib/session";
import { listUsersWithRoles } from "@/lib/services/users";
import { ROLE_LABEL } from "@/lib/rbac";
import { inviteUserAction, resetPasswordAction, setRoleAction, toggleAdminAction, toggleDisabledAction } from "@/app/actions/admin";
import { Flash } from "@/components/Flash";
import { SubmitButton } from "@/components/SubmitButton";

const MATRIX: [string, string, string, string, string, string][] = [
  ["Xem sprint board và story", "✓", "✓", "✓", "✓", "✓"],
  ["Đồng bộ Jira", "✓", "✓", "✓", "—", "—"],
  ["Chạy AI phân tích, sinh test case", "—", "✓", "✓", "—", "—"],
  ["Tạo, gửi câu hỏi Q&A", "—", "✓", "✓", "—", "—"],
  ["Ghi câu trả lời Q&A", "—", "✓", "✓", "—", "✓"],
  ["Sửa, duyệt test case, đẩy TestLink", "—", "✓", "✓", "—", "—"],
  ["Xem audit log (mọi dự án)", "✓", "—", "—", "—", "—"],
  ["Kết nối, người dùng, dự án", "✓", "—", "—", "—", "—"],
];

export default async function UsersPage({ searchParams }: PageProps<"/admin/users">) {
  const me = await requireUser();
  if (!me.isAdmin) redirect("/board");
  const sp = await searchParams;
  const db = await getDb();
  const list = await listUsersWithRoles(db);
  const projs = await db.select().from(projects).orderBy(projects.key);
  return (
    <>
      <div className="sh">
        <div>
          <h1>Người dùng và phân quyền</h1>
          <p>Vai trò gán theo từng dự án. Admin là quyền hệ thống, độc lập với vai trò trong dự án.</p>
        </div>
      </div>
      <Flash ok={sp.ok} err={sp.err} />
      <div className="tbl-wrap">
        <table>
          <thead>
            <tr>
              <th>Thành viên</th>
              {projs.map((p) => (
                <th key={p.id}>Vai trò ở {p.key}</th>
              ))}
              <th>Admin</th>
              <th>Trạng thái</th>
            </tr>
          </thead>
          <tbody>
            {list.map((u) => (
              <tr key={u.id}>
                <td>
                  <b>{u.name}</b>
                  {u.id === me.id && <span className="tag"> bạn</span>}
                  <br />
                  <span className="small muted">{u.email}</span>
                </td>
                {projs.map((p) => (
                  <td key={p.id}>
                    <form action={setRoleAction} className="inline">
                      <input type="hidden" name="userId" value={u.id} />
                      <input type="hidden" name="projectId" value={p.id} />
                      <select name="role" defaultValue={u.roles[p.id] ?? ""} aria-label={`Vai trò của ${u.name} ở ${p.key}`}>
                        <option value="">Không tham gia</option>
                        {(Object.keys(ROLE_LABEL) as (keyof typeof ROLE_LABEL)[]).map((r) => (
                          <option key={r} value={r}>
                            {ROLE_LABEL[r]}
                          </option>
                        ))}
                      </select>
                      <SubmitButton className="btn sm">Lưu</SubmitButton>
                    </form>
                  </td>
                ))}
                <td>
                  <form action={toggleAdminAction}>
                    <input type="hidden" name="userId" value={u.id} />
                    <input type="hidden" name="value" value={u.isAdmin ? "0" : "1"} />
                    <SubmitButton className="btn sm">{u.isAdmin ? "Bỏ Admin" : "Cấp Admin"}</SubmitButton>
                  </form>
                </td>
                <td>
                  <form action={toggleDisabledAction} className="inline">
                    <input type="hidden" name="userId" value={u.id} />
                    <input type="hidden" name="value" value={u.disabled ? "0" : "1"} />
                    <span className={`pill ${u.disabled ? "p-fail" : "p-pass"}`}>{u.disabled ? "Đã khoá" : "Hoạt động"}</span>
                    {u.id !== me.id && <SubmitButton className="btn sm">{u.disabled ? "Mở khoá" : "Khoá"}</SubmitButton>}
                  </form>
                  {u.id !== me.id && (
                    <details style={{ marginTop: 6 }}>
                      <summary className="small" style={{ cursor: "pointer", color: "var(--accent)" }}>
                        Đặt lại mật khẩu
                      </summary>
                      <form action={resetPasswordAction} className="inline" style={{ marginTop: 6 }}>
                        <input type="hidden" name="userId" value={u.id} />
                        <input name="password" type="text" minLength={8} autoComplete="off" placeholder="Mật khẩu tạm" aria-label={`Mật khẩu tạm cho ${u.name}`} required />
                        <SubmitButton className="btn sm">Lưu</SubmitButton>
                      </form>
                    </details>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="grid2">
        <div className="card">
          <h2>Thêm thành viên</h2>
          <form action={inviteUserAction} className="form">
            <label htmlFor="inv-name">
              Tên
              <input id="inv-name" name="name" required />
            </label>
            <label htmlFor="inv-email">
              Email
              <input id="inv-email" name="email" type="email" required />
            </label>
            <label htmlFor="inv-pass">
              Mật khẩu tạm <span className="hint">ít nhất 8 ký tự, người dùng tự đổi trong Hồ sơ</span>
              <input id="inv-pass" name="password" type="text" minLength={8} autoComplete="off" required />
            </label>
            <label htmlFor="inv-project">
              Dự án
              <select id="inv-project" name="projectId" defaultValue={projs[0]?.id ?? ""}>
                <option value="">Chưa gán</option>
                {projs.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.key} · {p.name}
                  </option>
                ))}
              </select>
            </label>
            <label htmlFor="inv-role">
              Vai trò
              <select id="inv-role" name="role" defaultValue="qc">
                {(Object.keys(ROLE_LABEL) as (keyof typeof ROLE_LABEL)[]).map((r) => (
                  <option key={r} value={r}>
                    {ROLE_LABEL[r]}
                  </option>
                ))}
              </select>
            </label>
            <label className="check" htmlFor="inv-admin">
              <input id="inv-admin" name="isAdmin" type="checkbox" /> Cấp quyền Admin
            </label>
            <div className="full">
              <SubmitButton className="btn pri">Tạo tài khoản</SubmitButton>
            </div>
          </form>
        </div>
        <div className="card">
          <h2>Ma trận quyền</h2>
          <div className="tbl-wrap">
            <table>
              <thead>
                <tr>
                  <th>Hành động</th>
                  <th>Admin</th>
                  <th>QC Lead</th>
                  <th>QC</th>
                  <th>Dev</th>
                  <th>PO / BA</th>
                </tr>
              </thead>
              <tbody>
                {MATRIX.map((r) => (
                  <tr key={r[0]}>
                    {r.map((c, i) => (
                      <td key={i} className={i ? "num" : "small"} style={i ? { textAlign: "center", color: c === "✓" ? "var(--pass)" : "var(--nr)" } : undefined}>
                        {c}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="small muted">Admin xem được mọi dự án nhưng không làm việc QC, trừ khi được gán thêm vai trò trong dự án đó.</p>
        </div>
      </div>
    </>
  );
}

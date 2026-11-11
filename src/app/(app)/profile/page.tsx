import path from "node:path";
import { cookies } from "next/headers";
import { getDb } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { listMcpTokens } from "@/lib/services/mcpTokens";
import { changePasswordAction } from "@/app/actions/auth";
import { createTokenAction, revokeTokenAction } from "@/app/actions/qa";
import { fmtDate, fmtDateTime } from "@/lib/format";
import { Flash } from "@/components/Flash";
import { SubmitButton } from "@/components/SubmitButton";
import { CopyButton } from "@/components/CopyButton";

/** Packaged app: bundled Node + bridge next to it. Dev: the repo copy. Server: the user downloads the bridge. */
function mcpConfig(token: string, appUrl: string) {
  const root = process.env.QFH_PACKAGE_ROOT;
  const win = process.platform === "win32";
  const server = !root && process.env.NODE_ENV === "production";
  const command = root ? path.join(root, "runtime", win ? "node.exe" : "node") : "node";
  const script = root ? path.join(root, "mcp-stdio.mjs") : server ? "/ĐƯỜNG/DẪN/TỚI/mcp-stdio.mjs" : path.join(process.cwd(), "public", "mcp-stdio.mjs");
  return JSON.stringify({ mcpServers: { "qa-flow-hub": { command, args: [script], env: { QA_HUB_URL: appUrl, QA_HUB_TOKEN: token } } } }, null, 2);
}

export default async function ProfilePage({ searchParams }: PageProps<"/profile">) {
  const user = await requireUser();
  const sp = await searchParams;
  const tokens = await listMcpTokens(await getDb(), user.id);
  const jar = await cookies();
  const fresh = jar.get("qfh_new_token")?.value ?? null;
  const appUrl = process.env.APP_URL || "http://localhost:3000";
  return (
    <>
      <div className="sh">
        <div>
          <h1>Hồ sơ</h1>
          <p>
            {user.name} · {user.email}
          </p>
        </div>
      </div>
      <Flash ok={sp.ok} err={sp.err} />
      <div className="grid2">
        <div className="card" id="mcp">
          <h2>Token MCP cho Antigravity</h2>
          <p className="small muted">Mỗi máy một token. Agent dùng token này để đọc story, ghi kết quả test và tạo nháp bug thay bạn. Mọi thứ agent ghi đều chờ duyệt.</p>
          {tokens.length > 0 && (
            <div className="tbl-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Tên</th>
                    <th>Quyền</th>
                    <th>Dùng gần nhất</th>
                    <th>Hết hạn</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {tokens.map((t) => (
                    <tr key={t.id}>
                      <td>
                        {t.name}
                        <br />
                        <span className="small muted mono">…{t.hint}</span>
                      </td>
                      <td className="small">{t.scope === "write" ? "Đọc + ghi kết quả + nháp" : "Chỉ đọc"}</td>
                      <td className="small">{fmtDateTime(t.lastUsedAt)}</td>
                      <td className="small">{t.revokedAt ? "Đã thu hồi" : fmtDate(t.expiresAt)}</td>
                      <td>
                        {!t.revokedAt && (
                          <form action={revokeTokenAction}>
                            <input type="hidden" name="id" value={t.id} />
                            <SubmitButton className="btn sm danger">Thu hồi</SubmitButton>
                          </form>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <form action={createTokenAction} className="form">
            <label className="full" htmlFor="tk-name">
              Tên token
              <input id="tk-name" name="name" placeholder="Antigravity · MacBook" required />
            </label>
            <label htmlFor="tk-scope">
              Quyền
              <select id="tk-scope" name="scope" defaultValue="write">
                <option value="write">Đọc + ghi kết quả + tạo nháp</option>
                <option value="read">Chỉ đọc</option>
              </select>
            </label>
            <label htmlFor="tk-days">
              Hết hạn sau
              <select id="tk-days" name="days" defaultValue="90">
                <option value="30">30 ngày</option>
                <option value="90">90 ngày</option>
                <option value="365">1 năm</option>
              </select>
            </label>
            <div className="full">
              <SubmitButton className="btn pri">Tạo token</SubmitButton>
            </div>
          </form>
        </div>
        <div className="stack">
          {fresh && (
            <div className="card aiz">
              <h2>
                Token vừa tạo <span className="tag">chỉ hiện một lần</span>
              </h2>
              <p className="small">Trong Antigravity mở phần quản lý MCP server, sửa file cấu hình MCP và dán đoạn dưới vào (gộp vào mcpServers nếu đã có). Tool phải đang chạy khi agent dùng.</p>
              {!process.env.QFH_PACKAGE_ROOT && process.env.NODE_ENV === "production" && (
                <p className="small">
                  Tool đang chạy trên server: tải <a href="/mcp-stdio.mjs" download>mcp-stdio.mjs</a> về máy (cần Node 20+), rồi sửa đường dẫn trong cấu hình bên dưới.
                </p>
              )}
              <pre className="codeblock">{mcpConfig(fresh, appUrl)}</pre>
              <div className="actions">
                <CopyButton text={mcpConfig(fresh, appUrl)} label="Copy cấu hình" />
                <CopyButton text={fresh} label="Chỉ copy token" />
              </div>
              <p className="small muted">Gợi ý câu lệnh cho agent: “Dùng qa-flow-hub, lấy test case build hiện tại của OP-110859, mở trình duyệt chạy từng TC, chụp ảnh ở bước kết quả, ghi kết quả, TC nào fail thì tạo nháp bug.”</p>
            </div>
          )}
          <div className="card">
            <h2>Đổi mật khẩu</h2>
            <form action={changePasswordAction} className="form">
              <label className="full" htmlFor="pw-cur">
                Mật khẩu hiện tại
                <input id="pw-cur" name="current" type="password" autoComplete="current-password" required />
              </label>
              <label htmlFor="pw-new">
                Mật khẩu mới
                <input id="pw-new" name="next" type="password" minLength={8} autoComplete="new-password" required />
              </label>
              <label htmlFor="pw-confirm">
                Nhập lại
                <input id="pw-confirm" name="confirm" type="password" minLength={8} autoComplete="new-password" required />
              </label>
              <div className="full">
                <SubmitButton className="btn pri">Đổi mật khẩu</SubmitButton>
              </div>
            </form>
          </div>
        </div>
      </div>
    </>
  );
}

import { redirect } from "next/navigation";
import { getDb } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { listConnections, type ConnectionView } from "@/lib/services/connections";
import { saveConnectionAction, checkConnectionAction } from "@/app/actions/admin";
import { fmtDateTime } from "@/lib/format";
import { Flash } from "@/components/Flash";
import { SubmitButton } from "@/components/SubmitButton";
import type { ConnectionKind } from "@/lib/db/schema";
import { jiraWebhookSecret } from "@/lib/webhookSecret";

function Status({ c }: { c?: ConnectionView }) {
  if (!c) return <span className="pill p-nr">Chưa nhập</span>;
  if (c.status === "ok") return <span className="pill p-pass">Đã kết nối</span>;
  if (c.status === "error") return <span className="pill p-fail">Lỗi</span>;
  return <span className="pill p-block">Chưa kiểm tra</span>;
}

function Shell({ kind, title, desc, c, children }: { kind: ConnectionKind; title: string; desc: string; c?: ConnectionView; children: React.ReactNode }) {
  return (
    <div className="card" id={kind}>
      <h2>
        {title} <Status c={c} />
      </h2>
      <p className="small muted">{desc}</p>
      {c?.statusMessage && (
        <p className="small" style={{ color: c.status === "ok" ? "var(--pass)" : c.status === "error" ? "var(--fail)" : undefined }}>
          {c.statusMessage} · {fmtDateTime(c.checkedAt)}
        </p>
      )}
      <form action={saveConnectionAction} className="form">
        <input type="hidden" name="kind" value={kind} />
        {children}
        <label className="full" htmlFor={`${kind}-secret`}>
          {kind === "jira" ? "API token (Cloud) hoặc Personal Access Token (Server / Data Center)" : kind === "slack" ? "Incoming webhook URL (Slack hoặc Microsoft Teams)" : kind === "git" ? "Webhook secret (tự đặt, dán giống hệt vào GitLab/GitHub)" : kind === "sso" ? "Client secret" : "API key"}
          <span className="hint">{c?.secretHint ? `Đang lưu token kết thúc bằng …${c.secretHint}. Để trống nếu không đổi.` : "Token được mã hoá trên server, không hiện lại trên trình duyệt."}</span>
          <input id={`${kind}-secret`} name="secret" type="password" autoComplete="off" placeholder={c?.secretHint ? `••••••••${c.secretHint}` : ""} />
        </label>
        <div className="full actions">
          <SubmitButton className="btn pri" name="check" value="1" pendingText="Đang lưu và kiểm tra…">
            Lưu và kiểm tra
          </SubmitButton>
          <SubmitButton className="btn" pendingText="Đang lưu…">
            Chỉ lưu
          </SubmitButton>
        </div>
      </form>
      {c && (
        <form action={checkConnectionAction}>
          <input type="hidden" name="kind" value={kind} />
          <SubmitButton className="btn sm" pendingText="Đang kiểm tra…">
            Kiểm tra lại
          </SubmitButton>
        </form>
      )}
    </div>
  );
}

export default async function ConnectionsPage({ searchParams }: PageProps<"/admin/connections">) {
  const user = await requireUser();
  if (!user.isAdmin) redirect("/board");
  const sp = await searchParams;
  const conns = await listConnections(await getDb());
  const j = conns.jira?.config ?? {};
  const t = conns.testlink?.config ?? {};
  const g = conns.gemini?.config ?? {};
  const sl = conns.slack?.config ?? {};
  const gt = conns.git?.config ?? {};
  const so = conns.sso?.config ?? {};
  const appUrl = process.env.APP_URL || "http://localhost:3000";
  return (
    <>
      <div className="sh">
        <div>
          <h1>Kết nối hệ thống</h1>
          <p>Chỉ Admin thấy màn này. Mọi thay đổi được ghi vào audit log.</p>
        </div>
      </div>
      <Flash ok={sp.ok} err={sp.err} />
      <div className="grid3">
        <Shell kind="jira" title="Jira" desc="Đọc sprint, story, subtask; gửi câu hỏi Q&A thành comment. Nên dùng một tài khoản bot có quyền trên dự án." c={conns.jira}>
          <label className="full" htmlFor="jira-baseUrl">
            Base URL
            <input id="jira-baseUrl" name="baseUrl" defaultValue={j.baseUrl} placeholder="https://congty.atlassian.net" required />
          </label>
          <label className="full" htmlFor="jira-flavor">
            Loại Jira
            <select id="jira-flavor" name="flavor" defaultValue={j.flavor ?? "cloud"}>
              <option value="cloud">Jira Cloud</option>
              <option value="dc">Server / Data Center</option>
            </select>
          </label>
          <label className="full" htmlFor="jira-email">
            Email tài khoản <span className="hint">chỉ cần với Cloud</span>
            <input id="jira-email" name="email" type="email" defaultValue={j.email} />
          </label>
        </Shell>
        <Shell kind="testlink" title="TestLink" desc="Tạo test suite và test case. Bật API trong TestLink và lấy API key ở My Settings → API interface." c={conns.testlink}>
          <label className="full" htmlFor="tl-url">
            URL XML-RPC
            <input id="tl-url" name="url" defaultValue={t.url} placeholder="https://testlink.congty.vn/lib/api/xmlrpc/v1/xmlrpc.php" required />
          </label>
          <label className="full" htmlFor="tl-author">
            Login tác giả test case <span className="hint">username TestLink sở hữu API key</span>
            <input id="tl-author" name="authorLogin" defaultValue={t.authorLogin} required />
          </label>
        </Shell>
        <Shell kind="gemini" title="Gemini" desc="AI phân tích requirement và sinh test case. Tạo API key tại aistudio.google.com." c={conns.gemini}>
          <label className="full" htmlFor="gm-model">
            Model <span className="hint">ví dụ gemini-3.5-flash; xem danh sách model trong AI Studio</span>
            <input id="gm-model" name="model" defaultValue={g.model ?? "gemini-3.5-flash"} required />
          </label>
        </Shell>
      </div>
      <div className="grid3">
        <Shell kind="slack" title="Slack / Teams" desc="Gửi report, báo deploy, báo bug đã fix chờ verify vào một kênh. Tạo Incoming Webhook trong Slack (hoặc Teams) rồi dán URL." c={conns.slack}>
          <label className="full" htmlFor="sl-channel">
            Tên kênh <span className="hint">chỉ để hiển thị</span>
            <input id="sl-channel" name="channel" defaultValue={sl.channel} placeholder="#qa-op" />
          </label>
        </Shell>
        <Shell kind="git" title="Git webhook" desc="Commit có mã bug trong message (vd “OP-111111 fix search”) tự gắn vào bug. Cần GitLab/GitHub gọi được tới máy chạy tool." c={conns.git}>
          <label className="full" htmlFor="git-provider">
            Nhà cung cấp
            <select id="git-provider" name="provider" defaultValue={gt.provider ?? "gitlab"}>
              <option value="gitlab">GitLab (header X-Gitlab-Token)</option>
              <option value="github">GitHub (chữ ký X-Hub-Signature-256)</option>
            </select>
          </label>
          <div className="full small">
            URL webhook (sự kiện Push): <code>{appUrl}/api/webhooks/git</code>
          </div>
        </Shell>
        <div className="card" id="jira-webhook">
          <h2>Webhook Jira (tuỳ chọn)</h2>
          <p className="small muted">
            Để trạng thái bug cập nhật ngay khi dev đổi trên Jira. Không có webhook thì trạng thái vẫn cập nhật mỗi lần bấm Đồng bộ Jira. Jira chỉ gọi được nếu máy chạy tool có địa chỉ Jira truy cập được.
          </p>
          <p className="small">Jira → System → WebHooks → Create, sự kiện “Issue updated”, URL:</p>
          <pre className="codeblock">{`${appUrl}/api/webhooks/jira?secret=${jiraWebhookSecret()}`}</pre>
        </div>
      </div>
      <div className="grid3">
        <Shell
          kind="sso"
          title="Đăng nhập SSO"
          desc="Đăng nhập bằng tài khoản công ty qua OpenID Connect (Google Workspace, Microsoft Entra ID, Keycloak…). Chỉ email đã được tạo tài khoản ở màn Người dùng mới vào được."
          c={conns.sso}
        >
          <label className="full" htmlFor="sso-label">
            Tên nút đăng nhập
            <input id="sso-label" name="label" defaultValue={so.label ?? "Google Workspace"} />
          </label>
          <label className="full" htmlFor="sso-issuer">
            Issuer URL <span className="hint">Google: https://accounts.google.com · Microsoft: https://login.microsoftonline.com/&lt;tenant-id&gt;/v2.0</span>
            <input id="sso-issuer" name="issuer" defaultValue={so.issuer} placeholder="https://accounts.google.com" required />
          </label>
          <label className="full" htmlFor="sso-client">
            Client ID
            <input id="sso-client" name="clientId" defaultValue={so.clientId} required />
          </label>
          <div className="full small">
            Redirect URI cần đăng ký: <code>{appUrl}/auth/sso/callback</code>
          </div>
        </Shell>
      </div>
      <p className="small muted">MCP cho Antigravity: mỗi người tự tạo token ở Hồ sơ.</p>
    </>
  );
}

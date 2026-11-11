import { redirect } from "next/navigation";
import { getDb } from "@/lib/db";
import { userCount } from "@/lib/services/users";
import { listConnections } from "@/lib/services/connections";
import { currentUser } from "@/lib/session";
import { loginAction } from "@/app/actions/auth";
import { Flash } from "@/components/Flash";
import { SubmitButton } from "@/components/SubmitButton";

// Depends on the database and cookies at request time.
export const dynamic = "force-dynamic";

export default async function LoginPage({ searchParams }: PageProps<"/login">) {
  if ((await userCount(await getDb())) === 0) redirect("/setup");
  if (await currentUser()) redirect("/board");
  const sp = await searchParams;
  const sso = (await listConnections(await getDb())).sso;
  const ssoLabel = sso?.config.issuer && sso.config.clientId && sso.secretHint ? sso.config.label || "SSO" : null;
  return (
    <main className="auth">
      <div className="box">
        <div className="brand">
          <span className="logo" aria-hidden="true">
            QA
          </span>
          <span>
            QA Flow Hub
            <small>Jira · TestLink · AI cho QC</small>
          </span>
        </div>
        <h1>Đăng nhập QA Flow Hub</h1>
        <p className="small muted">Tài khoản do Admin tạo. Quên mật khẩu thì nhờ Admin đặt lại.</p>
        <Flash err={sp.err} ok={sp.ok} />
        {ssoLabel && (
          <>
            <a className="btn pri" href="/auth/sso/start" style={{ justifyContent: "center", minHeight: 44 }}>
              Đăng nhập bằng {ssoLabel}
            </a>
            <div className="small muted" style={{ textAlign: "center" }}>
              hoặc dùng email và mật khẩu
            </div>
          </>
        )}
        <form action={loginAction} className="form">
          <label htmlFor="email">
            Email
            <input id="email" name="email" type="email" autoComplete="username" required />
          </label>
          <label htmlFor="password">
            Mật khẩu
            <input id="password" name="password" type="password" autoComplete="current-password" required />
          </label>
          <SubmitButton className="btn pri" pendingText="Đang đăng nhập…">
            Đăng nhập
          </SubmitButton>
        </form>
      </div>
    </main>
  );
}

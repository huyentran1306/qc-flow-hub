import { redirect } from "next/navigation";
import { getDb } from "@/lib/db";
import { userCount } from "@/lib/services/users";
import { setupAction } from "@/app/actions/auth";
import { Flash } from "@/components/Flash";
import { SubmitButton } from "@/components/SubmitButton";

// Depends on the database and cookies at request time.
export const dynamic = "force-dynamic";

export default async function SetupPage({ searchParams }: PageProps<"/setup">) {
  if ((await userCount(await getDb())) > 0) redirect("/login");
  const sp = await searchParams;
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
        <h1>Thiết lập lần đầu</h1>
        <p className="small muted">Tạo tài khoản Admin đầu tiên. Sau bước này bạn sẽ nhập kết nối Jira, TestLink, Gemini và mời thành viên.</p>
        <Flash err={sp.err} />
        <form action={setupAction} className="form">
          <label htmlFor="name">
            Tên hiển thị
            <input id="name" name="name" required />
          </label>
          <label htmlFor="email">
            Email
            <input id="email" name="email" type="email" autoComplete="username" required />
          </label>
          <label htmlFor="password">
            Mật khẩu <span className="hint">ít nhất 8 ký tự</span>
            <input id="password" name="password" type="password" minLength={8} autoComplete="new-password" required />
          </label>
          <SubmitButton className="btn pri" pendingText="Đang tạo…">
            Tạo tài khoản Admin
          </SubmitButton>
        </form>
      </div>
    </main>
  );
}

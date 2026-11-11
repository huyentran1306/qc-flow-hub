import Link from "next/link";
import { requireUser, currentProjectContext } from "@/lib/session";
import { can, ROLE_LABEL } from "@/lib/rbac";
import { NavLink } from "@/components/NavLink";
import { ProjectSwitcher } from "@/components/ProjectSwitcher";
import { Icon } from "@/components/Icon";
import { logoutAction } from "@/app/actions/auth";
import { Bell } from "@/components/Bell";

function initials(name: string) {
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] ?? "") + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase();
}

export default async function AppLayout({ children }: LayoutProps<"/">) {
  const user = await requireUser();
  const ctx = await currentProjectContext(user);
  const actor = { isAdmin: user.isAdmin, role: ctx.role };
  const roleText = ctx.role ? ROLE_LABEL[ctx.role] : user.isAdmin ? "Admin" : "Chưa có vai trò";

  return (
    <div className="shell">
      <nav className="side" aria-label="Menu chính">
        <Link href="/board" className="brand">
          <span className="logo" aria-hidden="true">
            QA
          </span>
          <span>
            QA Flow Hub
            <small>Quản lý quy trình test</small>
          </span>
        </Link>
        <div className="grp">Làm việc</div>
        {ctx.project && can(actor, "story.view") && (
          <NavLink href="/dashboard" icon="layers">
            Dashboard
          </NavLink>
        )}
        {ctx.project && can(actor, "story.view") && (
          <NavLink href="/my-work" icon="check">
            Việc của tôi
          </NavLink>
        )}
        <NavLink href="/board" icon="board">
          Sprint board
        </NavLink>
        {ctx.project && can(actor, "story.view") && (
          <NavLink href="/regression" icon="refresh">
            Regression
          </NavLink>
        )}
        {ctx.project && can(actor, "story.view") && (
          <NavLink href="/bugs" icon="bug">
            Sub-bug
          </NavLink>
        )}
        {ctx.project && can(actor, "story.view") && (
          <NavLink href="/agent" icon="sparkles">
            AI Agent
          </NavLink>
        )}
        {ctx.project && (
          <NavLink href="/gates" icon="shield">
            Quy tắc gate
          </NavLink>
        )}
        {user.isAdmin && (
          <>
            <div className="grp">Quản trị</div>
            <NavLink href="/admin/setup" icon="rocket">
              Thiết lập
            </NavLink>
            <NavLink href="/admin/connections" icon="link">
              Kết nối
            </NavLink>
            <NavLink href="/admin/projects" icon="folder">
              Dự án và ánh xạ
            </NavLink>
            <NavLink href="/admin/users" icon="users">
              Người dùng và quyền
            </NavLink>
            {can(actor, "audit.view") && (
              <NavLink href="/audit" icon="clock">
                Audit log
              </NavLink>
            )}
          </>
        )}
        <div className="spacer" />
        <div className="side-foot">Jira · TestLink · Gemini · Antigravity</div>
      </nav>
      <div className="main">
        <header className="topbar">
          {ctx.available.length ? <ProjectSwitcher current={ctx.project?.key ?? null} options={ctx.available} /> : <span className="small muted">Chưa có dự án nào</span>}
          <div className="topbar-right">
          <Bell userId={user.id} />
          <details className="usermenu">
            <summary>
              <span className="avatar" aria-hidden="true">
                {initials(user.name)}
              </span>
              <span className="who">
                <b>{user.name}</b>
                <small>{ctx.project ? `${ctx.project.key} · ${roleText}` : roleText}</small>
              </span>
            </summary>
            <div className="menu">
              <div className="menu-head">{user.email}</div>
              <Link href="/profile">
                <Icon name="user" size={16} /> Hồ sơ và token MCP
              </Link>
              <form action={logoutAction}>
                <button type="submit">
                  <Icon name="logout" size={16} /> Đăng xuất
                </button>
              </form>
            </div>
          </details>
          </div>
        </header>
        <main className="page">{children}</main>
      </div>
    </div>
  );
}

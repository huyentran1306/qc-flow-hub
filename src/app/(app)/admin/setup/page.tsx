import Link from "next/link";
import { redirect } from "next/navigation";
import { count, eq } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { memberships, projects, users } from "@/lib/db/schema";
import { requireUser } from "@/lib/session";
import { listConnections } from "@/lib/services/connections";
import { Flash } from "@/components/Flash";

export default async function SetupWizard({ searchParams }: PageProps<"/admin/setup">) {
  const sp = await searchParams;
  const user = await requireUser();
  if (!user.isAdmin) redirect("/board");
  const db = await getDb();
  const c = await listConnections(db);
  const realProjects = (await db.select().from(projects)).filter((p) => !p.isDemo);
  const [{ n: userN }] = await db.select({ n: count() }).from(users);
  const [{ n: memberN }] = await db.select({ n: count() }).from(memberships).innerJoin(projects, eq(projects.id, memberships.projectId)).where(eq(projects.isDemo, false));
  const steps = [
    { title: "Kết nối Jira", ok: c.jira?.status === "ok", detail: c.jira?.statusMessage ?? "Base URL, email bot và API token (hoặc PAT).", href: "/admin/connections#jira" },
    { title: "Kết nối TestLink", ok: c.testlink?.status === "ok", detail: c.testlink?.statusMessage ?? "Không bật được API thì bỏ qua: tool vẫn xuất file XML để import tay.", href: "/admin/connections#testlink" },
    { title: "Kết nối Gemini", ok: c.gemini?.status === "ok", detail: c.gemini?.statusMessage ?? "API key từ aistudio.google.com để AI phân tích, viết TC, viết bug, viết report.", href: "/admin/connections#gemini" },
    { title: "Tạo dự án và ánh xạ", ok: realProjects.some((p) => p.jiraBoardId), detail: realProjects.length ? `${realProjects.map((p) => p.key).join(", ")}${realProjects.some((p) => p.jiraBoardId) ? "" : " · chưa nhập board id"}` : "Mã dự án Jira, board id, project TestLink, tên issue type.", href: "/admin/projects" },
    { title: "Mời thành viên", ok: Number(userN) > 1 && Number(memberN) > 0, detail: `${userN} tài khoản, ${memberN} người đã được gán vào dự án.`, href: "/admin/users" },
  ];
  const done = steps.filter((s) => s.ok).length;
  return (
    <>
      <div className="sh">
        <div>
          <h1>Thiết lập</h1>
          <p>
            {done}/5 bước đã xong. Có thể bỏ qua bước 2 và 3, làm sau cũng được. Kết nối Slack, Git webhook ở màn <Link href="/admin/connections">Kết nối</Link>.
          </p>
        </div>
        <Link className="btn pri" href="/board">
          Tới Sprint board
        </Link>
      </div>
      <Flash ok={sp.ok} err={sp.err} />
      <div className="stepper">
        {steps.map((s, i) => (
          <div key={s.title} className={`st${s.ok ? " ok" : ""}`}>
            <i>{s.ok ? "✓" : i + 1}</i>
            <span>
              <b>{s.title}</b>
              <br />
              <span className="small muted">{s.detail}</span>
            </span>
            <Link className={`btn sm${s.ok ? "" : " pri"}`} href={s.href}>
              {s.ok ? "Xem" : "Làm"}
            </Link>
          </div>
        ))}
      </div>
    </>
  );
}

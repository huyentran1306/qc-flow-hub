import { redirect } from "next/navigation";
import { desc, eq } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { auditLogs, users } from "@/lib/db/schema";
import { requireUser } from "@/lib/session";
import { fmtDateTime } from "@/lib/format";

export default async function AuditPage() {
  const user = await requireUser();
  const db = await getDb();
  // The log spans every project, so only system admins may read it.
  if (!user.isAdmin) redirect("/board");
  const rows = await db
    .select({ at: auditLogs.at, action: auditLogs.action, target: auditLogs.target, source: auditLogs.source, detail: auditLogs.detail, name: users.name })
    .from(auditLogs)
    .leftJoin(users, eq(users.id, auditLogs.userId))
    .orderBy(desc(auditLogs.at))
    .limit(300);
  return (
    <>
      <div className="sh">
        <div>
          <h1>Audit log</h1>
          <p>300 thao tác gần nhất: ai làm, từ đâu, trên đối tượng nào.</p>
        </div>
      </div>
      <div className="tbl-wrap">
        <table>
          <thead>
            <tr>
              <th>Thời gian</th>
              <th>Ai</th>
              <th>Nguồn</th>
              <th>Hành động</th>
              <th>Đối tượng</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>
                <td className="mono small">{fmtDateTime(r.at)}</td>
                <td>{r.name ?? "Hệ thống"}</td>
                <td>
                  <span className="tag">{{ ui: "Giao diện", mcp: "MCP", webhook: "Webhook", system: "Hệ thống" }[r.source]}</span>
                </td>
                <td className="small">
                  {r.action}
                  {r.detail && "message" in r.detail ? <div className="muted">{String(r.detail.message)}</div> : null}
                </td>
                <td className="small key">{r.target ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

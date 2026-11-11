import Link from "next/link";
import { getDb } from "@/lib/db";
import { requireUser, currentProjectContext } from "@/lib/session";
import { can } from "@/lib/rbac";
import { listBugs, bugCode, SEVERITY_LABEL, BUG_STATUS_LABEL } from "@/lib/services/bugs";
import { ENV_LABEL } from "@/lib/services/execution";
import { fmtDateTime } from "@/lib/format";
import type { BugStatus } from "@/lib/db/schema";

const FILTERS: [string, string, BugStatus[] | undefined][] = [
  ["verify", "Chờ QC verify", ["resolved"]],
  ["open", "Đang mở", ["open", "in_progress", "resolved"]],
  ["draft", "Nháp", ["draft"]],
  ["closed", "Đã đóng", ["closed"]],
  ["all", "Tất cả", undefined],
];
const STATUS_CLASS: Record<BugStatus, string> = { draft: "p-ai", open: "p-fail", in_progress: "p-block", resolved: "p-acc", closed: "p-pass" };

export default async function ProjectBugsPage({ searchParams }: PageProps<"/bugs">) {
  const sp = await searchParams;
  const user = await requireUser();
  const db = await getDb();
  const ctx = await currentProjectContext(user, db);
  if (!ctx.project || !can({ isAdmin: user.isAdmin, role: ctx.role }, "story.view")) return <div className="empty">Chưa chọn dự án.</div>;
  const f = FILTERS.find((x) => x[0] === sp.f) ?? FILTERS[0];
  const rows = await listBugs(db, { projectId: ctx.project.id, statuses: f[2] });
  return (
    <>
      <div className="sh">
        <div>
          <h1>Sub-bug · {ctx.project.key}</h1>
          <p>Mọi bug của dự án. Bug dev chuyển Resolved nằm ở “Chờ QC verify”.</p>
        </div>
      </div>
      <div className="actions">
        {FILTERS.map(([k, label]) => (
          <Link key={k} href={`/bugs?f=${k}`} className={`btn sm${k === f[0] ? " pri" : ""}`}>
            {label}
          </Link>
        ))}
      </div>
      {rows.length === 0 ? (
        <div className="empty">Không có bug nào trong mục này.</div>
      ) : (
        <div className="tbl-wrap">
          <table>
            <thead>
              <tr>
                <th>Bug</th>
                <th>Story</th>
                <th>Severity</th>
                <th>Môi trường</th>
                <th>Trạng thái</th>
                <th>Commit fix</th>
                <th>Tạo lúc</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ bug: b, storyKey, storySummary }) => (
                <tr key={b.id}>
                  <td>
                    <Link className="key" href={`/stories/${storyKey}/bugs${b.status === "draft" ? `?edit=${b.id}#edit` : `#b-${b.id}`}`}>
                      {bugCode(b)}
                    </Link>
                    <br />
                    {b.title}
                  </td>
                  <td className="small">
                    <Link className="key" href={`/stories/${storyKey}`}>
                      {storyKey}
                    </Link>
                    <br />
                    <span className="muted">{storySummary}</span>
                  </td>
                  <td>
                    <span className="tag">{SEVERITY_LABEL[b.severity]}</span>
                  </td>
                  <td className="small">{ENV_LABEL[b.env]}</td>
                  <td>
                    <span className={`pill ${STATUS_CLASS[b.status]}`}>{BUG_STATUS_LABEL[b.status]}</span>
                    {b.jiraStatus && <div className="small muted">Jira: {b.jiraStatus}</div>}
                  </td>
                  <td className="small mono">{b.fixCommits.map((c) => c.sha.slice(0, 8)).join(", ") || "—"}</td>
                  <td className="small">{fmtDateTime(b.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

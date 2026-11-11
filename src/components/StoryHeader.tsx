import Link from "next/link";
import { STAGE_LABEL, fmtDateTime } from "@/lib/format";
import { ROLE_LABEL } from "@/lib/rbac";
import { ENV_LABEL } from "@/lib/services/execution";
import { Icon, type IconName } from "./Icon";
import type { Role, stories } from "@/lib/db/schema";

const TABS: [string, string, IconName][] = [
  ["", "Tổng quan", "file"],
  ["/run", "Thực thi", "play"],
  ["/bugs", "Sub-bug", "bug"],
  ["/reports", "Báo cáo", "list"],
  ["/env", "Môi trường và gate", "layers"],
];

export function StoryHeader({ story, role, tab, jiraUrl }: { story: typeof stories.$inferSelect; role: Role | null; tab: string; jiraUrl?: string | null }) {
  return (
    <>
      <div className="story-head">
        <div>
          <h1>
            <span className="keychip">{story.jiraKey}</span>
            {story.summary}
          </h1>
          <div className="meta">
            <span className="pill p-acc">{STAGE_LABEL[story.qaStage]}</span>
            <span>
              Môi trường <b>{ENV_LABEL[story.currentEnv]}</b>
            </span>
            <span className="sep" />
            <span>
              Jira <b>{story.jiraStatus || "—"}</b>
            </span>
            <span className="sep" />
            <span>
              Vai trò <b>{role ? ROLE_LABEL[role] : "chỉ xem"}</b>
            </span>
            <span className="sep" />
            <span>Đồng bộ {fmtDateTime(story.syncedAt)}</span>
          </div>
        </div>
        <div className="actions">
          <Link className="btn" href="/board">
            <Icon name="arrowLeft" size={16} /> Sprint board
          </Link>
          {jiraUrl && (
            <a className="btn" href={jiraUrl} target="_blank" rel="noreferrer">
              Mở trên Jira <Icon name="external" size={15} />
            </a>
          )}
        </div>
      </div>
      <nav className="subtabs" aria-label="Phần của story">
        {TABS.map(([suffix, label, icon]) => (
          <Link key={suffix} href={`/stories/${story.jiraKey}${suffix}`} aria-current={tab === suffix ? "page" : undefined}>
            <Icon name={icon} size={16} />
            {label}
          </Link>
        ))}
      </nav>
    </>
  );
}

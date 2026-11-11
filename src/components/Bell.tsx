import Link from "next/link";
import { getDb } from "@/lib/db";
import { latestNotifications, unreadCount } from "@/lib/services/notifications";
import { markAllReadAction } from "@/app/actions/extra";
import { fmtDateTime } from "@/lib/format";
import { Icon } from "./Icon";

export async function Bell({ userId }: { userId: string }) {
  const db = await getDb();
  const [n, list] = await Promise.all([unreadCount(db, userId), latestNotifications(db, userId, 8)]);
  return (
    <details className="bell">
      <summary aria-label={n ? `${n} thông báo chưa đọc` : "Thông báo"}>
        <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10.3 21a1.94 1.94 0 0 0 3.4 0" />
        </svg>
        {n > 0 && <span className="badge">{n > 99 ? "99+" : n}</span>}
      </summary>
      <div className="panel">
        <header>
          <span>Thông báo</span>
          {n > 0 && (
            <form action={markAllReadAction}>
              <input type="hidden" name="back" value="/dashboard" />
              <button type="submit" className="linkbtn">
                Đánh dấu đã đọc
              </button>
            </form>
          )}
        </header>
        {list.length === 0 && <p className="small muted" style={{ padding: "6px 10px 10px" }}>Chưa có thông báo nào.</p>}
        {list.map((x) => (
          <a key={x.id} href={`/notifications/${x.id}`} className={`note-item${x.readAt ? " read" : ""}`}>
            <span className="dot" aria-hidden="true" />
            <span>
              {x.title}
              {x.body && <small>{x.body}</small>}
              <small>{fmtDateTime(x.createdAt)}</small>
            </span>
          </a>
        ))}
        <Link href="/inbox" className="note-item" style={{ justifyContent: "center", fontWeight: 600 }}>
          <Icon name="list" size={15} /> Xem tất cả
        </Link>
      </div>
    </details>
  );
}

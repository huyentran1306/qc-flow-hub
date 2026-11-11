import { getDb } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { latestNotifications } from "@/lib/services/notifications";
import { markAllReadAction } from "@/app/actions/extra";
import { fmtDateTime } from "@/lib/format";
import { SubmitButton } from "@/components/SubmitButton";

const KIND = { bug_resolved: "Bug chờ verify", qna_reply: "Q&A", ai_draft: "Nháp AI", gate: "Môi trường", auto_run: "Chạy tự động", regression: "Regression", assigned: "Phụ trách" } as Record<string, string>;

export default async function InboxPage() {
  const user = await requireUser();
  const list = await latestNotifications(await getDb(), user.id, 100);
  return (
    <>
      <div className="sh">
        <div>
          <h1>Thông báo</h1>
          <p>100 thông báo gần nhất của bạn.</p>
        </div>
        <form action={markAllReadAction}>
          <input type="hidden" name="back" value="/inbox" />
          <SubmitButton className="btn">Đánh dấu tất cả đã đọc</SubmitButton>
        </form>
      </div>
      {list.length === 0 ? (
        <div className="empty">Chưa có thông báo nào.</div>
      ) : (
        <div className="card worklist">
          {list.map((n) => (
            <a key={n.id} href={`/notifications/${n.id}`} className={`note-item${n.readAt ? " read" : ""}`}>
              <span className="dot" aria-hidden="true" />
              <span>
                <span className="tag">{KIND[n.kind] ?? n.kind}</span> {n.title}
                {n.body && <small>{n.body}</small>}
                <small>{fmtDateTime(n.createdAt)}</small>
              </span>
            </a>
          ))}
        </div>
      )}
    </>
  );
}

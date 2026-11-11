import type { evidence } from "@/lib/db/schema";

export function EvidenceList({ items }: { items: (typeof evidence.$inferSelect)[] }) {
  if (!items.length) return null;
  return (
    <div className="thumbs">
      {items.map((ev) => (
        <a key={ev.id} href={`/files/${ev.id}`} target="_blank" rel="noreferrer" title={ev.fileName}>
          {ev.mime.startsWith("image/") && ev.mime !== "image/svg+xml" ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={`/files/${ev.id}`} alt={ev.fileName} />
          ) : (
            <span className="file">{ev.mime.startsWith("video/") ? "Video" : "File"}</span>
          )}
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{ev.fileName}</span>
        </a>
      ))}
    </div>
  );
}

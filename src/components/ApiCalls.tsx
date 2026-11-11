import type { apiCalls } from "@/lib/db/schema";

type Call = typeof apiCalls.$inferSelect;

function shortUrl(u: string) {
  try {
    const x = new URL(u);
    return x.pathname + x.search;
  } catch {
    return u;
  }
}

/** The "API result" of one execution: every call seen in the page, made directly, or reported by the agent. */
export function ApiCallList({ calls }: { calls: Call[] }) {
  if (!calls.length) return null;
  const bad = calls.filter((c) => c.status == null || c.status >= 400).length;
  return (
    <details className="apicalls" open={bad > 0}>
      <summary>
        <span className="tag">API</span> {calls.length} lời gọi
        {bad > 0 ? <span className="pill p-fail">{bad} lỗi</span> : <span className="pill p-pass">tất cả OK</span>}
      </summary>
      <div className="tbl-wrap">
        <table>
          <tbody>
            {calls.map((c) => (
              <tr key={c.id}>
                <td className="mono small" style={{ width: 64 }}>
                  {c.method}
                </td>
                <td className="small" style={{ wordBreak: "break-all" }}>
                  {shortUrl(c.url)}
                  {(c.responseBody || c.requestBody || c.error) && (
                    <details>
                      <summary className="small muted">chi tiết</summary>
                      {c.requestBody && (
                        <>
                          <div className="small muted">Request</div>
                          <pre className="codeblock">{c.requestBody}</pre>
                        </>
                      )}
                      {c.error && <div className="small" style={{ color: "var(--fail)" }}>{c.error}</div>}
                      {c.responseBody && (
                        <>
                          <div className="small muted">Response</div>
                          <pre className="codeblock">{c.responseBody}</pre>
                        </>
                      )}
                    </details>
                  )}
                </td>
                <td style={{ width: 70 }}>
                  <span className={`pill ${c.status == null || c.status >= 500 ? "p-fail" : c.status >= 400 ? "p-block" : "p-pass"}`}>{c.status ?? "lỗi"}</span>
                </td>
                <td className="small muted num" style={{ width: 64, textAlign: "right" }}>
                  {c.durationMs != null ? `${c.durationMs} ms` : ""}
                </td>
                <td className="small muted" style={{ width: 70 }}>
                  {c.source === "ui" ? "từ trang" : c.source === "api" ? "gọi trực tiếp" : "Antigravity"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}

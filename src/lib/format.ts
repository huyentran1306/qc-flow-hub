export const tcCode = (seq: number) => `TC-${String(seq).padStart(2, "0")}`;

export const STAGE_LABEL = {
  analyzing: "Đang phân tích",
  qna: "Q&A",
  tc_ready: "TC sẵn sàng",
  testing: "Đang test",
  done: "Xong",
} as const;

export function fmtDateTime(d: Date | string | null | undefined): string {
  if (!d) return "—";
  const x = typeof d === "string" ? new Date(d) : d;
  return x.toLocaleString("vi-VN", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Ho_Chi_Minh" });
}

export function fmtDate(d: Date | string | null | undefined): string {
  if (!d) return "—";
  const x = typeof d === "string" ? new Date(d) : d;
  return x.toLocaleDateString("vi-VN", { day: "2-digit", month: "2-digit", year: "numeric", timeZone: "Asia/Ho_Chi_Minh" });
}

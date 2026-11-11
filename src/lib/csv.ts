/** CSV that Excel opens correctly with Vietnamese text (UTF-8 BOM, CRLF, quoted fields).
 *  Cells starting with = + - @ are prefixed with ' so Excel does not run them as formulas. */
export function toCsv(rows: (string | number | null | undefined)[][]): string {
  const cell = (v: string | number | null | undefined) => {
    if (v == null) return "";
    if (typeof v === "number") return String(v);
    const s = /^[=+\-@]/.test(v) ? "'" + v : v;
    return /[",\r\n]/.test(s) || s !== v ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  return "﻿" + rows.map((r) => r.map(cell).join(",")).join("\r\n") + "\r\n";
}

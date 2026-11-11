import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

/** Types shown inline in the browser. Anything else (SVG, HTML, PDF…) is downloaded, never rendered on our origin. */
export const INLINE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp", "video/mp4", "video/webm", "video/quicktime"];

export function safeMime(mime: string | undefined | null): string {
  const m = (mime ?? "").toLowerCase().split(";")[0].trim();
  return INLINE_TYPES.includes(m) ? m : "application/octet-stream";
}

export function uploadDir(): string {
  const dir = process.env.UPLOAD_DIR || path.join(process.cwd(), ".data", "uploads");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function safeFileName(name: string): string {
  const base = path.basename(name).normalize("NFC").replace(/[^\p{L}\p{N}._ -]/gu, "_").slice(-120);
  return base || "file";
}

export function saveUpload(name: string, data: Buffer): string {
  if (data.length > MAX_UPLOAD_BYTES) throw new Error(`File ${name} lớn hơn 25 MB.`);
  const stored = `${randomUUID()}-${safeFileName(name)}`;
  fs.writeFileSync(path.join(uploadDir(), stored), data);
  return stored;
}

export function readUpload(stored: string): Buffer {
  if (stored.includes("/") || stored.includes("\\") || stored.includes("..")) throw new Error("Tên file không hợp lệ");
  return fs.readFileSync(path.join(uploadDir(), stored));
}

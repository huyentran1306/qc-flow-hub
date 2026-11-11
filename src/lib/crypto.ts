import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/** Secret for sessions and stored tokens.
 *  Production must set APP_SECRET. On a developer machine a random one is created once in
 *  .data/app-secret.txt, so `npm install && npm run dev` works right after cloning. */
export function appSecret(): string {
  const s = process.env.APP_SECRET;
  if (s && s.length >= 32) return s;
  if (process.env.NODE_ENV === "production") {
    throw new Error("APP_SECRET chưa được đặt hoặc ngắn hơn 32 ký tự. Xem file .env.example.");
  }
  const file = path.join(process.cwd(), ".data", "app-secret.txt");
  if (!fs.existsSync(file)) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, randomBytes(48).toString("base64"), { mode: 0o600 });
  }
  const local = fs.readFileSync(file, "utf8").trim();
  process.env.APP_SECRET = local;
  return local;
}

function derive(purpose: string): Buffer {
  return createHash("sha256").update(`${purpose}:${appSecret()}`).digest();
}

/** Encrypts an integration secret (API token, API key) for storage. */
export function encryptSecret(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", derive("secrets"), iv);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ["v1", iv.toString("base64"), tag.toString("base64"), ct.toString("base64")].join(".");
}

export function decryptSecret(enc: string): string {
  const [v, iv, tag, ct] = enc.split(".");
  if (v !== "v1" || !iv || !tag || !ct) throw new Error("Secret không đúng định dạng");
  const decipher = createDecipheriv("aes-256-gcm", derive("secrets"), Buffer.from(iv, "base64"));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(ct, "base64")), decipher.final()]).toString("utf8");
}

export function secretHint(plain: string): string {
  return plain.length <= 4 ? "••••" : plain.slice(-4);
}

export function sessionKey(): Uint8Array {
  return new Uint8Array(derive("session"));
}

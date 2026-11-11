import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

function appSecret(): string {
  const s = process.env.APP_SECRET;
  if (!s || s.length < 32) {
    throw new Error("APP_SECRET chưa được đặt hoặc ngắn hơn 32 ký tự. Xem file .env.example.");
  }
  return s;
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

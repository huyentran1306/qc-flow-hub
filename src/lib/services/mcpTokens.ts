import { createHash, randomBytes } from "node:crypto";
import { and, desc, eq, isNull } from "drizzle-orm";
import type { DB } from "../db";
import { mcpTokens, users } from "../db/schema";
import { audit } from "../audit";

const hash = (t: string) => createHash("sha256").update(t).digest("hex");

/** Returns the plain token once; only its hash is stored. */
export async function createMcpToken(db: DB, userId: string, name: string, scope: "read" | "write", days: number): Promise<string> {
  if (!name.trim()) throw new Error("Đặt tên cho token, ví dụ “Antigravity · MacBook”.");
  const token = `qfh_${randomBytes(24).toString("base64url")}`;
  await db.insert(mcpTokens).values({
    userId,
    name: name.trim(),
    tokenHash: hash(token),
    hint: token.slice(-4),
    scope,
    expiresAt: new Date(Date.now() + Math.min(Math.max(days, 1), 365) * 864e5),
  });
  await audit(db, { userId, action: `Tạo token MCP (${scope === "write" ? "đọc + ghi" : "chỉ đọc"})`, target: name.trim() });
  return token;
}

export async function listMcpTokens(db: DB, userId: string) {
  return db.select().from(mcpTokens).where(eq(mcpTokens.userId, userId)).orderBy(desc(mcpTokens.createdAt));
}

export async function revokeMcpToken(db: DB, userId: string, id: string) {
  const [t] = await db.update(mcpTokens).set({ revokedAt: new Date() }).where(and(eq(mcpTokens.id, id), eq(mcpTokens.userId, userId))).returning({ name: mcpTokens.name });
  if (t) await audit(db, { userId, action: "Thu hồi token MCP", target: t.name });
}

export async function authenticateMcp(db: DB, authorization: string | null) {
  const token = authorization?.match(/^Bearer\s+(qfh_[A-Za-z0-9_-]+)$/)?.[1];
  if (!token) return null;
  const [row] = await db
    .select({ t: mcpTokens, u: users })
    .from(mcpTokens)
    .innerJoin(users, eq(users.id, mcpTokens.userId))
    .where(and(eq(mcpTokens.tokenHash, hash(token)), isNull(mcpTokens.revokedAt)));
  if (!row || row.u.disabled || row.t.expiresAt < new Date()) return null;
  await db.update(mcpTokens).set({ lastUsedAt: new Date() }).where(eq(mcpTokens.id, row.t.id));
  return { user: { id: row.u.id, isAdmin: row.u.isAdmin, name: row.u.name }, scope: row.t.scope, tokenName: row.t.name };
}

import { and, count, desc, eq, inArray, isNull } from "drizzle-orm";
import type { DB } from "../db";
import { memberships, notifications, type Role } from "../db/schema";

export type NoticeInput = { kind: string; title: string; body?: string | null; link?: string | null };

export async function notifyUsers(db: DB, userIds: (string | null | undefined)[], n: NoticeInput, exceptUserId?: string | null) {
  const ids = [...new Set(userIds.filter((x): x is string => !!x && x !== exceptUserId))];
  if (!ids.length) return 0;
  await db.insert(notifications).values(ids.map((userId) => ({ userId, kind: n.kind, title: n.title.slice(0, 200), body: n.body?.slice(0, 500) ?? null, link: n.link ?? null })));
  return ids.length;
}

export async function projectMemberIds(db: DB, projectId: string, roles: Role[]) {
  const rows = await db.select({ userId: memberships.userId }).from(memberships).where(and(eq(memberships.projectId, projectId), inArray(memberships.role, roles)));
  return rows.map((r) => r.userId);
}

export async function unreadCount(db: DB, userId: string) {
  const [r] = await db.select({ n: count() }).from(notifications).where(and(eq(notifications.userId, userId), isNull(notifications.readAt)));
  return Number(r.n);
}

export async function latestNotifications(db: DB, userId: string, limit = 30) {
  return db.select().from(notifications).where(eq(notifications.userId, userId)).orderBy(desc(notifications.createdAt)).limit(limit);
}

export async function markAllRead(db: DB, userId: string) {
  await db.update(notifications).set({ readAt: new Date() }).where(and(eq(notifications.userId, userId), isNull(notifications.readAt)));
}

export async function markRead(db: DB, userId: string, id: string) {
  const [n] = await db.update(notifications).set({ readAt: new Date() }).where(and(eq(notifications.id, id), eq(notifications.userId, userId))).returning();
  return n ?? null;
}

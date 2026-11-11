import bcrypt from "bcryptjs";
import { and, count, eq } from "drizzle-orm";
import type { DB } from "../db";
import { memberships, projects, users, type Role } from "../db/schema";
import { audit } from "../audit";

export async function userCount(db: DB): Promise<number> {
  const [r] = await db.select({ n: count() }).from(users);
  return Number(r.n);
}

function validate(email: string, name: string, password: string) {
  if (!/^[^@\s]+@[^@\s]+$/.test(email)) throw new Error("Email không hợp lệ.");
  if (!name.trim()) throw new Error("Cần nhập tên.");
  if (password.length < 8) throw new Error("Mật khẩu cần ít nhất 8 ký tự.");
}

export async function createUser(
  db: DB,
  actorId: string | null,
  input: { email: string; name: string; password: string; isAdmin: boolean },
): Promise<string> {
  const email = input.email.trim().toLowerCase();
  validate(email, input.name, input.password);
  const [exists] = await db.select({ id: users.id }).from(users).where(eq(users.email, email));
  if (exists) throw new Error("Email này đã có tài khoản.");
  const [u] = await db
    .insert(users)
    .values({ email, name: input.name.trim(), passwordHash: await bcrypt.hash(input.password, 10), isAdmin: input.isAdmin })
    .returning({ id: users.id });
  await audit(db, { userId: actorId ?? u.id, action: input.isAdmin ? "Tạo tài khoản Admin" : "Tạo tài khoản", target: email });
  return u.id;
}

/** Creates the very first account as Admin. Refuses once any user exists. */
export async function createFirstAdmin(db: DB, input: { email: string; name: string; password: string }): Promise<string> {
  if ((await userCount(db)) > 0) throw new Error("Hệ thống đã có tài khoản. Hãy đăng nhập.");
  return createUser(db, null, { ...input, isAdmin: true });
}

export async function verifyLogin(db: DB, email: string, password: string) {
  const [u] = await db.select().from(users).where(eq(users.email, email.trim().toLowerCase()));
  if (!u || u.disabled) return null;
  return (await bcrypt.compare(password, u.passwordHash)) ? u : null;
}

export async function changePassword(db: DB, userId: string, current: string, next: string): Promise<void> {
  const [u] = await db.select().from(users).where(eq(users.id, userId));
  if (!u || !(await bcrypt.compare(current, u.passwordHash))) throw new Error("Mật khẩu hiện tại không đúng.");
  if (next.length < 8) throw new Error("Mật khẩu mới cần ít nhất 8 ký tự.");
  await db.update(users).set({ passwordHash: await bcrypt.hash(next, 10), sessionVersion: u.sessionVersion + 1 }).where(eq(users.id, userId));
  await audit(db, { userId, action: "Đổi mật khẩu (đăng xuất mọi phiên cũ)" });
}

export async function setAdmin(db: DB, actorId: string, userId: string, isAdmin: boolean): Promise<void> {
  if (actorId === userId && !isAdmin) throw new Error("Không thể tự bỏ quyền Admin của chính mình.");
  const [u] = await db.update(users).set({ isAdmin }).where(eq(users.id, userId)).returning({ email: users.email });
  await audit(db, { userId: actorId, action: isAdmin ? "Cấp quyền Admin" : "Bỏ quyền Admin", target: u?.email });
}

export async function setDisabled(db: DB, actorId: string, userId: string, disabled: boolean): Promise<void> {
  if (actorId === userId) throw new Error("Không thể tự khoá tài khoản của chính mình.");
  const [cur] = await db.select().from(users).where(eq(users.id, userId));
  const [u] = await db.update(users).set({ disabled, sessionVersion: (cur?.sessionVersion ?? 0) + 1 }).where(eq(users.id, userId)).returning({ email: users.email });
  await audit(db, { userId: actorId, action: disabled ? "Khoá tài khoản" : "Mở khoá tài khoản", target: u?.email });
}

/** role = null removes the user from the project. */
export async function setMembership(db: DB, actorId: string, userId: string, projectId: string, role: Role | null): Promise<void> {
  await db.delete(memberships).where(and(eq(memberships.userId, userId), eq(memberships.projectId, projectId)));
  if (role) await db.insert(memberships).values({ userId, projectId, role });
  const [u] = await db.select({ email: users.email }).from(users).where(eq(users.id, userId));
  const [p] = await db.select({ key: projects.key }).from(projects).where(eq(projects.id, projectId));
  await audit(db, { userId: actorId, action: role ? `Gán vai trò ${role}` : "Gỡ khỏi dự án", target: `${u?.email} · ${p?.key}` });
}

export async function listUsersWithRoles(db: DB) {
  const all = await db.select().from(users).orderBy(users.createdAt);
  const ms = await db.select().from(memberships);
  return all.map((u) => ({
    id: u.id,
    email: u.email,
    name: u.name,
    isAdmin: u.isAdmin,
    disabled: u.disabled,
    roles: Object.fromEntries(ms.filter((m) => m.userId === u.id).map((m) => [m.projectId, m.role])) as Record<string, Role>,
  }));
}

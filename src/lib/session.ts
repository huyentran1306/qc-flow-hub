import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { SignJWT, jwtVerify } from "jose";
import { eq } from "drizzle-orm";
import { getDb, type DB } from "./db";
import { users } from "./db/schema";
import { sessionKey } from "./crypto";
import { projectContext, type ProjectContext } from "./services/projects";
import { assertCan, type AdminPerm, type Perm } from "./rbac";

const SESSION_COOKIE = "qfh_session";
const PROJECT_COOKIE = "qfh_project";
const MAX_AGE = 7 * 24 * 3600;
const secure = () => (process.env.APP_URL ?? "").startsWith("https://");

export type CurrentUser = { id: string; email: string; name: string; isAdmin: boolean };

export async function startSession(userId: string): Promise<void> {
  const db = await getDb();
  const [u] = await db.select({ v: users.sessionVersion }).from(users).where(eq(users.id, userId));
  const jwt = await new SignJWT({ v: u?.v ?? 0 }).setProtectedHeader({ alg: "HS256" }).setSubject(userId).setIssuedAt().setExpirationTime(`${MAX_AGE}s`).sign(sessionKey());
  (await cookies()).set(SESSION_COOKIE, jwt, { httpOnly: true, sameSite: "lax", secure: secure(), path: "/", maxAge: MAX_AGE });
}

export async function endSession(): Promise<void> {
  (await cookies()).delete(SESSION_COOKIE);
}

export async function currentUser(): Promise<CurrentUser | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return null;
  let sub: string | undefined;
  let v: unknown;
  try {
    ({ sub, v } = (await jwtVerify(token, sessionKey(), { algorithms: ["HS256"] })).payload as { sub?: string; v?: unknown });
  } catch {
    return null;
  }
  if (!sub) return null;
  const db = await getDb();
  const [u] = await db.select().from(users).where(eq(users.id, sub));
  if (!u || u.disabled || (v ?? 0) !== u.sessionVersion) return null;
  return { id: u.id, email: u.email, name: u.name, isAdmin: u.isAdmin };
}

export async function requireUser(): Promise<CurrentUser> {
  const u = await currentUser();
  if (!u) redirect("/login");
  return u;
}

export async function setCurrentProject(key: string): Promise<void> {
  (await cookies()).set(PROJECT_COOKIE, key, { httpOnly: true, sameSite: "lax", secure: secure(), path: "/", maxAge: 365 * 24 * 3600 });
}

export async function currentProjectContext(user: CurrentUser, db?: DB): Promise<ProjectContext> {
  const preferred = (await cookies()).get(PROJECT_COOKIE)?.value ?? null;
  return projectContext(db ?? (await getDb()), user, preferred);
}

/** For server actions: signed-in user + permission check in the current project. */
export async function actorFor(perm: Perm | AdminPerm) {
  const user = await currentUser();
  if (!user) throw new Error("Phiên đăng nhập đã hết. Hãy đăng nhập lại.");
  const db = await getDb();
  const ctx = await currentProjectContext(user, db);
  assertCan({ isAdmin: user.isAdmin, role: ctx.role }, perm);
  return { db, user, ctx };
}

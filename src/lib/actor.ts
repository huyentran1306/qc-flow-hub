import { eq } from "drizzle-orm";
import { getDb } from "./db";
import { bugs, builds, executions, stories } from "./db/schema";
import { currentUser } from "./session";
import { roleIn } from "./services/projects";
import { assertCan, type Perm } from "./rbac";

/** Signed-in user + permission check against the project that owns the story. */
export async function storyActorById(storyId: string, perm: Perm) {
  const user = await currentUser();
  if (!user) throw new Error("Phiên đăng nhập đã hết. Hãy đăng nhập lại.");
  const db = await getDb();
  const [story] = await db.select().from(stories).where(eq(stories.id, storyId));
  if (!story) throw new Error("Không tìm thấy story.");
  const role = await roleIn(db, user.id, story.projectId);
  assertCan({ isAdmin: user.isAdmin, role }, perm);
  return { db, user, story, role };
}

export async function storyIdOfBuild(buildId: string) {
  const db = await getDb();
  const [b] = await db.select().from(builds).where(eq(builds.id, buildId));
  if (!b) throw new Error("Không tìm thấy build.");
  return b.storyId;
}

export async function storyIdOfExecution(executionId: string) {
  const db = await getDb();
  const [r] = await db.select({ storyId: builds.storyId }).from(executions).innerJoin(builds, eq(builds.id, executions.buildId)).where(eq(executions.id, executionId));
  if (!r) throw new Error("Không tìm thấy lần thực thi.");
  return r.storyId;
}

export async function storyIdOfBug(bugId: string) {
  const db = await getDb();
  const [b] = await db.select().from(bugs).where(eq(bugs.id, bugId));
  if (!b) throw new Error("Không tìm thấy bug.");
  return b.storyId;
}

import { notFound } from "next/navigation";
import { getDb } from "./db";
import { requireUser } from "./session";
import { roleIn } from "./services/projects";
import { storyByKey } from "./services/stories";
import { can } from "./rbac";

/** Shared loader for the story sub-pages: signed-in user, story data, and the user's role in its project. */
export async function loadStoryPage(key: string) {
  const user = await requireUser();
  const db = await getDb();
  const data = await storyByKey(db, key);
  if (!data) notFound();
  const role = await roleIn(db, user.id, data.project.id);
  const actor = { isAdmin: user.isAdmin, role };
  return { user, db, data, role, actor, allowed: can(actor, "story.view") };
}

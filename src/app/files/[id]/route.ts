import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { bugs, builds, evidence, executions, stories } from "@/lib/db/schema";
import { currentUser } from "@/lib/session";
import { roleIn } from "@/lib/services/projects";
import { can } from "@/lib/rbac";
import { INLINE_TYPES, readUpload } from "@/lib/storage";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const user = await currentUser();
  if (!user) return new Response("Chưa đăng nhập", { status: 401 });
  const db = await getDb();
  const [ev] = await db.select().from(evidence).where(eq(evidence.id, id));
  if (!ev) return new Response("Không tìm thấy", { status: 404 });
  let storyId: string | undefined;
  if (ev.ownerType === "execution") {
    const [r] = await db.select({ storyId: builds.storyId }).from(executions).innerJoin(builds, eq(builds.id, executions.buildId)).where(eq(executions.id, ev.ownerId));
    storyId = r?.storyId;
  } else {
    const [b] = await db.select({ storyId: bugs.storyId }).from(bugs).where(eq(bugs.id, ev.ownerId));
    storyId = b?.storyId;
  }
  const [s] = storyId ? await db.select().from(stories).where(eq(stories.id, storyId)) : [];
  if (!s || !can({ isAdmin: user.isAdmin, role: await roleIn(db, user.id, s.projectId) }, "story.view")) return new Response("Không có quyền", { status: 403 });
  const inline = INLINE_TYPES.includes(ev.mime);
  return new Response(new Uint8Array(readUpload(ev.storedName)), {
    headers: {
      "Content-Type": inline ? ev.mime : "application/octet-stream",
      "Content-Security-Policy": "sandbox; default-src 'none'; img-src 'self'; media-src 'self'",
      "Content-Disposition": `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(ev.fileName)}`,
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "private, max-age=3600",
    },
  });
}

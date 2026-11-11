import { getDb } from "@/lib/db";
import { currentUser } from "@/lib/session";
import { markRead } from "@/lib/services/notifications";

export const dynamic = "force-dynamic";

/** Opens a notification: marks it read and goes to its page (same-site paths only). */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const user = await currentUser();
  const base = new URL(req.url);
  if (!user) return Response.redirect(new URL("/login", base), 303);
  const n = await markRead(await getDb(), user.id, id);
  const link = n?.link && n.link.startsWith("/") && !n.link.startsWith("//") ? n.link : "/inbox";
  return Response.redirect(new URL(link, base), 303);
}

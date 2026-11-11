import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { connections } from "@/lib/db/schema";
import { loadGitSecret } from "@/lib/services/connections";
import { addFixCommit } from "@/lib/services/bugs";
import { commitsFromPush, issueKeysIn, verifyGitWebhook } from "@/lib/integrations/git";

export const dynamic = "force-dynamic";

/** GitLab / GitHub push events: commits whose message mentions a bug key get attached to that bug. */
export async function POST(req: Request) {
  const db = await getDb();
  const secret = await loadGitSecret(db);
  if (!secret) return new Response("git webhook not configured", { status: 404 });
  const raw = await req.text();
  const provider = verifyGitWebhook(req.headers, raw, secret);
  if (!provider) return new Response("forbidden", { status: 403 });
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return new Response("bad json", { status: 400 });
  }
  let linked = 0;
  for (const c of commitsFromPush(body)) for (const key of issueKeysIn(c.message)) if (await addFixCommit(db, key, c)) linked++;
  await db
    .update(connections)
    .set({ status: "ok", statusMessage: `Nhận sự kiện push từ ${provider === "gitlab" ? "GitLab" : "GitHub"}`, checkedAt: new Date() })
    .where(eq(connections.kind, "git"));
  return Response.json({ ok: true, linked });
}

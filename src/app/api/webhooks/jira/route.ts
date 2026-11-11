import { timingSafeEqual } from "node:crypto";
import { getDb } from "@/lib/db";
import { applyJiraStatus } from "@/lib/services/bugs";
import { jiraWebhookSecret } from "@/lib/webhookSecret";

export const dynamic = "force-dynamic";

/** Jira → Hub: issue status changes (configure in Jira → System → Webhooks, event “Issue updated”). */
export async function POST(req: Request) {
  const given = Buffer.from(new URL(req.url).searchParams.get("secret") ?? "");
  const expected = Buffer.from(jiraWebhookSecret());
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return new Response("forbidden", { status: 403 });
  const body = (await req.json().catch(() => null)) as { issue?: { key?: string; fields?: { status?: { name?: string } } } } | null;
  const key = body?.issue?.key;
  const status = body?.issue?.fields?.status?.name;
  if (!key || !status) return Response.json({ ok: true, ignored: true });
  const changed = await applyJiraStatus(await getDb(), key, status);
  return Response.json({ ok: true, changed });
}

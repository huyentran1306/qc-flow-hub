import { createHash } from "node:crypto";

/** Secret for the Jira webhook URL, derived from APP_SECRET so it needs no extra setup. */
export function jiraWebhookSecret(): string {
  return createHash("sha256").update(`jira-webhook:${process.env.APP_SECRET ?? ""}`).digest("base64url").slice(0, 32);
}

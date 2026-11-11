import { createHash } from "node:crypto";
import { appSecret } from "./crypto";

/** Secret for the Jira webhook URL, derived from APP_SECRET so it needs no extra setup. */
export function jiraWebhookSecret(): string {
  return createHash("sha256").update(`jira-webhook:${appSecret()}`).digest("base64url").slice(0, 32);
}

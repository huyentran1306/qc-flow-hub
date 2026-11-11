import type { DB } from "../db";
import { loadSlackUrl } from "./connections";
import { postWebhookMessage } from "../integrations/slack";

/** Best-effort Slack/Teams message. Never throws: a chat outage must not block QC work. */
export async function notify(db: DB, text: string): Promise<boolean> {
  try {
    const url = await loadSlackUrl(db);
    if (!url) return false;
    await postWebhookMessage(url, text);
    return true;
  } catch (e) {
    console.error("[notify]", (e as Error).message);
    return false;
  }
}

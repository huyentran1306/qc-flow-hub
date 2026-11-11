import { IntegrationError, fetchWithTimeout } from "./http";

/** Posts a plain-text message to a Slack (or Microsoft Teams) incoming webhook. */
export async function postWebhookMessage(webhookUrl: string, text: string): Promise<void> {
  let res: Response;
  try {
    res = await fetchWithTimeout(webhookUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text }) });
  } catch (e) {
    throw new IntegrationError("Slack", `không gửi được (${(e as Error).message})`);
  }
  if (!res.ok) throw new IntegrationError("Slack", `HTTP ${res.status}`, res.status);
}

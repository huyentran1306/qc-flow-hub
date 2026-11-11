import type { Browser } from "playwright-core";

/** Uses the Chrome or Edge already installed on the machine (no browser download needed). */
export async function launchBrowser(headed: boolean): Promise<Browser> {
  const { chromium } = await import("playwright-core");
  const channels = process.platform === "win32" ? ["msedge", "chrome"] : ["chrome", "msedge"];
  for (const channel of channels) {
    try {
      return await chromium.launch({ channel, headless: !headed });
    } catch {
      /* try the next one */
    }
  }
  throw new Error("Không mở được trình duyệt. Máy cần cài Google Chrome (hoặc Microsoft Edge trên Windows).");
}

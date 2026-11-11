import { getDb } from "./db";
import { loadAi } from "./services/connections";
import { runDueSuites } from "./services/regression";

const g = globalThis as unknown as { __qfhScheduler?: ReturnType<typeof setInterval> };

/** Checks every minute for regression suites that are due. Runs only while the tool is running. */
export function startScheduler() {
  if (g.__qfhScheduler) return;
  const origin = process.env.APP_URL || `http://localhost:${process.env.PORT || 3000}`;
  const tick = async () => {
    try {
      const db = await getDb();
      await runDueSuites(db, () => loadAi(db), origin);
    } catch (e) {
      console.error("[scheduler]", (e as Error).message);
    }
  };
  g.__qfhScheduler = setInterval(tick, 60_000);
  g.__qfhScheduler.unref?.();
}

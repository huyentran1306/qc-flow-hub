// Starts the in-process scheduler for regression suites (Node.js runtime only).
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs" || process.env.QFH_DISABLE_SCHEDULER === "1") return;
  const { startScheduler } = await import("./lib/scheduler");
  startScheduler();
}

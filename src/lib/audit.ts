import type { DB } from "./db";
import { auditLogs } from "./db/schema";

export async function audit(
  db: DB,
  entry: { userId: string | null; action: string; target?: string; detail?: Record<string, unknown>; source?: "ui" | "mcp" | "webhook" | "system" },
): Promise<void> {
  await db.insert(auditLogs).values({
    userId: entry.userId,
    action: entry.action,
    target: entry.target ?? null,
    detail: entry.detail ?? null,
    source: entry.source ?? "ui",
  });
}

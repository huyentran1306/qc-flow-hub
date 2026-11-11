import { eq, max } from "drizzle-orm";
import type { DB } from "./db";
import { testCases } from "./db/schema";

function isUniqueViolation(e: unknown): boolean {
  const err = e as { code?: string; cause?: { code?: string } };
  return err?.code === "23505" || err?.cause?.code === "23505";
}

/** Inserts test cases with the next TC numbers of the story. Retries when a concurrent insert took the same numbers. */
export async function insertWithNextSeq<T>(db: DB, storyId: string, insert: (firstSeq: number) => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const [{ m }] = await db.select({ m: max(testCases.seq) }).from(testCases).where(eq(testCases.storyId, storyId));
    try {
      return await insert(Number(m ?? 0) + 1);
    } catch (e) {
      if (!isUniqueViolation(e) || attempt >= 4) throw e;
    }
  }
}

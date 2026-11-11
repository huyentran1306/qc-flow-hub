import { and, eq, ne } from "drizzle-orm";
import type { DB } from "../db";
import { bugs, stories } from "../db/schema";
import { bugCode } from "./bugs";

const STOP = new Set(["khi", "thi", "va", "la", "cua", "cho", "voi", "khong", "duoc", "co", "mot", "cac", "nhung", "trong", "tren", "the", "and", "for", "with", "not", "bi", "da", "se", "nay", "do", "o", "tai", "ve"]);

/** Lowercase, strip Vietnamese diacritics and punctuation, keep meaningful words. */
export function tokens(text: string): Set<string> {
  const plain = text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/đ/gi, "d")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ");
  return new Set(plain.split(" ").filter((w) => w.length >= 2 && !STOP.has(w)));
}

export function similarity(a: string, b: string): number {
  const x = tokens(a);
  const y = tokens(b);
  if (!x.size || !y.size) return 0;
  let inter = 0;
  for (const w of x) if (y.has(w)) inter++;
  return inter / (x.size + y.size - inter);
}

/** Existing bugs in the same project that look like the given one (title weighs most). */
export async function similarBugs(db: DB, bugId: string, threshold = 0.3, limit = 3) {
  const [b] = await db.select().from(bugs).where(eq(bugs.id, bugId));
  if (!b) return [];
  const [s] = await db.select().from(stories).where(eq(stories.id, b.storyId));
  const others = await db
    .select({ bug: bugs, storyKey: stories.jiraKey })
    .from(bugs)
    .innerJoin(stories, eq(stories.id, bugs.storyId))
    .where(and(eq(stories.projectId, s.projectId), ne(bugs.id, bugId), ne(bugs.status, "draft")));
  const me = `${b.title} ${b.title} ${b.actual}`;
  return others
    .map((o) => ({ code: bugCode(o.bug), title: o.bug.title, status: o.bug.status, storyKey: o.storyKey, id: o.bug.id, score: similarity(me, `${o.bug.title} ${o.bug.title} ${o.bug.actual}`) }))
    .filter((x) => x.score >= threshold)
    .sort((a, z) => z.score - a.score)
    .slice(0, limit);
}

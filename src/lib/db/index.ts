import path from "node:path";
import fs from "node:fs";
import postgres from "postgres";
import type { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { drizzle as drizzlePg } from "drizzle-orm/postgres-js";
import { migrate as migratePg } from "drizzle-orm/postgres-js/migrator";
import * as schema from "./schema";

// Both drivers expose the same query API; we type against the PGlite one.
export type DB = ReturnType<typeof drizzlePglite<typeof schema>>;

const migrationsFolder = path.join(process.cwd(), "drizzle");

/** Opens a database and applies pending migrations.
 *  - DATABASE_URL set: real Postgres (server deployments).
 *  - otherwise: embedded PGlite stored in ./.data/pglite (local use, no install).
 *  - memory: true: throwaway in-memory database (tests). */
export async function openDb(opts: { memory?: boolean } = {}): Promise<DB> {
  if (!opts.memory && process.env.DATABASE_URL) {
    const client = postgres(process.env.DATABASE_URL, { max: 10 });
    const db = drizzlePg(client, { schema });
    await migratePg(db, { migrationsFolder });
    return db as unknown as DB;
  }
  // PGlite is loaded only when used, so Postgres deployments never touch it.
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const { migrate } = await import("drizzle-orm/pglite/migrator");
  let client: InstanceType<typeof PGlite>;
  if (opts.memory) {
    client = new PGlite();
  } else {
    const dir = process.env.PGLITE_DIR || path.join(process.cwd(), ".data", "pglite");
    fs.mkdirSync(dir, { recursive: true });
    client = new PGlite(dir);
  }
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder });
  return db;
}

const g = globalThis as unknown as { __qfhDb?: Promise<DB>; __qfhJournal?: number };

const journalFile = path.join(migrationsFolder, "meta", "_journal.json");
function journalStamp(): number {
  try {
    return fs.statSync(journalFile).mtimeMs;
  } catch {
    return 0;
  }
}

async function migrateExisting(db: DB): Promise<void> {
  if (process.env.DATABASE_URL) await migratePg(db as unknown as Parameters<typeof migratePg>[0], { migrationsFolder });
  else {
    const { migrate } = await import("drizzle-orm/pglite/migrator");
    await migrate(db, { migrationsFolder });
  }
}

/** Shared connection for the app (survives dev hot reloads).
 *  In development, migrations added while the server is running are applied on the next request,
 *  so a long-running `next dev` never queries a schema older than the code. */
export function getDb(): Promise<DB> {
  const stamp = journalStamp();
  if (!g.__qfhDb) {
    g.__qfhJournal = stamp;
    g.__qfhDb = openDb().catch((err) => {
      g.__qfhDb = undefined;
      throw err;
    });
  } else if (process.env.NODE_ENV !== "production" && g.__qfhJournal !== stamp) {
    g.__qfhJournal = stamp;
    const prev = g.__qfhDb;
    g.__qfhDb = prev.then(async (db) => {
      await migrateExisting(db);
      return db;
    });
    g.__qfhDb.catch(() => {
      g.__qfhJournal = undefined; // retry on the next request
      g.__qfhDb = prev;
    });
  }
  return g.__qfhDb;
}

export { schema };

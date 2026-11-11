import { eq } from "drizzle-orm";
import type { DB } from "../db";
import { projects, type Env } from "../db/schema";
import { decryptSecret, encryptSecret } from "../crypto";
import { audit } from "../audit";

export type TestAccount = { username: string; password: string };
export type TestAccounts = Partial<Record<Env, TestAccount>>;

export function readAccounts(enc: string | null): TestAccounts {
  if (!enc) return {};
  try {
    return JSON.parse(decryptSecret(enc)) as TestAccounts;
  } catch {
    return {};
  }
}

/** Usernames are shown back; passwords never are. An empty password keeps the stored one. */
export async function saveAccountsFromForm(db: DB, userId: string, projectId: string, fd: FormData) {
  const [p] = await db.select().from(projects).where(eq(projects.id, projectId));
  const cur = readAccounts(p.testAccountsEnc);
  const next: TestAccounts = {};
  for (const env of ["dev", "stg", "prod"] as Env[]) {
    const username = String(fd.get(`acc.${env}.username`) ?? "").trim();
    const password = String(fd.get(`acc.${env}.password`) ?? "");
    if (!username) continue;
    next[env] = { username, password: password || cur[env]?.password || "" };
  }
  const changed = JSON.stringify(next) !== JSON.stringify(cur);
  if (!changed) return;
  await db.update(projects).set({ testAccountsEnc: Object.keys(next).length ? encryptSecret(JSON.stringify(next)) : null }).where(eq(projects.id, projectId));
  await audit(db, { userId, action: "Cập nhật tài khoản test", target: p.key });
}

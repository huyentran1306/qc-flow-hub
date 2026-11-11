import { cookies } from "next/headers";
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { users } from "@/lib/db/schema";
import { loadSso } from "@/lib/services/connections";
import { completeAuth, type SsoState } from "@/lib/sso";
import { startSession } from "@/lib/session";
import { withFlash } from "@/lib/flash";
import { audit } from "@/lib/audit";

export const dynamic = "force-dynamic";

const appUrl = () => (process.env.APP_URL || "http://localhost:3000").replace(/\/+$/, "");
const fail = (msg: string) => Response.redirect(appUrl() + withFlash("/login", { err: msg }), 303);

export async function GET(req: Request) {
  const db = await getDb();
  const cfg = await loadSso(db);
  if (!cfg) return fail("Chưa cấu hình đăng nhập SSO.");
  const jar = await cookies();
  let saved: SsoState | null = null;
  try {
    saved = JSON.parse(jar.get("qfh_sso")?.value ?? "null");
  } catch {
    saved = null;
  }
  jar.delete({ name: "qfh_sso", path: "/auth/sso" });
  let email: string;
  try {
    ({ email } = await completeAuth(cfg, `${appUrl()}/auth/sso/callback`, new URL(req.url).searchParams, saved));
  } catch (e) {
    return fail((e as Error).message);
  }
  const [u] = await db.select().from(users).where(eq(users.email, email));
  if (!u) return fail(`Tài khoản ${email} chưa được Admin tạo trong QA Flow Hub.`);
  if (u.disabled) return fail("Tài khoản này đã bị khoá.");
  await startSession(u.id);
  await audit(db, { userId: u.id, action: `Đăng nhập bằng ${cfg.label}` });
  return Response.redirect(appUrl() + "/board", 303);
}

import { cookies } from "next/headers";
import { getDb } from "@/lib/db";
import { loadSso } from "@/lib/services/connections";
import { buildAuthRequest } from "@/lib/sso";
import { withFlash } from "@/lib/flash";

export const dynamic = "force-dynamic";

const appUrl = () => (process.env.APP_URL || "http://localhost:3000").replace(/\/+$/, "");

export async function GET() {
  const cfg = await loadSso(await getDb());
  if (!cfg) return Response.redirect(appUrl() + withFlash("/login", { err: "Chưa cấu hình đăng nhập SSO." }), 303);
  try {
    const { url, saved } = await buildAuthRequest(cfg, `${appUrl()}/auth/sso/callback`);
    (await cookies()).set("qfh_sso", JSON.stringify(saved), { httpOnly: true, sameSite: "lax", secure: appUrl().startsWith("https://"), path: "/auth/sso", maxAge: 600 });
    return Response.redirect(url, 303);
  } catch (e) {
    return Response.redirect(appUrl() + withFlash("/login", { err: (e as Error).message }), 303);
  }
}

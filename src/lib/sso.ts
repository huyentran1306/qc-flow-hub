import { createHash, randomBytes } from "node:crypto";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { fetchWithTimeout } from "./integrations/http";

export type SsoConfig = { issuer: string; clientId: string; clientSecret: string; label: string };
type Discovery = { issuer: string; authorization_endpoint: string; token_endpoint: string; jwks_uri: string };
export type SsoState = { state: string; nonce: string; verifier: string };

const cache = new Map<string, { d: Discovery; at: number }>();
const jwks = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

export async function discover(issuer: string): Promise<Discovery> {
  const key = issuer.replace(/\/+$/, "");
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < 3600_000) return hit.d;
  let res: Response;
  try {
    res = await fetchWithTimeout(`${key}/.well-known/openid-configuration`, {}, 10000);
  } catch (e) {
    throw new Error(`Không tải được cấu hình OpenID từ ${key} (${(e as Error).message}).`);
  }
  if (!res.ok) throw new Error(`Issuer ${key} trả về HTTP ${res.status}. Kiểm tra lại Issuer URL.`);
  const d = (await res.json()) as Discovery;
  if (!d.authorization_endpoint || !d.token_endpoint || !d.jwks_uri) throw new Error("Cấu hình OpenID thiếu endpoint bắt buộc.");
  cache.set(key, { d, at: Date.now() });
  return d;
}

const b64 = (b: Buffer) => b.toString("base64url");

export async function buildAuthRequest(cfg: SsoConfig, redirectUri: string): Promise<{ url: string; saved: SsoState }> {
  const d = await discover(cfg.issuer);
  const saved = { state: b64(randomBytes(16)), nonce: b64(randomBytes(16)), verifier: b64(randomBytes(32)) };
  const url = new URL(d.authorization_endpoint);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: cfg.clientId,
    redirect_uri: redirectUri,
    scope: "openid email profile",
    state: saved.state,
    nonce: saved.nonce,
    code_challenge: b64(createHash("sha256").update(saved.verifier).digest()),
    code_challenge_method: "S256",
    prompt: "select_account",
  }).toString();
  return { url: url.toString(), saved };
}

/** Exchanges the code, verifies the ID token, and returns the verified email. */
export async function completeAuth(cfg: SsoConfig, redirectUri: string, params: URLSearchParams, saved: SsoState | null): Promise<{ email: string; name: string }> {
  if (params.get("error")) throw new Error(`Nhà cung cấp đăng nhập báo lỗi: ${params.get("error_description") ?? params.get("error")}`);
  if (!saved || !params.get("state") || params.get("state") !== saved.state) throw new Error("Phiên đăng nhập SSO không hợp lệ hoặc đã hết hạn. Thử lại.");
  const code = params.get("code");
  if (!code) throw new Error("Thiếu mã xác thực từ nhà cung cấp đăng nhập.");
  const d = await discover(cfg.issuer);
  const res = await fetchWithTimeout(d.token_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirectUri, client_id: cfg.clientId, client_secret: cfg.clientSecret, code_verifier: saved.verifier }),
  });
  const tok = (await res.json().catch(() => ({}))) as { id_token?: string; error?: string; error_description?: string };
  if (!res.ok || !tok.id_token) throw new Error(`Đổi mã đăng nhập thất bại: ${tok.error_description ?? tok.error ?? `HTTP ${res.status}`}`);
  let set = jwks.get(d.jwks_uri);
  if (!set) {
    set = createRemoteJWKSet(new URL(d.jwks_uri));
    jwks.set(d.jwks_uri, set);
  }
  const { payload } = await jwtVerify(tok.id_token, set, { issuer: d.issuer, audience: cfg.clientId }).catch((e) => {
    throw new Error(`ID token không hợp lệ: ${(e as Error).message}`);
  });
  if (payload.nonce !== saved.nonce) throw new Error("ID token không khớp phiên đăng nhập (nonce).");
  if (payload.email_verified === false) throw new Error("Email của tài khoản này chưa được xác minh.");
  // Only the email claim is trusted: preferred_username / upn can be user-editable on some providers.
  const email = typeof payload.email === "string" ? payload.email.toLowerCase() : "";
  if (!email.includes("@")) throw new Error("Nhà cung cấp đăng nhập không trả về email. Với Microsoft Entra, bật optional claim “email” cho ID token.");
  return { email, name: String(payload.name ?? email) };
}

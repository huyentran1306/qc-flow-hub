import { eq } from "drizzle-orm";
import type { DB } from "../db";
import { connections, type ConnectionKind } from "../db/schema";
import { decryptSecret, encryptSecret, secretHint } from "../crypto";
import { audit } from "../audit";
import { JiraClient } from "../integrations/jira";
import { TestLinkClient } from "../integrations/testlink";
import { geminiClient, pingGemini, type AiClient } from "../integrations/gemini";
import { postWebhookMessage } from "../integrations/slack";
import { discover, type SsoConfig } from "../sso";

export const CONNECTION_FIELDS: Record<ConnectionKind, { config: string[]; secretLabel: string }> = {
  jira: { config: ["baseUrl", "flavor", "email"], secretLabel: "API token / PAT" },
  testlink: { config: ["url", "authorLogin"], secretLabel: "API key" },
  gemini: { config: ["model", "baseUrl"], secretLabel: "API key" },
  slack: { config: ["channel"], secretLabel: "Incoming webhook URL" },
  git: { config: ["provider"], secretLabel: "Webhook secret" },
  sso: { config: ["issuer", "clientId", "label"], secretLabel: "Client secret" },
};

export type ConnectionView = {
  kind: ConnectionKind;
  config: Record<string, string>;
  secretHint: string | null;
  status: "ok" | "error" | "unchecked";
  statusMessage: string | null;
  checkedAt: Date | null;
};

export async function listConnections(db: DB): Promise<Partial<Record<ConnectionKind, ConnectionView>>> {
  const rows = await db.select().from(connections);
  const out: Partial<Record<ConnectionKind, ConnectionView>> = {};
  for (const r of rows) {
    out[r.kind] = { kind: r.kind, config: r.config, secretHint: r.secretHint, status: r.status, statusMessage: r.statusMessage, checkedAt: r.checkedAt };
  }
  return out;
}

export async function saveConnection(db: DB, userId: string, kind: ConnectionKind, config: Record<string, string>, secret?: string): Promise<void> {
  const allowed = Object.fromEntries(CONNECTION_FIELDS[kind].config.map((k) => [k, (config[k] ?? "").trim()]));
  const values = {
    kind,
    config: allowed,
    status: "unchecked" as const,
    statusMessage: null,
    updatedAt: new Date(),
    ...(secret ? { secretEnc: encryptSecret(secret.trim()), secretHint: secretHint(secret.trim()) } : {}),
  };
  await db.insert(connections).values(values).onConflictDoUpdate({ target: connections.kind, set: values });
  await audit(db, { userId, action: secret ? "Cập nhật kết nối và token" : "Cập nhật kết nối", target: kind });
}

async function loadRaw(db: DB, kind: ConnectionKind) {
  const [row] = await db.select().from(connections).where(eq(connections.kind, kind));
  if (!row || !row.secretEnc) return null;
  return { config: row.config, secret: decryptSecret(row.secretEnc) };
}

export async function loadJira(db: DB): Promise<JiraClient | null> {
  const r = await loadRaw(db, "jira");
  if (!r || !r.config.baseUrl) return null;
  return new JiraClient({ baseUrl: r.config.baseUrl, flavor: r.config.flavor === "dc" ? "dc" : "cloud", email: r.config.email, token: r.secret });
}

export async function loadTestLink(db: DB): Promise<TestLinkClient | null> {
  const r = await loadRaw(db, "testlink");
  if (!r || !r.config.url) return null;
  return new TestLinkClient({ url: r.config.url, devKey: r.secret, authorLogin: r.config.authorLogin ?? "" });
}

export async function loadAi(db: DB): Promise<AiClient | null> {
  const r = await loadRaw(db, "gemini");
  if (!r || !r.config.model) return null;
  return geminiClient(r.secret, r.config.model, r.config.baseUrl || undefined);
}

/** Runs a live check against the system and stores the result. */
export async function checkConnection(db: DB, userId: string, kind: ConnectionKind): Promise<{ ok: boolean; message: string }> {
  let ok = false;
  let message = "";
  try {
    const r = await loadRaw(db, kind);
    if (!r) throw new Error("Chưa nhập đủ thông tin và token.");
    if (kind === "jira") {
      const name = await (await loadJira(db))!.myself();
      message = `Đã kết nối với tài khoản ${name}`;
    } else if (kind === "testlink") {
      await (await loadTestLink(db))!.checkDevKey();
      message = "API key hợp lệ";
    } else if (kind === "gemini") {
      await pingGemini(r.secret, r.config.model, r.config.baseUrl || undefined);
      message = `Model ${r.config.model} phản hồi bình thường`;
    } else if (kind === "slack") {
      await postWebhookMessage(r.secret, "QA Flow Hub: kiểm tra kết nối thành công.");
      message = "Đã gửi tin nhắn thử vào kênh";
    } else if (kind === "sso") {
      const d = await discover(r.config.issuer);
      message = `Đọc được cấu hình OpenID của ${d.issuer}. Hãy thử đăng nhập bằng SSO trong cửa sổ ẩn danh.`;
    } else {
      message = "Đã lưu secret. Trạng thái thật sẽ biết khi Git gửi sự kiện push đầu tiên.";
    }
    ok = true;
  } catch (e) {
    message = (e as Error).message;
  }
  await db
    .update(connections)
    .set({ status: ok ? "ok" : "error", statusMessage: message, checkedAt: new Date() })
    .where(eq(connections.kind, kind));
  await audit(db, { userId, action: ok ? "Kiểm tra kết nối: thành công" : "Kiểm tra kết nối: lỗi", target: kind, detail: { message } });
  return { ok, message };
}

export async function loadSlackUrl(db: DB): Promise<string | null> {
  return (await loadRaw(db, "slack"))?.secret ?? null;
}

export async function loadGitSecret(db: DB): Promise<string | null> {
  return (await loadRaw(db, "git"))?.secret ?? null;
}

export async function loadSso(db: DB): Promise<SsoConfig | null> {
  const r = await loadRaw(db, "sso");
  if (!r || !r.config.issuer || !r.config.clientId) return null;
  return { issuer: r.config.issuer, clientId: r.config.clientId, clientSecret: r.secret, label: r.config.label || "SSO" };
}

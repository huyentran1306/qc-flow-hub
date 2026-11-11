import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import { AddressInfo } from "node:net";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { eq } from "drizzle-orm";
import { openDb, type DB } from "@/lib/db";
import { questions, stories } from "@/lib/db/schema";
import { createFirstAdmin } from "@/lib/services/users";
import { seedDemo } from "@/lib/services/demo";
import { publishQuestion, questionCode, syncQnaReplies, addQuestion } from "@/lib/services/questions";
import { buildAuthRequest, completeAuth } from "@/lib/sso";
import type { JiraClient, JiraComment } from "@/lib/integrations/jira";

// ---------- mock OpenID provider ----------
let server: http.Server;
let issuer: string;
let lastCode: { nonce: string; challenge: string; email: string; verified?: boolean } | null = null;
let kp: Awaited<ReturnType<typeof generateKeyPair>>;

beforeAll(async () => {
  kp = await generateKeyPair("RS256");
  const jwk = { ...(await exportJWK(kp.publicKey)), kid: "k1", alg: "RS256", use: "sig" };
  server = http.createServer(async (req, res) => {
    const url = new URL(req.url!, issuer);
    if (url.pathname === "/.well-known/openid-configuration") {
      res.setHeader("content-type", "application/json");
      return res.end(JSON.stringify({ issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/jwks` }));
    }
    if (url.pathname === "/jwks") return res.end(JSON.stringify({ keys: [jwk] }));
    if (url.pathname === "/token") {
      let body = "";
      for await (const c of req) body += c;
      const p = new URLSearchParams(body);
      const { createHash } = await import("node:crypto");
      const ok = lastCode && p.get("code") === "CODE1" && createHash("sha256").update(p.get("code_verifier")!).digest("base64url") === lastCode.challenge && p.get("client_secret") === "sec";
      res.setHeader("content-type", "application/json");
      if (!ok) {
        res.statusCode = 400;
        return res.end(JSON.stringify({ error: "invalid_grant", error_description: "bad code or verifier" }));
      }
      const id_token = await new SignJWT({ email: lastCode!.email, email_verified: lastCode!.verified ?? true, nonce: lastCode!.nonce, name: "Ngọc" })
        .setProtectedHeader({ alg: "RS256", kid: "k1" })
        .setIssuer(issuer)
        .setAudience("client-1")
        .setSubject("u1")
        .setIssuedAt()
        .setExpirationTime("5m")
        .sign(kp.privateKey);
      return res.end(JSON.stringify({ id_token, access_token: "x", token_type: "Bearer" }));
    }
    res.statusCode = 404;
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());

describe("SSO (OpenID Connect)", () => {
  const cfg = () => ({ issuer, clientId: "client-1", clientSecret: "sec", label: "Google" });
  const redirect = "http://localhost:3000/auth/sso/callback";

  it("builds a PKCE request and verifies the ID token", async () => {
    const { url, saved } = await buildAuthRequest(cfg(), redirect);
    const u = new URL(url);
    expect(u.origin + u.pathname).toBe(`${issuer}/authorize`);
    expect(u.searchParams.get("code_challenge_method")).toBe("S256");
    expect(u.searchParams.get("redirect_uri")).toBe(redirect);
    lastCode = { nonce: saved.nonce, challenge: u.searchParams.get("code_challenge")!, email: "Ngoc@Noibo.Local" };
    const r = await completeAuth(cfg(), redirect, new URLSearchParams({ code: "CODE1", state: saved.state }), saved);
    expect(r.email).toBe("ngoc@noibo.local");
  });

  it("rejects wrong state, wrong nonce, unverified email and provider errors", async () => {
    const { url, saved } = await buildAuthRequest(cfg(), redirect);
    const challenge = new URL(url).searchParams.get("code_challenge")!;
    await expect(completeAuth(cfg(), redirect, new URLSearchParams({ code: "CODE1", state: "other" }), saved)).rejects.toThrow(/không hợp lệ/);
    await expect(completeAuth(cfg(), redirect, new URLSearchParams({ code: "CODE1", state: saved.state }), null)).rejects.toThrow(/không hợp lệ/);
    lastCode = { nonce: "someone-else", challenge, email: "a@b.c" };
    await expect(completeAuth(cfg(), redirect, new URLSearchParams({ code: "CODE1", state: saved.state }), saved)).rejects.toThrow(/nonce/);
    lastCode = { nonce: saved.nonce, challenge, email: "a@b.c", verified: false };
    await expect(completeAuth(cfg(), redirect, new URLSearchParams({ code: "CODE1", state: saved.state }), saved)).rejects.toThrow(/chưa được xác minh/);
    await expect(completeAuth(cfg(), redirect, new URLSearchParams({ error: "access_denied" }), saved)).rejects.toThrow(/access_denied/);
    lastCode = { nonce: saved.nonce, challenge: "tampered", email: "a@b.c" };
    await expect(completeAuth(cfg(), redirect, new URLSearchParams({ code: "CODE1", state: saved.state }), saved)).rejects.toThrow(/bad code or verifier/);
  });
});

describe("Q&A replies from Jira", () => {
  let db: DB;
  it("matches replies by code, else to the latest question posted before them", async () => {
    db = await openDb({ memory: true });
    const u = await createFirstAdmin(db, { email: "a@b.c", name: "A", password: "password123" });
    await seedDemo(db, u);
    const [s] = await db.select().from(stories).where(eq(stories.jiraKey, "DEMO-110930"));
    // A non-demo key so the question is actually "sent".
    await db.update(stories).set({ jiraKey: "OP-5" }).where(eq(stories.id, s.id));
    await addQuestion(db, u, s.id, "Bộ lọc lưu theo user hay theo dashboard?", "PO");
    await addQuestion(db, u, s.id, "Khoảng thời gian tuỳ chọn tối đa bao lâu?", "BA");
    const qs = await db.select().from(questions).where(eq(questions.storyId, s.id)).orderBy(questions.createdAt);
    let next = 100;
    const comments: JiraComment[] = [];
    const jira = {
      addComment: async (_k: string, body: string) => {
        const id = String(next++);
        comments.push({ id, body, created: "", authorId: "bot", authorName: "qa-bot" });
        return id;
      },
      myselfId: async () => "bot",
      listComments: async () => comments,
    } as unknown as JiraClient;
    await publishQuestion(db, u, qs[0].id, "PO", jira);
    await publishQuestion(db, u, qs[1].id, "BA", jira);
    expect(comments[0].body).toContain(questionCode(qs[0].id));
    // BA answers Q2 without the code (goes to the latest question = Q2); PO answers Q1 quoting the code.
    comments.push({ id: "105", body: "Tối đa 90 ngày.", created: "", authorId: "ba", authorName: "Lan" });
    comments.push({ id: "106", body: `${questionCode(qs[0].id)}: theo từng user`, created: "", authorId: "po", authorName: "Minh" });
    comments.push({ id: "107", body: "[Test report] ...", created: "", authorId: "someone", authorName: "x" });
    expect(await syncQnaReplies(db, jira, s.id)).toBe(2);
    const after = await db.select().from(questions).where(eq(questions.storyId, s.id)).orderBy(questions.createdAt);
    expect(after[0]).toMatchObject({ jiraReply: "theo từng user", jiraReplyAuthor: "Minh" });
    expect(after[1]).toMatchObject({ jiraReply: "Tối đa 90 ngày.", jiraReplyAuthor: "Lan" });
    expect(await syncQnaReplies(db, jira, s.id)).toBe(0); // idempotent
  });
});

import { createHmac, timingSafeEqual } from "node:crypto";
import type { FixCommit } from "../db/schema";

/** Verifies a push webhook from GitLab (X-Gitlab-Token) or GitHub (X-Hub-Signature-256). */
export function verifyGitWebhook(headers: Headers, rawBody: string, secret: string): "gitlab" | "github" | null {
  const gl = headers.get("x-gitlab-token");
  if (gl != null) {
    const a = Buffer.from(gl);
    const b = Buffer.from(secret);
    return a.length === b.length && timingSafeEqual(a, b) ? "gitlab" : null;
  }
  const sig = headers.get("x-hub-signature-256");
  if (sig) {
    const expected = "sha256=" + createHmac("sha256", secret).update(rawBody).digest("hex");
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b) ? "github" : null;
  }
  return null;
}

type PushCommit = { id: string; message: string; url?: string; timestamp?: string; author?: { name?: string } };

export function commitsFromPush(body: unknown): FixCommit[] {
  const commits = ((body as { commits?: PushCommit[] })?.commits ?? []) as PushCommit[];
  return commits.map((c) => ({ sha: c.id, message: c.message?.split("\n")[0] ?? "", url: c.url, author: c.author?.name, at: c.timestamp }));
}

/** Issue keys like OP-111111 mentioned in a commit message. */
export function issueKeysIn(message: string): string[] {
  return [...new Set(message.toUpperCase().match(/\b[A-Z][A-Z0-9_]+-\d+\b/g) ?? [])];
}

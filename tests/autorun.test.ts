import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { and, eq } from "drizzle-orm";
import { openDb, type DB } from "@/lib/db";
import { apiCalls, autoRuns, builds, evidence, executions, projects, stories, testCases } from "@/lib/db/schema";
import { createFirstAdmin } from "@/lib/services/users";
import { seedDemo } from "@/lib/services/demo";
import { encryptSecret } from "@/lib/crypto";
import { demoHtml, handleDemoApi } from "@/lib/demoApp";
import { startAutoRun, httpCall } from "@/lib/autorun/runner";
import type { AiClient } from "@/lib/integrations/gemini";

process.env.UPLOAD_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "qfh-auto-"));

let server: http.Server;
let origin = "";
const seenBodies: string[] = [];

beforeAll(async () => {
  server = http.createServer(async (req, res) => {
    const url = new URL(req.url!, "http://x");
    let body = "";
    for await (const c of req) body += c;
    if (body) seenBodies.push(body);
    if (url.pathname === "/demo-app") {
      res.setHeader("content-type", "text/html; charset=utf-8");
      return res.end(demoHtml());
    }
    if (url.pathname.startsWith("/demo-app/api/")) {
      const r = handleDemoApi(req.method!, url.pathname.replace("/demo-app/api/", "").split("/"), url.searchParams);
      res.statusCode = r.status;
      if (r.status === 204) return res.end();
      res.setHeader("content-type", "application/json");
      return res.end(JSON.stringify(r.body));
    }
    res.statusCode = 404;
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());

/** Scripted stand-in for Gemini: reads refs from the prompt and plays a fixed scenario per test case. */
function scriptedAi(prompts: string[]): AiClient {
  const refOf = (prompt: string, match: (e: Record<string, string>) => boolean) => {
    const block = prompt.split("Phần tử tương tác (ref):\n")[1]?.split("\n\nNội dung hiển thị:")[0] ?? "";
    return block.split("\n").map((l) => JSON.parse(l)).find(match)?.ref;
  };
  return {
    model: "scripted",
    async generateJson<T>({ prompt }: { prompt: string }) {
      prompts.push(prompt);
      const done = (prompt.split("Đã làm:\n")[1]?.split("\n\n")[0] ?? "").split("\n").filter((l) => /^\d+\. /.test(l) && !l.startsWith("0.")).length;
      if (prompt.includes("Test case TC-03")) {
        if (done === 0) return { action: "fill", ref: refOf(prompt, (e) => e.placeholder?.startsWith("Tìm")), value: "hanoi", step: 1, note: "gõ từ khoá" } as T;
        if (done === 1) return { action: "click", ref: refOf(prompt, (e) => e.text === "Tìm"), step: 1, note: "bấm tìm" } as T;
        const found = prompt.split("Nội dung hiển thị:")[1].includes("Hanoi Traffic");
        return { action: "finish", verdict: found ? "passed" : "failed", note: "so kết quả", observation: found ? "Có Hanoi Traffic" : "Tìm “hanoi” không ra “Hanoi Traffic”: tìm kiếm phân biệt hoa thường." } as T;
      }
      if (prompt.includes("Test case TC-14")) {
        if (done === 0) return { action: "http", method: "POST", url: "/demo-app/api/reset", body: '{"user":"{{USERNAME}}","pass":"{{PASSWORD}}"}', note: "chuẩn bị dữ liệu" } as T;
        if (done === 1) return { action: "http", method: "DELETE", url: "/demo-app/api/mapdecks/khong-ton-tai", note: "xoá id không tồn tại" } as T;
        return { action: "finish", verdict: "failed", note: "so mã trạng thái", observation: "API trả 500 Internal Server Error thay vì 404." } as T;
      }
      return { action: "finish", verdict: "blocked", note: "không có kịch bản", observation: "Không có kịch bản." } as T;
    },
  };
}

describe("automatic runs", () => {
  let db: DB;
  it("runs a UI case in Chrome and an API case directly, recording API results and evidence", async () => {
    db = await openDb({ memory: true });
    const u = await createFirstAdmin(db, { email: "a@b.c", name: "A", password: "password123" });
    await seedDemo(db, u);
    const [p] = await db.select().from(projects).where(eq(projects.key, "DEMO"));
    expect(p.envUrls.dev).toBe("/demo-app");
    await db.update(projects).set({ testAccountsEnc: encryptSecret(JSON.stringify({ dev: { username: "qa.bot", password: "S3cr3t!pw" } })) }).where(eq(projects.id, p.id));
    const [s] = await db.select().from(stories).where(eq(stories.jiraKey, "DEMO-110859"));
    const [b] = await db.select().from(builds).where(eq(builds.storyId, s.id));
    const rows = await db.select({ e: executions, tc: testCases }).from(executions).innerJoin(testCases, eq(testCases.id, executions.testCaseId)).where(eq(executions.buildId, b.id));
    const exec = (seq: number) => rows.find((r) => r.tc.seq === seq)!.e.id;
    expect(rows.find((r) => r.tc.seq === 14)!.tc.kind).toBe("api");

    const prompts: string[] = [];
    const runId = await startAutoRun(db, scriptedAi(prompts), { buildId: b.id, userId: u, headed: false, rerun: true, origin, onlyIds: [exec(3), exec(14)] });
    await expect(startAutoRun(db, scriptedAi([]), { buildId: b.id, userId: u, headed: false, rerun: true, origin })).rejects.toThrow(/lượt chạy tự động khác/);

    let run;
    for (let i = 0; i < 120; i++) {
      [run] = await db.select().from(autoRuns).where(eq(autoRuns.id, runId));
      if (run.status !== "running" && run.status !== "queued") break;
      await new Promise((r) => setTimeout(r, 500));
    }
    expect(run!.error).toBeNull();
    expect(run).toMatchObject({ status: "done", total: 2, done: 2, failed: 2 });

    const [e3] = await db.select().from(executions).where(eq(executions.id, exec(3)));
    expect(e3).toMatchObject({ status: "failed", byAgent: true, reviewed: false, agentSource: "auto" });
    expect(e3.notes).toContain("[Tự động]");
    const uiCalls = await db.select().from(apiCalls).where(eq(apiCalls.executionId, exec(3)));
    expect(uiCalls.some((c) => c.source === "ui" && c.method === "GET" && c.url.includes("/demo-app/api/mapdecks?q=hanoi") && c.status === 200)).toBe(true);
    const shots = await db.select().from(evidence).where(and(eq(evidence.ownerId, exec(3)), eq(evidence.ownerType, "execution")));
    expect(shots[0]).toMatchObject({ fileName: "tu-dong-TC-03.png", mime: "image/png" });

    const apiRes = await db.select().from(apiCalls).where(eq(apiCalls.executionId, exec(14))).orderBy(apiCalls.seq);
    expect(apiRes.map((c) => [c.source, c.method, c.status])).toEqual([
      ["api", "POST", 200],
      ["api", "DELETE", 500],
    ]);
    // The real password reached the app, but it is masked in storage and never shown to the AI.
    expect(seenBodies.some((x) => x.includes("S3cr3t!pw"))).toBe(true);
    expect(apiRes[0].requestBody).toBe('{"user":"qa.bot","pass":"••••"}');
    expect(prompts.join("\n")).not.toContain("S3cr3t!pw");
    expect(prompts.some((x) => x.includes("{{USERNAME}} / {{PASSWORD}}"))).toBe(true);
  }, 90_000);

  it("records network errors as API failures", async () => {
    const c = await httpCall("GET", "http://127.0.0.1:1/khong-co", undefined);
    expect(c.status).toBeNull();
    expect(c.error).toBeTruthy();
  });
});

import { and, eq, inArray } from "drizzle-orm";
import type { Browser, Page, Request as PwRequest } from "playwright-core";
import type { DB } from "../db";
import { apiCalls, autoRuns, builds, executions, projects, stories, testCases, type ExecStatus } from "../db/schema";
import type { AiClient } from "../integrations/gemini";
import { setExecution } from "../services/execution";
import { addEvidenceBuffer } from "../services/bugs";
import { readAccounts, type TestAccount } from "../services/testAccounts";
import { audit } from "../audit";
import { tcCode } from "../format";
import { launchBrowser } from "./browser";
import { collectSnapshot } from "./snapshot";
import { decide, type Decision, type Verdict } from "./agent";

const MAX_UI_ACTIONS = 20;
const MAX_API_ACTIONS = 8;
const CASE_TIMEOUT_MS = 4 * 60_000;
const BODY_LIMIT = 2000;

/** Live runs in this process; a DB row marked running but absent here was interrupted. */
const g = globalThis as unknown as { __qfhRuns?: Map<string, true> };
const live = () => (g.__qfhRuns ??= new Map());

export type ApiCall = { source: "ui" | "api"; method: string; url: string; status: number | null; durationMs: number | null; requestBody: string | null; responseBody: string | null; error: string | null };

const cut = (s: string | null | undefined, n = BODY_LIMIT) => (s == null ? null : s.length > n ? s.slice(0, n) + "…" : s);

function substitute(v: string, acc?: TestAccount) {
  return v.replaceAll("{{USERNAME}}", acc?.username ?? "").replaceAll("{{PASSWORD}}", acc?.password ?? "");
}
function mask(v: string | null, acc?: TestAccount) {
  if (v == null || !acc?.password) return v;
  return v.split(acc.password).join("••••");
}

export function resolveUrl(url: string, base: string) {
  try {
    return new URL(url, base.endsWith("/") ? base : base + "/").toString();
  } catch {
    return url;
  }
}

/** Calls an API endpoint directly and records the exchange. */
export async function httpCall(method: string, url: string, body: string | undefined, acc?: TestAccount): Promise<ApiCall> {
  const started = Date.now();
  const reqBody = body ? substitute(body, acc) : undefined;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 15000);
    const res = await fetch(url, {
      method,
      headers: reqBody ? { "Content-Type": "application/json", Accept: "application/json" } : { Accept: "application/json" },
      body: reqBody,
      signal: ctrl.signal,
    }).finally(() => clearTimeout(t));
    const text = await res.text().catch(() => "");
    return { source: "api", method, url, status: res.status, durationMs: Date.now() - started, requestBody: mask(cut(reqBody ?? null), acc), responseBody: cut(text), error: null };
  } catch (e) {
    return { source: "api", method, url, status: null, durationMs: Date.now() - started, requestBody: mask(cut(reqBody ?? null), acc), responseBody: null, error: (e as Error).message };
  }
}

const apiLine = (c: ApiCall) => `${c.method} ${c.url} → ${c.status ?? "lỗi mạng"}${c.status && c.status >= 400 && c.responseBody ? ` ${c.responseBody.slice(0, 200)}` : ""}`;

type CaseResult = { verdict: Verdict; observation: string; calls: ApiCall[]; screenshot: Buffer | null; actions: number };
type CaseInput = { ai: AiClient; tc: typeof testCases.$inferSelect; baseUrl: string; acc?: TestAccount; deadline: number };

async function settle(page: Page) {
  await page.waitForLoadState("networkidle", { timeout: 3000 }).catch(() => undefined);
  await page.waitForTimeout(250);
}

/** UI test: the AI drives the browser one action at a time; API calls made by the page are recorded. */
export async function runUiCase(browser: Browser, i: CaseInput): Promise<CaseResult> {
  const context = await browser.newContext({ viewport: { width: 1366, height: 820 }, ignoreHTTPSErrors: true });
  const page = await context.newPage();
  const calls: ApiCall[] = [];
  const started = new Map<PwRequest, number>();
  const history: string[] = [];
  page.on("request", (r) => {
    if (r.resourceType() === "xhr" || r.resourceType() === "fetch") started.set(r, Date.now());
  });
  const finished = async (r: PwRequest, failed: boolean) => {
    if (!started.has(r)) return;
    const t0 = started.get(r)!;
    started.delete(r);
    const res = failed ? null : await r.response().catch(() => null);
    const body = res ? await res.text().catch(() => null) : null;
    calls.push({ source: "ui", method: r.method(), url: r.url(), status: res?.status() ?? null, durationMs: Date.now() - t0, requestBody: mask(cut(r.postData()), i.acc), responseBody: cut(body), error: failed ? (r.failure()?.errorText ?? "request failed") : null });
  };
  page.on("requestfinished", (r) => void finished(r, false));
  page.on("requestfailed", (r) => void finished(r, true));
  page.on("dialog", async (d) => {
    history.push(`(hộp thoại ${d.type()}: "${d.message()}" → đã bấm OK)`);
    await d.accept().catch(() => undefined);
  });
  let result: CaseResult | null = null;
  try {
    await page.goto(i.baseUrl, { waitUntil: "domcontentloaded", timeout: 20000 });
    await settle(page);
    history.push(`0. mở ${i.baseUrl}`);
    for (let n = 1; n <= MAX_UI_ACTIONS; n++) {
      if (Date.now() > i.deadline) {
        result = { verdict: "blocked", observation: "Quá thời gian cho phép cho một test case.", calls, screenshot: null, actions: n };
        break;
      }
      const snap = await page.evaluate(collectSnapshot);
      const d: Decision = await decide(i.ai, {
        kind: "ui",
        tc: { code: tcCode(i.tc.seq), title: i.tc.title, preconditions: i.tc.preconditions, steps: i.tc.steps },
        baseUrl: i.baseUrl,
        hasAccount: !!i.acc,
        history,
        page: snap,
        recentApi: calls.map(apiLine),
      });
      if (d.action === "finish") {
        result = { verdict: d.verdict ?? "blocked", observation: d.observation || d.note, calls, screenshot: null, actions: n };
        break;
      }
      const loc = d.ref ? page.locator(`[data-qfh-ref="${d.ref}"]`).first() : null;
      let outcome = "ok";
      try {
        if (d.action === "goto") await page.goto(resolveUrl(d.url ?? "", i.baseUrl), { waitUntil: "domcontentloaded", timeout: 20000 });
        else if (d.action === "click") await loc!.click({ timeout: 8000 });
        else if (d.action === "fill") await loc!.fill(substitute(d.value ?? "", i.acc), { timeout: 8000 });
        else if (d.action === "select") await loc!.selectOption(d.value ?? "", { timeout: 8000 });
        else if (d.action === "press") await page.keyboard.press(d.value || "Enter");
        else if (d.action === "http") {
          const c = await httpCall(d.method ?? "GET", resolveUrl(d.url ?? "", i.baseUrl), d.body, i.acc);
          calls.push(c);
          outcome = `${c.status ?? c.error}`;
        }
        await settle(page);
      } catch (e) {
        outcome = `lỗi: ${(e as Error).message.split("\n")[0].slice(0, 160)}`;
      }
      const shown = d.action === "fill" ? mask(d.value ?? "", i.acc) : (d.value ?? d.url ?? "");
      history.push(`${n}. ${d.action}${d.ref ? ` ${d.ref}` : ""}${shown ? ` "${shown}"` : ""} (bước ${d.step ?? "?"}: ${d.note}) → ${outcome}`);
    }
    if (!result) result = { verdict: "blocked", observation: `Dừng sau ${MAX_UI_ACTIONS} thao tác mà chưa kết luận được.`, calls, screenshot: null, actions: MAX_UI_ACTIONS };
    result.screenshot = await page.screenshot({ fullPage: false }).catch(() => null);
    await page.waitForTimeout(200); // let in-flight API responses land
    return result;
  } catch (e) {
    return { verdict: "blocked", observation: `Không mở được môi trường: ${(e as Error).message.split("\n")[0]}`, calls, screenshot: await page.screenshot().catch(() => null), actions: 0 };
  } finally {
    await context.close().catch(() => undefined);
  }
}

/** API test: the AI issues HTTP calls directly; every exchange becomes the case's API result. */
export async function runApiCase(i: CaseInput): Promise<CaseResult> {
  const calls: ApiCall[] = [];
  const history: string[] = [];
  for (let n = 1; n <= MAX_API_ACTIONS; n++) {
    if (Date.now() > i.deadline) return { verdict: "blocked", observation: "Quá thời gian cho phép.", calls, screenshot: null, actions: n };
    const d = await decide(i.ai, {
      kind: "api",
      tc: { code: tcCode(i.tc.seq), title: i.tc.title, preconditions: i.tc.preconditions, steps: i.tc.steps },
      baseUrl: i.baseUrl,
      hasAccount: !!i.acc,
      history,
      recentApi: calls.map((c) => `${apiLine(c)}\n   body: ${(c.responseBody ?? "").slice(0, 1200)}`),
    });
    if (d.action === "finish") return { verdict: d.verdict ?? "blocked", observation: d.observation || d.note, calls, screenshot: null, actions: n };
    if (d.action !== "http") {
      history.push(`${n}. (bỏ qua "${d.action}": test API chỉ dùng http)`);
      continue;
    }
    const c = await httpCall(d.method ?? "GET", resolveUrl(d.url ?? "", i.baseUrl), d.body, i.acc);
    calls.push(c);
    history.push(`${n}. ${c.method} ${c.url} → ${c.status ?? c.error} (${d.note})`);
  }
  return { verdict: "blocked", observation: `Dừng sau ${MAX_API_ACTIONS} lời gọi mà chưa kết luận được.`, calls, screenshot: null, actions: MAX_API_ACTIONS };
}

export async function saveApiCalls(db: DB, executionId: string, calls: ApiCall[]) {
  await db.delete(apiCalls).where(eq(apiCalls.executionId, executionId));
  if (calls.length) await db.insert(apiCalls).values(calls.map((c, seq) => ({ executionId, seq, ...c })));
}

export async function activeRunForBuild(db: DB, buildId: string) {
  const [r] = await db.select().from(autoRuns).where(and(eq(autoRuns.buildId, buildId), inArray(autoRuns.status, ["queued", "running"])));
  return r ?? null;
}

/** Marks runs left "running" by a previous process (restart, crash) as interrupted. */
export async function sweepInterrupted(db: DB) {
  const rows = await db.select().from(autoRuns).where(inArray(autoRuns.status, ["queued", "running"]));
  for (const r of rows) if (!live().has(r.id)) await db.update(autoRuns).set({ status: "failed", error: "Bị gián đoạn (tool đã khởi động lại)", finishedAt: new Date() }).where(eq(autoRuns.id, r.id));
}

export type StartOptions = { buildId: string; userId: string; headed: boolean; rerun: boolean; origin: string; onlyIds?: string[] };

export async function startAutoRun(db: DB, ai: AiClient, o: StartOptions): Promise<string> {
  await sweepInterrupted(db);
  if (live().size) throw new Error("Đang có một lượt chạy tự động khác. Chờ xong hoặc huỷ lượt đó trước.");
  const [b] = await db.select().from(builds).where(eq(builds.id, o.buildId));
  const [s] = await db.select().from(stories).where(eq(stories.id, b.storyId));
  const [p] = await db.select().from(projects).where(eq(projects.id, s.projectId));
  const envUrl = p.envUrls[b.env];
  if (!envUrl) throw new Error(`Dự án ${p.key} chưa có URL môi trường ${b.env.toUpperCase()}. Vào Quản trị → Dự án để nhập.`);
  const rows = await db.select({ e: executions, tc: testCases }).from(executions).innerJoin(testCases, eq(testCases.id, executions.testCaseId)).where(eq(executions.buildId, o.buildId));
  const targets = rows
    .filter((r) => (o.onlyIds ? o.onlyIds.includes(r.e.id) : o.rerun ? r.e.status !== "passed" : r.e.status === "not_run"))
    .sort((a, z) => a.tc.seq - z.tc.seq);
  if (!targets.length) throw new Error(o.rerun ? "Mọi test case trong build đã Passed." : "Không còn test case nào chưa chạy. Chọn “Chạy lại cả Failed/Blocked” nếu muốn.");
  const [run] = await db.insert(autoRuns).values({ buildId: o.buildId, status: "queued", total: targets.length, startedBy: o.userId, options: { headed: o.headed, rerun: o.rerun } }).returning();
  live().set(run.id, true);
  const baseUrl = envUrl.startsWith("/") ? o.origin.replace(/\/+$/, "") + envUrl : envUrl;
  const acc = readAccounts(p.testAccountsEnc)[b.env];
  await audit(db, { userId: o.userId, action: `Bắt đầu chạy tự động ${targets.length} TC`, target: `${s.jiraKey} ${b.name}` });
  void processRun(db, ai, run.id, targets, { baseUrl, acc, userId: o.userId, headed: o.headed, label: `${s.jiraKey} ${b.name}` })
    .catch(async (e) => {
      await db.update(autoRuns).set({ status: "failed", error: (e as Error).message, finishedAt: new Date() }).where(eq(autoRuns.id, run.id));
    })
    .finally(() => live().delete(run.id));
  return run.id;
}

async function processRun(
  db: DB,
  ai: AiClient,
  runId: string,
  targets: { e: typeof executions.$inferSelect; tc: typeof testCases.$inferSelect }[],
  ctx: { baseUrl: string; acc?: TestAccount; userId: string; headed: boolean; label: string },
) {
  const log: string[] = [];
  const counts = { done: 0, passed: 0, failed: 0, blocked: 0 };
  const push = async (line: string, extra: Partial<typeof autoRuns.$inferInsert> = {}) => {
    log.push(`${new Date().toLocaleTimeString("vi-VN", { hour12: false, timeZone: "Asia/Ho_Chi_Minh" })} ${line}`);
    await db.update(autoRuns).set({ log: log.slice(-200), ...counts, ...extra }).where(eq(autoRuns.id, runId));
  };
  await push(`Bắt đầu trên ${ctx.baseUrl}${ctx.acc ? ` với tài khoản ${ctx.acc.username}` : ""}`, { status: "running" });
  let browser: Browser | null = null;
  try {
    for (const { e, tc } of targets) {
      const [now] = await db.select({ status: autoRuns.status }).from(autoRuns).where(eq(autoRuns.id, runId));
      if (now?.status === "cancelled") {
        await push("Đã huỷ theo yêu cầu.");
        return;
      }
      const code = tcCode(tc.seq);
      await push(`▶ ${code} ${tc.title}${tc.kind === "api" ? " (API)" : ""}`, { current: `${code} ${tc.title}` });
      const input = { ai, tc, baseUrl: ctx.baseUrl, acc: ctx.acc, deadline: Date.now() + CASE_TIMEOUT_MS };
      let r: CaseResult;
      try {
        r = tc.kind === "api" ? await runApiCase(input) : await runUiCase((browser ??= await launchBrowser(ctx.headed)), input);
      } catch (err) {
        if (/trình duyệt/.test((err as Error).message)) throw err;
        r = { verdict: "blocked", observation: `Lỗi khi chạy: ${(err as Error).message.split("\n")[0]}`, calls: [], screenshot: null, actions: 0 };
      }
      await setExecution(db, ctx.userId, e.id, { status: r.verdict as ExecStatus, notes: `[Tự động] ${r.observation}` }, { byAgent: true });
      await db.update(executions).set({ agentSource: "auto" }).where(eq(executions.id, e.id));
      await saveApiCalls(db, e.id, r.calls);
      if (r.screenshot) await addEvidenceBuffer(db, ctx.userId, "execution", e.id, `tu-dong-${code}.png`, "image/png", r.screenshot);
      counts.done++;
      counts[r.verdict]++;
      const apiErr = r.calls.filter((c) => c.status == null || c.status >= 400).length;
      await push(`${r.verdict === "passed" ? "✓" : r.verdict === "failed" ? "✗" : "■"} ${code} ${r.verdict.toUpperCase()} · ${r.observation}${r.calls.length ? ` · ${r.calls.length} API${apiErr ? `, ${apiErr} lỗi` : ""}` : ""}`);
    }
    await push(`Xong: ${counts.passed} passed, ${counts.failed} failed, ${counts.blocked} blocked. Kết quả chờ QC duyệt.`, { status: "done", current: null, finishedAt: new Date() });
    await audit(db, { userId: ctx.userId, action: `Chạy tự động xong: ${counts.passed}/${counts.done} passed`, target: ctx.label });
  } finally {
    await browser?.close().catch(() => undefined);
  }
}

export async function cancelAutoRun(db: DB, runId: string, userId: string) {
  const [r] = await db.update(autoRuns).set({ status: "cancelled", finishedAt: new Date() }).where(and(eq(autoRuns.id, runId), inArray(autoRuns.status, ["queued", "running"]))).returning();
  if (r) await audit(db, { userId, action: "Huỷ lượt chạy tự động" });
  return !!r;
}

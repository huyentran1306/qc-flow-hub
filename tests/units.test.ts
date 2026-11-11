import { describe, expect, it, vi, afterEach } from "vitest";
import { encryptSecret, decryptSecret, secretHint } from "@/lib/crypto";
import { can } from "@/lib/rbac";
import { encodeCall, decodeResponse, RpcFault } from "@/lib/integrations/xmlrpc";
import { TestLinkClient } from "@/lib/integrations/testlink";
import { JiraClient, adfToText } from "@/lib/integrations/jira";
import { toTestlinkXml } from "@/lib/testlinkXml";
import { parseSteps, stepsToText } from "@/lib/services/testcases";
import { withFlash } from "@/lib/flash";

afterEach(() => vi.unstubAllGlobals());

describe("crypto", () => {
  it("round-trips and hides plaintext", () => {
    const enc = encryptSecret("ATATT3xFfGF0-secret-a9F2");
    expect(enc).not.toContain("secret");
    expect(decryptSecret(enc)).toBe("ATATT3xFfGF0-secret-a9F2");
    expect(secretHint("ATATT3xFfGF0-secret-a9F2")).toBe("a9F2");
  });
  it("rejects tampered ciphertext", () => {
    const parts = encryptSecret("abc").split(".");
    parts[3] = Buffer.from("xyz").toString("base64");
    expect(() => decryptSecret(parts.join("."))).toThrow();
  });
});

describe("rbac", () => {
  it("follows the role matrix", () => {
    expect(can({ isAdmin: false, role: "qc" }, "ai.run")).toBe(true);
    expect(can({ isAdmin: false, role: "dev" }, "ai.run")).toBe(false);
    expect(can({ isAdmin: false, role: "po" }, "qna.answer")).toBe(true);
    expect(can({ isAdmin: false, role: "po" }, "tc.edit")).toBe(false);
    expect(can({ isAdmin: false, role: "lead" }, "admin.connections")).toBe(false);
    expect(can({ isAdmin: true, role: null }, "admin.connections")).toBe(true);
    expect(can({ isAdmin: true, role: null }, "story.view")).toBe(true);
    expect(can({ isAdmin: true, role: null }, "tc.approve")).toBe(false);
    expect(can({ isAdmin: false, role: null }, "story.view")).toBe(false);
  });
});

describe("xml-rpc", () => {
  it("encodes nested params and escapes text", () => {
    const xml = encodeCall("tl.createTestCase", [{ devKey: "k", n: 3, ok: true, steps: [{ actions: "a < b & c" }] }]);
    expect(xml).toContain("<methodName>tl.createTestCase</methodName>");
    expect(xml).toContain("<member><name>n</name><value><int>3</int></value></member>");
    expect(xml).toContain("<boolean>1</boolean>");
    expect(xml).toContain("a &lt; b &amp; c");
  });
  it("decodes arrays of structs", () => {
    const xml = `<?xml version="1.0"?><methodResponse><params><param><value><array><data>
      <value><struct><member><name>id</name><value><string>15</string></value></member>
      <member><name>additionalInfo</name><value><struct><member><name>external_id</name><value><int>7</int></value></member></struct></value></member></struct></value>
      </data></array></value></param></params></methodResponse>`;
    expect(decodeResponse(xml)).toEqual([{ id: "15", additionalInfo: { external_id: 7 } }]);
  });
  it("decodes single-element arrays and booleans", () => {
    const xml = `<methodResponse><params><param><value><array><data><value><boolean>1</boolean></value></data></array></value></param></params></methodResponse>`;
    expect(decodeResponse(xml)).toEqual([true]);
  });
  it("raises faults", () => {
    const xml = `<methodResponse><fault><value><struct><member><name>faultCode</name><value><int>4</int></value></member><member><name>faultString</name><value><string>Too many</string></value></member></struct></value></fault></methodResponse>`;
    expect(() => decodeResponse(xml)).toThrow(RpcFault);
  });
  it("TestLink client surfaces TestLink-style error arrays", async () => {
    const body = `<methodResponse><params><param><value><array><data><value><struct>
      <member><name>code</name><value><int>2000</int></value></member>
      <member><name>message</name><value><string>Can not authenticate client: invalid developer key</string></value></member>
      </struct></value></data></array></value></param></params></methodResponse>`;
    vi.stubGlobal("fetch", vi.fn(async () => new Response(body, { status: 200 })));
    const tl = new TestLinkClient({ url: "http://tl/xmlrpc.php", devKey: "bad", authorLogin: "qa" });
    await expect(tl.checkDevKey()).rejects.toThrow(/invalid developer key/);
  });
});

describe("jira", () => {
  it("flattens Atlassian Document Format", () => {
    const adf = { type: "doc", content: [
      { type: "paragraph", content: [{ type: "text", text: "Là Operator" }] },
      { type: "bulletList", content: [{ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "AC-1" }] }] }] },
    ] };
    expect(adfToText(adf)).toBe("Là Operator\n- AC-1\n");
    expect(adfToText("plain")).toBe("plain");
  });
  it("uses Basic auth on Cloud, Bearer on Data Center, and pages through sprint issues", async () => {
    const calls: { url: string; auth: string }[] = [];
    const page = (keys: string[], total: number) =>
      new Response(JSON.stringify({ total, maxResults: 50, issues: keys.map((k) => ({ key: k, fields: { summary: k, description: null, status: { name: "To Do" }, subtasks: [] } })) }));
    let n = 0;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, auth: (init.headers as Record<string, string>).Authorization });
      return n++ === 0 ? page(["OP-1", "OP-2"], 3) : page(["OP-3"], 3);
    }));
    const cloud = new JiraClient({ baseUrl: "https://x.atlassian.net/", flavor: "cloud", email: "bot@x", token: "t" });
    const r = await cloud.sprintStories(7, "Story");
    expect(r.map((s) => s.key)).toEqual(["OP-1", "OP-2", "OP-3"]);
    expect(calls[0].url).toContain("/rest/agile/1.0/sprint/7/issue?jql=issuetype%20%3D%20%22Story%22");
    expect(calls[1].url).toContain("startAt=2");
    expect(calls[0].auth).toBe(`Basic ${Buffer.from("bot@x:t").toString("base64")}`);
    n = 0;
    const dc = new JiraClient({ baseUrl: "https://jira.local", flavor: "dc", token: "pat" });
    await dc.sprintStories(7, "Story");
    expect(calls.at(-1)!.auth).toBe("Bearer pat");
  });
  it("explains auth failures", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("no", { status: 401 })));
    await expect(new JiraClient({ baseUrl: "https://x", flavor: "cloud", email: "a", token: "b" }).myself()).rejects.toThrow(/sai email\/token/);
  });
});

describe("testlink xml + steps", () => {
  it("escapes names and wraps text in CDATA", () => {
    const xml = toTestlinkXml(`OP-1 "A" & B`, [
      { seq: 1, usCode: "US1", type: "happy", title: "Xoá <deck>", priority: "high", preconditions: "", requirementRef: "AC-1", steps: [{ action: "Bấm ]]> Xoá", expected: "Popup" }] },
    ]);
    expect(xml).toContain(`<testsuite name="OP-1 &quot;A&quot; &amp; B">`);
    expect(xml).toContain(`<testcase name="[US1][happy] Xoá &lt;deck&gt;">`);
    expect(xml).toContain("<importance>3</importance>");
    expect(xml).toContain("<![CDATA[Bấm ]]]]><![CDATA[> Xoá]]>");
  });
  it("parses the step editor format", () => {
    const steps = parseSteps("Mở danh sách => Hiện 20 dòng\n\n  Bấm trang 2 => a => b ");
    expect(steps).toEqual([
      { action: "Mở danh sách", expected: "Hiện 20 dòng" },
      { action: "Bấm trang 2", expected: "a => b" },
    ]);
    expect(stepsToText(steps)).toBe("Mở danh sách => Hiện 20 dòng\nBấm trang 2 => a => b");
  });
  it("builds flash URLs", () => {
    expect(withFlash("/stories/OP-1#qna", { ok: "Đã lưu" })).toBe("/stories/OP-1?ok=%C4%90%C3%A3+l%C6%B0u#qna");
  });
});

describe("gemini errors", async () => {
  const { geminiErrorMessage } = await import("@/lib/integrations/gemini");
  it("maps raw SDK errors to readable messages", () => {
    const raw = `got status: 400 . {"error":{"code":400,"message":"API key not valid. Please pass a valid API key.","status":"INVALID_ARGUMENT","details":[{"reason":"API_KEY_INVALID"}]}}`;
    expect(geminiErrorMessage(new Error(raw), "m")).toMatch(/^API key không hợp lệ/);
    expect(geminiErrorMessage(new Error(`{"error":{"code":404,"message":"models/x is not found"}}`), "x")).toMatch(/Không tìm thấy model "x"/);
    expect(geminiErrorMessage(new Error("socket hang up"), "m")).toBe("socket hang up");
  });
});

describe("slack webhook", async () => {
  const http = await import("node:http");
  const { postWebhookMessage } = await import("@/lib/integrations/slack");
  it("posts {text} as JSON and reports HTTP errors", async () => {
    let got = "";
    const srv = http.createServer(async (req, res) => {
      for await (const c of req) got += c;
      res.statusCode = req.url === "/ok" ? 200 : 404;
      res.end();
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
    vi.unstubAllGlobals();
    await postWebhookMessage(`${base}/ok`, "Xin chào QA");
    expect(JSON.parse(got)).toEqual({ text: "Xin chào QA" });
    await expect(postWebhookMessage(`${base}/missing`, "x")).rejects.toThrow(/HTTP 404/);
    srv.close();
  });
});

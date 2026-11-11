// MCP server (stdio) for Antigravity and other MCP clients. Zero dependencies.
// It forwards tool calls to QA Flow Hub's /api/agent endpoint using a personal token.
// Config (env): QA_HUB_URL=http://localhost:3000  QA_HUB_TOKEN=qfh_...
import readline from "node:readline";

const BASE = (process.env.QA_HUB_URL || "http://localhost:3000").replace(/\/+$/, "");
const TOKEN = process.env.QA_HUB_TOKEN || "";
const headers = { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" };

const send = (msg) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...msg }) + "\n");
const log = (...a) => process.stderr.write(`[qa-flow-hub-mcp] ${a.join(" ")}\n`);

async function api(method, body) {
  const res = await fetch(`${BASE}/api/agent`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }));
  if (!data.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

async function handle(msg) {
  const { id, method, params } = msg;
  if (id === undefined) return; // notifications (e.g. notifications/initialized)
  try {
    if (method === "initialize") {
      return send({
        id,
        result: {
          protocolVersion: params?.protocolVersion || "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "qa-flow-hub", version: "1.0.0" },
          instructions: "Công cụ của QA Flow Hub: đọc story và test case, ghi kết quả chạy test, tạo nháp bug. Mọi thứ agent ghi đều chờ QC duyệt.",
        },
      });
    }
    if (method === "ping") return send({ id, result: {} });
    if (method === "tools/list") {
      const data = await api("GET");
      return send({ id, result: { tools: data.tools } });
    }
    if (method === "tools/call") {
      try {
        const data = await api("POST", { tool: params?.name, args: params?.arguments ?? {} });
        return send({ id, result: { content: [{ type: "text", text: JSON.stringify(data.result, null, 2) }] } });
      } catch (e) {
        return send({ id, result: { isError: true, content: [{ type: "text", text: String(e.message || e) }] } });
      }
    }
    return send({ id, error: { code: -32601, message: `Method not found: ${method}` } });
  } catch (e) {
    return send({ id, error: { code: -32603, message: String(e.message || e) } });
  }
}

if (!TOKEN) log("Thiếu QA_HUB_TOKEN. Tạo token ở QA Flow Hub → Hồ sơ.");
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return send({ id: null, error: { code: -32700, message: "Parse error" } });
  }
  handle(msg);
});

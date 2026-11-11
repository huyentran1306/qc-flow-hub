import { getDb } from "@/lib/db";
import { authenticateMcp } from "@/lib/services/mcpTokens";
import { runTool, toolList } from "@/lib/agent/tools";
import { audit } from "@/lib/audit";

export const dynamic = "force-dynamic";

const json = (body: unknown, status = 200) => Response.json(body, { status });

export async function GET(req: Request) {
  const db = await getDb();
  const auth = await authenticateMcp(db, req.headers.get("authorization"));
  if (!auth) return json({ ok: false, error: "Token không hợp lệ, đã hết hạn hoặc đã bị thu hồi." }, 401);
  return json({ ok: true, server: "QA Flow Hub", user: auth.user.name, scope: auth.scope, tools: toolList(auth.scope) });
}

export async function POST(req: Request) {
  const db = await getDb();
  const auth = await authenticateMcp(db, req.headers.get("authorization"));
  if (!auth) return json({ ok: false, error: "Token không hợp lệ, đã hết hạn hoặc đã bị thu hồi." }, 401);
  let body: { tool?: string; args?: Record<string, unknown> };
  try {
    body = await req.json();
  } catch {
    return json({ ok: false, error: "Body phải là JSON {tool, args}." }, 400);
  }
  try {
    const result = await runTool(db, auth, String(body.tool ?? ""), body.args ?? {});
    return json({ ok: true, result });
  } catch (e) {
    await audit(db, { userId: auth.user.id, action: `Agent gọi ${body.tool} lỗi`, detail: { message: (e as Error).message }, source: "mcp" });
    return json({ ok: false, error: (e as Error).message }, 400);
  }
}

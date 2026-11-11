import { XMLParser } from "fast-xml-parser";

export type RpcValue = string | number | boolean | null | RpcValue[] | { [k: string]: RpcValue };

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function encodeValue(v: RpcValue): string {
  if (v === null) return "<value><string></string></value>";
  if (typeof v === "boolean") return `<value><boolean>${v ? 1 : 0}</boolean></value>`;
  if (typeof v === "number") return Number.isInteger(v) ? `<value><int>${v}</int></value>` : `<value><double>${v}</double></value>`;
  if (typeof v === "string") return `<value><string>${esc(v)}</string></value>`;
  if (Array.isArray(v)) return `<value><array><data>${v.map(encodeValue).join("")}</data></array></value>`;
  const members = Object.entries(v)
    .map(([k, val]) => `<member><name>${esc(k)}</name>${encodeValue(val)}</member>`)
    .join("");
  return `<value><struct>${members}</struct></value>`;
}

export function encodeCall(method: string, params: RpcValue[]): string {
  return `<?xml version="1.0"?><methodCall><methodName>${esc(method)}</methodName><params>${params
    .map((p) => `<param>${encodeValue(p)}</param>`)
    .join("")}</params></methodCall>`;
}

const parser = new XMLParser({
  ignoreAttributes: true,
  parseTagValue: false,
  trimValues: false,
  isArray: (name, jpath) => name === "member" || String(jpath).endsWith("data.value"),
});

type Node = Record<string, unknown> | string | undefined;

function decodeValue(node: Node): RpcValue {
  if (node === undefined || node === "") return "";
  if (typeof node === "string") return node;
  const n = node as Record<string, unknown>;
  if ("string" in n) return String(n.string ?? "");
  if ("int" in n) return Number(n.int);
  if ("i4" in n) return Number(n.i4);
  if ("double" in n) return Number(n.double);
  if ("boolean" in n) return String(n.boolean).trim() === "1";
  if ("nil" in n) return null;
  if ("array" in n) {
    const arr = n.array;
    const data = arr && typeof arr === "object" ? (arr as Record<string, unknown>).data : undefined;
    const vals = data && typeof data === "object" ? (((data as Record<string, unknown>).value as Node[] | undefined) ?? []) : [];
    return vals.map(decodeValue);
  }
  if ("struct" in n) {
    const st = n.struct as Record<string, unknown> | string;
    const members = typeof st === "object" && st ? ((st.member as { name: string; value: Node }[]) ?? []) : [];
    const out: Record<string, RpcValue> = {};
    for (const m of members) out[String(m.name)] = decodeValue(m.value);
    return out;
  }
  if ("#text" in n) return String(n["#text"]);
  return "";
}

export class RpcFault extends Error {
  constructor(public code: number, message: string) {
    super(message);
  }
}

export function decodeResponse(xml: string): RpcValue {
  const doc = parser.parse(xml) as { methodResponse?: { params?: { param?: { value: Node } }; fault?: { value: Node } } };
  const r = doc.methodResponse;
  if (!r) throw new Error("Phản hồi XML-RPC không hợp lệ");
  if (r.fault) {
    const f = decodeValue(r.fault.value) as { faultCode?: number; faultString?: string };
    throw new RpcFault(Number(f.faultCode ?? 0), String(f.faultString ?? "XML-RPC fault"));
  }
  return decodeValue(r.params?.param?.value);
}

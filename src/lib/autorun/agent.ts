import { Type } from "@google/genai";
import type { AiClient } from "../integrations/gemini";
import type { TcKind, TcStep } from "../db/schema";
import type { PageSnapshot } from "./snapshot";

export type Verdict = "passed" | "failed" | "blocked";
export type Decision = {
  action: "goto" | "click" | "fill" | "select" | "press" | "http" | "finish";
  ref?: string;
  value?: string;
  url?: string;
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  body?: string;
  step?: number;
  note: string;
  verdict?: Verdict;
  observation?: string;
};

const SCHEMA = {
  type: Type.OBJECT,
  properties: {
    action: { type: Type.STRING, enum: ["goto", "click", "fill", "select", "press", "http", "finish"] },
    ref: { type: Type.STRING, description: "ref của phần tử (vd e12) cho click/fill/select" },
    value: { type: Type.STRING, description: "Chữ cần gõ, giá trị cần chọn, hoặc phím cần nhấn (Enter, Tab…)" },
    url: { type: Type.STRING, description: "URL hoặc đường dẫn cho goto/http" },
    method: { type: Type.STRING, enum: ["GET", "POST", "PUT", "PATCH", "DELETE"] },
    body: { type: Type.STRING, description: "Body JSON (dạng chuỗi) cho http" },
    step: { type: Type.INTEGER, description: "Đang làm bước số mấy của test case" },
    note: { type: Type.STRING, description: "Lý do ngắn cho hành động này" },
    verdict: { type: Type.STRING, enum: ["passed", "failed", "blocked"] },
    observation: { type: Type.STRING, description: "Khi finish: kết quả thực tế quan sát được, tiếng Việt, 1–3 câu" },
  },
  required: ["action", "note"],
};

const SYSTEM_UI = `Bạn là QC tự động điều khiển trình duyệt để chạy một test case.
Mỗi lượt chỉ trả về MỘT hành động JSON.
- click / fill / select: chỉ dùng ref có trong danh sách phần tử hiện tại, không bịa ref.
- goto: đi tới URL (có thể là đường dẫn tương đối so với URL môi trường).
- press: nhấn phím (value = "Enter", "Tab"…).
- Khi cần đăng nhập, gõ đúng {{USERNAME}} và {{PASSWORD}}; hệ thống sẽ tự thay bằng tài khoản test thật.
- finish khi đã đủ thông tin để kết luận:
  passed: mọi kết quả mong đợi đều đúng.
  failed: ứng dụng chạy nhưng kết quả khác mong đợi (ghi rõ khác ở đâu).
  blocked: không thể thực hiện test (trang lỗi, thiếu dữ liệu, không đăng nhập được, thiếu quyền).
- Xem cả danh sách lời gọi API trang đã thực hiện: API trả 4xx/5xx thường là dấu hiệu lỗi.
- Không làm thao tác ngoài phạm vi test case.`;

const SYSTEM_API = `Bạn là QC tự động kiểm thử API cho một test case loại API.
Mỗi lượt chỉ trả về MỘT hành động JSON: "http" để gọi API, hoặc "finish" để kết luận.
- url có thể là đường dẫn tương đối so với URL môi trường. body là chuỗi JSON khi cần.
- Dùng {{USERNAME}} và {{PASSWORD}} nếu API cần đăng nhập; hệ thống tự thay bằng tài khoản test thật.
- So sánh mã trạng thái và nội dung trả về với kết quả mong đợi.
  passed: đúng như mong đợi. failed: API trả sai (mã trạng thái, dữ liệu, thông báo lỗi). blocked: không gọi được (sai địa chỉ, hệ thống sập, thiếu quyền).
- observation: ghi mã trạng thái và điểm sai cụ thể.`;

export type DecideInput = {
  kind: TcKind;
  tc: { code: string; title: string; preconditions: string; steps: TcStep[] };
  baseUrl: string;
  hasAccount: boolean;
  history: string[];
  page?: PageSnapshot;
  recentApi: string[];
};

export function buildPrompt(i: DecideInput): string {
  const steps = i.tc.steps.map((s, n) => `${n + 1}. ${s.action}\n   → Mong đợi: ${s.expected}`).join("\n");
  const parts = [
    `Test case ${i.tc.code}: ${i.tc.title}`,
    `Điều kiện trước: ${i.tc.preconditions || "(không)"}`,
    `Các bước:\n${steps}`,
    `URL môi trường: ${i.baseUrl}`,
    `Tài khoản test: ${i.hasAccount ? "có ({{USERNAME}} / {{PASSWORD}})" : "không có"}`,
    `Đã làm:\n${i.history.length ? i.history.slice(-14).join("\n") : "(chưa làm gì)"}`,
  ];
  if (i.recentApi.length) parts.push(`Lời gọi API gần đây:\n${i.recentApi.slice(-12).join("\n")}`);
  if (i.page) {
    parts.push(`Trang hiện tại: ${i.page.url} · ${i.page.title}`);
    parts.push(`Phần tử tương tác (ref):\n${i.page.elements.map((e) => JSON.stringify(e)).join("\n")}`);
    parts.push(`Nội dung hiển thị:\n${i.page.text}`);
  }
  return parts.join("\n\n");
}

export async function decide(ai: AiClient, input: DecideInput): Promise<Decision> {
  const d = await ai.generateJson<Decision>({ system: input.kind === "api" ? SYSTEM_API : SYSTEM_UI, prompt: buildPrompt(input), schema: SCHEMA });
  if (!d || typeof d.action !== "string") return { action: "finish", verdict: "blocked", note: "AI trả lời không hợp lệ", observation: "AI không trả về hành động hợp lệ." };
  return d;
}

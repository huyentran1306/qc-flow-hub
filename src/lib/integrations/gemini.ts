import { GoogleGenAI } from "@google/genai";
import { IntegrationError } from "./http";

/** Minimal AI interface the services depend on; tests swap in a fake. */
export interface AiClient {
  model: string;
  generateJson<T>(opts: { system: string; prompt: string; schema: object }): Promise<T>;
}

/** Turns the SDK's raw JSON error into a short Vietnamese message. */
export function geminiErrorMessage(e: unknown, model: string): string {
  const raw = (e as Error)?.message ?? String(e);
  let msg = raw;
  let status: number | undefined;
  let reason = "";
  const jsonStart = raw.indexOf("{");
  if (jsonStart >= 0) {
    try {
      const body = JSON.parse(raw.slice(jsonStart)) as { error?: { code?: number; message?: string; status?: string; details?: { reason?: string }[] } };
      msg = body.error?.message ?? msg;
      status = body.error?.code;
      reason = body.error?.details?.find((d) => d.reason)?.reason ?? body.error?.status ?? "";
    } catch {
      /* keep raw */
    }
  }
  if (reason === "API_KEY_INVALID" || /API key not valid/i.test(msg)) return "API key không hợp lệ. Tạo lại key ở aistudio.google.com rồi dán vào màn Kết nối.";
  if (status === 404 || /not found/i.test(msg)) return `Không tìm thấy model "${model}". Kiểm tra lại tên model trong AI Studio.`;
  if (status === 429) return "Đã vượt hạn mức gọi Gemini. Thử lại sau ít phút hoặc nâng gói.";
  if (status === 403) return "API key không có quyền dùng Gemini API (kiểm tra project và billing).";
  return msg.slice(0, 300);
}

export function geminiClient(apiKey: string, model: string, baseUrl?: string): AiClient {
  const ai = new GoogleGenAI({ apiKey, ...(baseUrl ? { httpOptions: { baseUrl } } : {}) });
  return {
    model,
    async generateJson<T>({ system, prompt, schema }: { system: string; prompt: string; schema: object }) {
      let text: string | undefined;
      try {
        const res = await ai.models.generateContent({
          model,
          contents: prompt,
          config: { systemInstruction: system, responseMimeType: "application/json", responseSchema: schema },
        });
        text = res.text;
      } catch (e) {
        throw new IntegrationError("Gemini", geminiErrorMessage(e, model));
      }
      if (!text) throw new IntegrationError("Gemini", "không trả về nội dung");
      try {
        return JSON.parse(text) as T;
      } catch {
        throw new IntegrationError("Gemini", "trả về JSON không hợp lệ");
      }
    },
  };
}

export async function pingGemini(apiKey: string, model: string, baseUrl?: string): Promise<void> {
  const ai = new GoogleGenAI({ apiKey, ...(baseUrl ? { httpOptions: { baseUrl } } : {}) });
  try {
    await ai.models.generateContent({ model, contents: "ping", config: { maxOutputTokens: 5 } });
  } catch (e) {
    throw new IntegrationError("Gemini", geminiErrorMessage(e, model));
  }
}

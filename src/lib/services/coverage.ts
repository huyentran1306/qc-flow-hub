import { eq, and } from "drizzle-orm";
import { Type } from "@google/genai";
import type { DB } from "../db";
import { questions, stories, testCases, userStories, type StoryCoverage, type TcKind, type TcPriority, type TcType } from "../db/schema";
import type { AiClient } from "../integrations/gemini";
import { audit } from "../audit";
import { tcCode } from "../format";
import { insertWithNextSeq } from "../seq";

/** Acceptance criteria written as "AC-1: …" in the Jira description. */
export function parseAcs(description: string): { code: string; text: string }[] {
  const out: { code: string; text: string }[] = [];
  for (const line of description.split("\n")) {
    const m = line.match(/\b(AC[- ]?\d+)\s*[:.)-]\s*(.+)$/i);
    if (m) out.push({ code: m[1].toUpperCase().replace(/[ ]/, "-").replace(/^AC(\d)/, "AC-$1"), text: m[2].trim() });
  }
  return out;
}

/** AC → test cases that reference it (requirementRef), computed locally. */
export function acMatrix(description: string, tcs: { seq: number; requirementRef: string | null; status: string }[]) {
  return parseAcs(description).map((ac) => ({
    ...ac,
    tcs: tcs.filter((t) => t.status === "approved" && (t.requirementRef ?? "").toUpperCase().replace(/\s/g, "").split(/[,;/]/).includes(ac.code)).map((t) => tcCode(t.seq)),
  }));
}

const SCHEMA = {
  type: Type.OBJECT,
  properties: {
    items: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          requirement: { type: Type.STRING },
          coveredBy: { type: Type.ARRAY, items: { type: Type.STRING } },
          status: { type: Type.STRING, enum: ["covered", "partial", "missing"] },
          note: { type: Type.STRING },
        },
        required: ["requirement", "coveredBy", "status", "note"],
      },
    },
    suggestions: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          us: { type: Type.STRING },
          title: { type: Type.STRING },
          type: { type: Type.STRING, enum: ["happy", "negative", "edge"] },
          kind: { type: Type.STRING, enum: ["ui", "api"] },
          priority: { type: Type.STRING, enum: ["high", "medium", "low"] },
          preconditions: { type: Type.STRING },
          steps: { type: Type.ARRAY, items: { type: Type.OBJECT, properties: { action: { type: Type.STRING }, expected: { type: Type.STRING } }, required: ["action", "expected"] } },
        },
        required: ["us", "title", "type", "priority", "steps"],
      },
    },
  },
  required: ["items", "suggestions"],
};

export async function aiCoverage(db: DB, ai: AiClient, storyId: string, userId: string) {
  const [s] = await db.select().from(stories).where(eq(stories.id, storyId));
  const us = await db.select().from(userStories).where(eq(userStories.storyId, storyId));
  const qs = await db.select().from(questions).where(and(eq(questions.storyId, storyId), eq(questions.status, "answered")));
  const tcs = await db.select().from(testCases).where(and(eq(testCases.storyId, storyId), eq(testCases.status, "approved")));
  const r = await ai.generateJson<Omit<StoryCoverage, "model" | "at">>({
    system: `Bạn là QC Lead review độ phủ test. Liệt kê từng yêu cầu (AC, rule nghiệp vụ, câu trả lời Q&A) và test case nào phủ nó.
- coveredBy: mã TC (vd TC-03). status: covered (đủ), partial (thiếu nhánh negative/edge hoặc thiếu phân quyền), missing (chưa có TC).
- suggestions: chỉ đề xuất test case cho các chỗ partial/missing, tối đa 8, không lặp test case đã có. Tiếng Việt.`,
    prompt: `Story ${s.jiraKey} ${s.summary}
Mô tả:
${s.description}

User Story:
${us.map((u) => `${u.code} - ${u.title}: ${u.description}`).join("\n") || "(chưa tách)"}

Q&A đã trả lời:
${qs.map((q) => `- ${q.content} → ${q.answer}`).join("\n") || "(không có)"}

Test case đã duyệt:
${tcs.sort((a, z) => a.seq - z.seq).map((t) => `${tcCode(t.seq)} [${t.usCode}][${t.type}${t.kind === "api" ? "][api" : ""}] ${t.title}${t.requirementRef ? ` (ref ${t.requirementRef})` : ""}`).join("\n") || "(chưa có)"}`,
    schema: SCHEMA,
  });
  const coverage: StoryCoverage = {
    items: (r.items ?? []).map((i) => ({ ...i, status: (["covered", "partial", "missing"].includes(i.status) ? i.status : "partial") as "covered" })),
    suggestions: (r.suggestions ?? [])
      .filter((x) => x.title && Array.isArray(x.steps) && x.steps.length)
      .slice(0, 8)
      .map((x) => ({
        us: x.us || "US1",
        title: x.title,
        type: (["happy", "negative", "edge"].includes(x.type) ? x.type : "edge") as TcType,
        kind: (x.kind === "api" ? "api" : "ui") as TcKind,
        priority: (["high", "medium", "low"].includes(x.priority) ? x.priority : "medium") as TcPriority,
        preconditions: x.preconditions ?? "",
        steps: x.steps.map((st) => ({ action: String(st.action ?? ""), expected: String(st.expected ?? "") })),
      })),
    model: ai.model,
    at: new Date().toISOString(),
  };
  await db.update(stories).set({ coverage }).where(eq(stories.id, storyId));
  await audit(db, { userId, action: "AI kiểm tra độ phủ", target: s.jiraKey, detail: { gaps: coverage.items.filter((i) => i.status !== "covered").length, suggestions: coverage.suggestions.length } });
  return coverage;
}

/** Adds the AI's suggested test cases as drafts for QC review. */
export async function addCoverageSuggestions(db: DB, storyId: string, userId: string) {
  const [s] = await db.select().from(stories).where(eq(stories.id, storyId));
  const list = s.coverage?.suggestions ?? [];
  if (!list.length) return 0;
  await insertWithNextSeq(db, storyId, async (first) => {
    await db.insert(testCases).values(
      list.map((x, i) => ({ storyId, seq: first + i, usCode: x.us, title: x.title, type: x.type, kind: x.kind, priority: x.priority, preconditions: x.preconditions, steps: x.steps, source: "ai" as const, status: "draft" as const, createdBy: userId })),
    );
  });
  await db.update(stories).set({ coverage: { ...s.coverage!, suggestions: [] } }).where(eq(stories.id, storyId));
  await audit(db, { userId, action: `Thêm ${list.length} TC gợi ý từ kiểm tra độ phủ`, target: s.jiraKey });
  return list.length;
}

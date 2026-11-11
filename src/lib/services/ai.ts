import { eq } from "drizzle-orm";
import { insertWithNextSeq } from "../seq";
import { Type } from "@google/genai";
import type { DB } from "../db";
import { questions, stories, testCases, userStories, type TcPriority, type TcStep, type TcType } from "../db/schema";
import type { AiClient } from "../integrations/gemini";
import { audit } from "../audit";

type StoryRow = typeof stories.$inferSelect;

const ANALYZE_SYSTEM = `Bạn là QC senior trong team Scrum. Đọc ticket Jira và phân tích requirement để chuẩn bị viết test case.
- Tách ticket thành các User Story (US1, US2, ...). Nếu ticket đã ghi rõ US thì giữ nguyên tên.
- testPoints: các điểm cần test, ngắn gọn, mỗi điểm một ý.
- dependencies: ticket/hệ thống khác mà việc test phụ thuộc (nếu thấy trong mô tả).
- risks: chỗ dễ lỗi hoặc dễ hiểu sai.
- questions: chỗ requirement chưa rõ cần hỏi BA/PO. Không hỏi lại điều đã có câu trả lời.
- Chỉ dựa vào nội dung được cung cấp, không bịa rule. Viết tiếng Việt.`;

const ANALYZE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    userStories: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: { code: { type: Type.STRING }, title: { type: Type.STRING }, description: { type: Type.STRING } },
        required: ["code", "title", "description"],
      },
    },
    testPoints: { type: Type.ARRAY, items: { type: Type.STRING } },
    dependencies: { type: Type.ARRAY, items: { type: Type.STRING } },
    risks: { type: Type.ARRAY, items: { type: Type.STRING } },
    questions: { type: Type.ARRAY, items: { type: Type.STRING } },
  },
  required: ["userStories", "testPoints", "dependencies", "risks", "questions"],
};

type AnalyzeResult = {
  userStories: { code: string; title: string; description: string }[];
  testPoints: string[];
  dependencies: string[];
  risks: string[];
  questions: string[];
};

const TC_SYSTEM = `Bạn là QC senior. Viết test case bằng tiếng Việt cho các User Story được cung cấp.
- Chỉ dựa vào requirement và các câu Q&A đã có câu trả lời. Không bịa rule không có.
- Mỗi User Story cần đủ happy case, negative case (gồm phân quyền nếu có) và edge case (giá trị biên, dữ liệu rỗng, lỗi mạng).
- Mỗi bước có hành động cụ thể và kết quả mong đợi kiểm chứng được.
- requirementRef ghi mã AC (ví dụ AC-3) hoặc mã câu hỏi (ví dụ Q2) nếu có.
- Không lặp lại các test case đã có (danh sách được cung cấp).
- Điểm nào chưa rõ thì đưa vào openQuestions thay vì tự đoán.`;

const TC_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    testCases: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          us: { type: Type.STRING },
          title: { type: Type.STRING },
          type: { type: Type.STRING, enum: ["happy", "negative", "edge"] },
          priority: { type: Type.STRING, enum: ["high", "medium", "low"] },
          preconditions: { type: Type.STRING },
          requirementRef: { type: Type.STRING },
          steps: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: { action: { type: Type.STRING }, expected: { type: Type.STRING } },
              required: ["action", "expected"],
            },
          },
        },
        required: ["us", "title", "type", "priority", "steps"],
      },
    },
    openQuestions: { type: Type.ARRAY, items: { type: Type.STRING } },
  },
  required: ["testCases", "openQuestions"],
};

type TcResult = {
  testCases: { us: string; title: string; type: TcType; priority: TcPriority; preconditions?: string; requirementRef?: string; steps: TcStep[] }[];
  openQuestions: string[];
};

async function answeredQna(db: DB, storyId: string) {
  const qs = await db.select().from(questions).where(eq(questions.storyId, storyId));
  return qs;
}

function qnaBlock(qs: (typeof questions.$inferSelect)[]): string {
  const answered = qs.filter((q) => q.status === "answered" && q.answer);
  if (!answered.length) return "(chưa có)";
  return answered.map((q, i) => `- Q${i + 1}: ${q.content}\n  Trả lời: ${q.answer}`).join("\n");
}

async function addAiQuestions(db: DB, storyId: string, userId: string, list: string[], existing: (typeof questions.$inferSelect)[]) {
  const seen = new Set(existing.map((q) => q.content.trim().toLowerCase()));
  const fresh = list.map((q) => q.trim()).filter((q) => q && !seen.has(q.toLowerCase()));
  if (fresh.length) {
    await db.insert(questions).values(fresh.map((content) => ({ storyId, content, status: "draft" as const, source: "ai" as const, createdBy: userId })));
  }
  return fresh.length;
}

export async function analyzeStory(db: DB, ai: AiClient, story: StoryRow, userId: string) {
  const qs = await answeredQna(db, story.id);
  const prompt = `Ticket: ${story.jiraKey} ${story.summary}\n\nMô tả:\n${story.description || "(trống)"}\n\nQ&A đã trả lời:\n${qnaBlock(qs)}`;
  const r = await ai.generateJson<AnalyzeResult>({ system: ANALYZE_SYSTEM, prompt, schema: ANALYZE_SCHEMA });

  await db.delete(userStories).where(eq(userStories.storyId, story.id));
  if (r.userStories.length) {
    await db.insert(userStories).values(
      r.userStories.map((u, i) => ({ storyId: story.id, code: u.code || `US${i + 1}`, title: u.title, description: u.description ?? "", position: i })),
    );
  }
  const newQuestions = await addAiQuestions(db, story.id, userId, r.questions, qs);
  await db
    .update(stories)
    .set({
      analysis: { testPoints: r.testPoints, dependencies: r.dependencies, risks: r.risks, model: ai.model, at: new Date().toISOString() },
      qaStage: story.qaStage === "analyzing" ? (newQuestions ? "qna" : "tc_ready") : story.qaStage,
    })
    .where(eq(stories.id, story.id));
  await audit(db, { userId, action: "AI phân tích requirement", target: story.jiraKey, detail: { model: ai.model, userStories: r.userStories.length, questions: newQuestions } });
  return { userStories: r.userStories.length, questions: newQuestions };
}

export async function generateTestCases(db: DB, ai: AiClient, story: StoryRow, userId: string) {
  const us = await db.select().from(userStories).where(eq(userStories.storyId, story.id)).orderBy(userStories.position);
  const qs = await answeredQna(db, story.id);
  const existing = await db.select({ title: testCases.title, usCode: testCases.usCode }).from(testCases).where(eq(testCases.storyId, story.id));
  const usBlock = us.length ? us.map((u) => `${u.code} - ${u.title}\n${u.description}`).join("\n\n") : "US1 - toàn bộ ticket";
  const prompt = `Ticket: ${story.jiraKey} ${story.summary}

Mô tả gốc:
${story.description || "(trống)"}

User Story:
${usBlock}

Q&A đã trả lời:
${qnaBlock(qs)}

Test case đã có (không viết lại):
${existing.length ? existing.map((t) => `- [${t.usCode}] ${t.title}`).join("\n") : "(chưa có)"}`;

  const r = await ai.generateJson<TcResult>({ system: TC_SYSTEM, prompt, schema: TC_SCHEMA });
  const validUs = new Set(us.map((u) => u.code));
  const valid = r.testCases.filter((t) => t.title?.trim() && Array.isArray(t.steps) && t.steps.length);
  const rows = await insertWithNextSeq(db, story.id, async (first) => {
    const list = valid.map((t, i) => ({
      storyId: story.id,
      seq: first + i,
      usCode: validUs.size && !validUs.has(t.us) ? (us[0]?.code ?? "US1") : t.us || "US1",
      title: t.title.trim(),
      type: (["happy", "negative", "edge"].includes(t.type) ? t.type : "happy") as TcType,
      priority: (["high", "medium", "low"].includes(t.priority) ? t.priority : "medium") as TcPriority,
      preconditions: t.preconditions ?? "",
      steps: t.steps.map((s) => ({ action: String(s.action ?? ""), expected: String(s.expected ?? "") })),
      requirementRef: t.requirementRef || null,
      source: "ai" as const,
      status: "draft" as const,
      createdBy: userId,
    }));
    if (list.length) await db.insert(testCases).values(list);
    return list;
  });
  const newQuestions = await addAiQuestions(db, story.id, userId, r.openQuestions, qs);
  await audit(db, { userId, action: "AI sinh test case", target: story.jiraKey, detail: { model: ai.model, created: rows.length, questions: newQuestions } });
  return { created: rows.length, questions: newQuestions };
}

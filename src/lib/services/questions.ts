import { and, eq, isNotNull, ne } from "drizzle-orm";
import type { DB } from "../db";
import { questions, stories } from "../db/schema";
import { audit } from "../audit";
import type { JiraClient } from "../integrations/jira";

/** Short code put in the Jira comment so BA/PO replies can be matched to the question. */
export function questionCode(id: string): string {
  return `Q-${id.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
}

async function storyOf(db: DB, questionId: string) {
  const [q] = await db.select().from(questions).where(eq(questions.id, questionId));
  if (!q) throw new Error("Không tìm thấy câu hỏi.");
  const [s] = await db.select().from(stories).where(eq(stories.id, q.storyId));
  return { q, s };
}

export async function addQuestion(db: DB, userId: string, storyId: string, content: string, askedTo: string | null) {
  if (!content.trim()) throw new Error("Cần nhập nội dung câu hỏi.");
  await db.insert(questions).values({ storyId, content: content.trim(), askedTo: askedTo?.trim() || null, status: "open", source: "manual", createdBy: userId });
}

/** Turns an AI draft into an open question; posts it to Jira when a client is given. */
export async function publishQuestion(db: DB, userId: string, questionId: string, askedTo: string | null, jira: JiraClient | null) {
  const { q, s } = await storyOf(db, questionId);
  let jiraCommentId: string | null = null;
  if (jira && !s.jiraKey.startsWith("DEMO-")) {
    const to = askedTo?.trim() ? `${askedTo.trim()}: ` : "";
    const code = questionCode(q.id);
    jiraCommentId = await jira.addComment(s.jiraKey, `[Q&A từ QC · ${code}] ${to}${q.content}\n(Trả lời bằng một comment mới, ghi kèm mã ${code} để tool tự nhận.)`);
  }
  await db.update(questions).set({ status: "open", askedTo: askedTo?.trim() || q.askedTo, jiraCommentId }).where(eq(questions.id, questionId));
  await audit(db, { userId, action: jiraCommentId ? "Gửi câu hỏi lên Jira" : "Mở câu hỏi", target: s.jiraKey, detail: { question: q.content } });
}

export async function answerQuestion(db: DB, userId: string, questionId: string, answer: string) {
  if (!answer.trim()) throw new Error("Cần nhập câu trả lời.");
  const { q, s } = await storyOf(db, questionId);
  await db.update(questions).set({ answer: answer.trim(), status: "answered", answeredBy: userId }).where(eq(questions.id, questionId));
  await audit(db, { userId, action: "Ghi câu trả lời Q&A", target: s.jiraKey, detail: { question: q.content } });
}

export async function deleteQuestion(db: DB, userId: string, questionId: string) {
  const { q, s } = await storyOf(db, questionId);
  await db.delete(questions).where(eq(questions.id, questionId));
  await audit(db, { userId, action: "Xoá câu hỏi", target: s.jiraKey, detail: { question: q.content } });
}

export async function storyIdOfQuestion(db: DB, questionId: string) {
  return (await storyOf(db, questionId)).s;
}

/** Looks for BA/PO replies in the story's Jira comments and attaches them to open questions as suggestions.
 *  A reply that mentions a question code goes to that question; otherwise it goes to the latest question
 *  posted before it. QC still has to accept the suggestion. */
export async function syncQnaReplies(db: DB, jira: JiraClient, storyId: string): Promise<number> {
  const [s] = await db.select().from(stories).where(eq(stories.id, storyId));
  const open = await db
    .select()
    .from(questions)
    .where(and(eq(questions.storyId, storyId), ne(questions.status, "answered"), isNotNull(questions.jiraCommentId)));
  if (!open.length) return 0;
  const botId = await jira.myselfId().catch(() => "");
  const comments = (await jira.listComments(s.jiraKey)).filter((c) => (!botId || c.authorId !== botId) && !c.body.startsWith("[Q&A từ QC") && !c.body.startsWith("[Test report]"));
  const posted = [...open].sort((a, b) => Number(a.jiraCommentId) - Number(b.jiraCommentId));
  const found = new Map<string, { body: string; author: string; id: string }>();
  for (const c of comments) {
    const byCode = posted.find((q) => c.body.toUpperCase().includes(questionCode(q.id)));
    const target = byCode ?? [...posted].reverse().find((q) => Number(q.jiraCommentId) < Number(c.id));
    if (!target) continue;
    if (found.has(target.id) && !byCode) continue; // keep the first reply unless a later one names the question
    const body = c.body.replace(new RegExp(questionCode(target.id), "gi"), "").replace(/^[\s:·-]+/, "").trim();
    found.set(target.id, { body, author: c.authorName, id: c.id });
  }
  let n = 0;
  for (const q of posted) {
    const f = found.get(q.id);
    if (!f || q.jiraReplyId === f.id) continue;
    await db.update(questions).set({ jiraReply: f.body, jiraReplyAuthor: f.author, jiraReplyId: f.id }).where(eq(questions.id, q.id));
    n++;
  }
  if (n) await audit(db, { userId: null, action: `Tìm thấy ${n} câu trả lời Q&A trên Jira`, target: s.jiraKey, source: "system" });
  return n;
}

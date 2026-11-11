"use server";

import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { projects } from "@/lib/db/schema";
import { currentUser, actorFor, setCurrentProject } from "@/lib/session";
import { runAndReturn } from "@/lib/flash";
import { storyActorById } from "@/lib/actor";
import { loadAi, loadJira, loadTestLink } from "@/lib/services/connections";
import { syncProjectFromJira } from "@/lib/services/stories";
import { seedDemo } from "@/lib/services/demo";
import { analyzeStory, generateTestCases } from "@/lib/services/ai";
import { addQuestion, answerQuestion, deleteQuestion, publishQuestion, storyIdOfQuestion, syncQnaReplies } from "@/lib/services/questions";
import { addManualTc, approveTcs, deleteTc, parseTcForm, pushToTestlink, tcWithStory, updateTc } from "@/lib/services/testcases";
import { tcCode } from "@/lib/format";

/** Per-story permission check (shared with the other action files). */
const storyActor = storyActorById;

const storyPath = (key: string, hash = "") => `/stories/${key}${hash}`;

export async function switchProjectAction(fd: FormData) {
  await setCurrentProject(String(fd.get("project") ?? ""));
  await runAndReturn("/board", async () => undefined);
}

export async function syncJiraAction() {
  await runAndReturn("/board", async () => {
    const { db, user, ctx } = await actorFor("jira.sync");
    if (!ctx.project) throw new Error("Chưa chọn dự án.");
    if (ctx.project.isDemo) throw new Error("Dự án mẫu không đồng bộ Jira. Hãy tạo dự án thật ở Quản trị → Dự án.");
    const jira = await loadJira(db);
    if (!jira) throw new Error("Chưa kết nối Jira. Admin vào Quản trị → Kết nối để nhập token.");
    const r = await syncProjectFromJira(db, jira, ctx.project, user.id);
    return `Đã đồng bộ ${r.sprints.join(", ")}: ${r.created} story mới, ${r.updated} story cập nhật${r.replies ? `, ${r.replies} câu trả lời Q&A mới từ Jira` : ""}.`;
  });
}

export async function seedDemoAction() {
  const user = await currentUser();
  await runAndReturn("/board", async () => {
    if (!user) throw new Error("Phiên đăng nhập đã hết.");
    if (!user.isAdmin) throw new Error("Chỉ Admin được tạo dự án mẫu.");
    const db = await getDb();
    const key = await seedDemo(db, user.id);
    await setCurrentProject(key);
    return "Đã tạo dự án mẫu với 3 story. Bạn là QC Lead của dự án này.";
  });
}

export async function analyzeAction(fd: FormData) {
  const key = String(fd.get("key"));
  await runAndReturn(storyPath(key, "#analysis"), async () => {
    const { db, user, story } = await storyActor(String(fd.get("storyId")), "ai.run");
    const ai = await loadAi(db);
    if (!ai) throw new Error("Chưa kết nối Gemini. Admin vào Quản trị → Kết nối.");
    const r = await analyzeStory(db, ai, story, user.id);
    return `AI đã tách ${r.userStories} User Story và đề xuất ${r.questions} câu hỏi mới (đang ở dạng nháp).`;
  });
}

export async function generateTcAction(fd: FormData) {
  const key = String(fd.get("key"));
  await runAndReturn(storyPath(key, "#testcases"), async () => {
    const { db, user, story } = await storyActor(String(fd.get("storyId")), "ai.run");
    const ai = await loadAi(db);
    if (!ai) throw new Error("Chưa kết nối Gemini. Admin vào Quản trị → Kết nối.");
    const r = await generateTestCases(db, ai, story, user.id);
    return `AI đã sinh ${r.created} test case nháp${r.questions ? ` và ${r.questions} câu hỏi cần làm rõ` : ""}. Hãy duyệt trước khi đẩy lên TestLink.`;
  });
}

export async function addQuestionAction(fd: FormData) {
  const key = String(fd.get("key"));
  await runAndReturn(storyPath(key, "#qna"), async () => {
    const { db, user, story } = await storyActor(String(fd.get("storyId")), "qna.manage");
    await addQuestion(db, user.id, story.id, String(fd.get("content") ?? ""), String(fd.get("askedTo") ?? ""));
    return "Đã thêm câu hỏi.";
  });
}

export async function publishQuestionAction(fd: FormData) {
  const key = String(fd.get("key"));
  await runAndReturn(storyPath(key, "#qna"), async () => {
    const qid = String(fd.get("questionId"));
    const s = await storyIdOfQuestion(await getDb(), qid);
    const { db, user } = await storyActor(s.id, "qna.manage");
    const toJira = fd.get("toJira") === "1";
    const jira = toJira ? await loadJira(db) : null;
    if (toJira && !jira) throw new Error("Chưa kết nối Jira nên không gửi được. Bỏ chọn “Gửi lên Jira” để chỉ mở câu hỏi.");
    await publishQuestion(db, user.id, qid, String(fd.get("askedTo") ?? ""), jira);
    return jira ? "Đã gửi câu hỏi thành comment trên Jira." : "Đã mở câu hỏi.";
  });
}

export async function answerQuestionAction(fd: FormData) {
  const key = String(fd.get("key"));
  await runAndReturn(storyPath(key, "#qna"), async () => {
    const qid = String(fd.get("questionId"));
    const s = await storyIdOfQuestion(await getDb(), qid);
    const { db, user } = await storyActor(s.id, "qna.answer");
    await answerQuestion(db, user.id, qid, String(fd.get("answer") ?? ""));
    return "Đã ghi câu trả lời.";
  });
}

export async function deleteQuestionAction(fd: FormData) {
  const key = String(fd.get("key"));
  await runAndReturn(storyPath(key, "#qna"), async () => {
    const qid = String(fd.get("questionId"));
    const s = await storyIdOfQuestion(await getDb(), qid);
    const { db, user } = await storyActor(s.id, "qna.manage");
    await deleteQuestion(db, user.id, qid);
    return "Đã xoá câu hỏi.";
  });
}

export async function approveTcAction(fd: FormData) {
  const key = String(fd.get("key"));
  await runAndReturn(storyPath(key, "#testcases"), async () => {
    const { db, user, story } = await storyActor(String(fd.get("storyId")), "tc.approve");
    const ids = fd.getAll("tcId").map(String);
    const n = await approveTcs(db, user.id, story.id, fd.get("all") === "1" ? "all-drafts" : ids);
    return n ? `Đã duyệt ${n} test case.` : "Chưa chọn test case nào.";
  });
}

export async function deleteTcAction(fd: FormData) {
  const key = String(fd.get("key"));
  await runAndReturn(storyPath(key, "#testcases"), async () => {
    const { s } = await tcWithStory(await getDb(), String(fd.get("tcId")));
    const { db, user } = await storyActor(s.id, "tc.edit");
    await deleteTc(db, user.id, String(fd.get("tcId")));
    return "Đã xoá test case.";
  });
}

export async function saveTcAction(fd: FormData) {
  const key = String(fd.get("key"));
  const tcId = String(fd.get("tcId") ?? "");
  await runAndReturn(storyPath(key, "#testcases"), async () => {
    const input = parseTcForm(fd);
    if (tcId) {
      const { tc, s } = await tcWithStory(await getDb(), tcId);
      const { db, user } = await storyActor(s.id, "tc.edit");
      await updateTc(db, user.id, tcId, input);
      return `Đã lưu ${tcCode(tc.seq)}.`;
    }
    const { db, user, story } = await storyActor(String(fd.get("storyId")), "tc.edit");
    await addManualTc(db, user.id, story.id, input);
    return "Đã thêm test case.";
  });
}

export async function pushTestlinkAction(fd: FormData) {
  const key = String(fd.get("key"));
  await runAndReturn(storyPath(key, "#testcases"), async () => {
    const { db, user, story } = await storyActor(String(fd.get("storyId")), "testlink.push");
    const [p] = await db.select().from(projects).where(eq(projects.id, story.projectId));
    if (p.isDemo) throw new Error("Dự án mẫu không đẩy lên TestLink. Dùng nút Tải XML để thử import tay.");
    const tl = await loadTestLink(db);
    if (!tl) throw new Error("Chưa kết nối TestLink. Admin vào Quản trị → Kết nối, hoặc dùng nút Tải XML.");
    const r = await pushToTestlink(db, tl, story.id, user.id);
    if (r.failed.length) throw new Error(`Đẩy được ${r.pushed}, lỗi ${r.failed.length}: ${r.failed.slice(0, 3).join("; ")}`);
    return r.pushed ? `Đã đẩy ${r.pushed} test case lên TestLink.` : "Không có test case đã duyệt nào cần đẩy.";
  });
}

export async function syncRepliesAction(fd: FormData) {
  const key = String(fd.get("key"));
  await runAndReturn(storyPath(key, "#qna"), async () => {
    const { db, story } = await storyActor(String(fd.get("storyId")), "qna.manage");
    const jira = await loadJira(db);
    if (!jira) throw new Error("Chưa kết nối Jira.");
    const n = await syncQnaReplies(db, jira, story.id);
    return n ? `Tìm thấy ${n} câu trả lời mới trên Jira. Kiểm tra rồi bấm “Dùng câu trả lời này”.` : "Chưa có câu trả lời mới trên Jira.";
  });
}

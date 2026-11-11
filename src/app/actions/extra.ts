"use server";

import { headers } from "next/headers";
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { regressionSuites, stories, suiteRuns, type Env } from "@/lib/db/schema";
import { runAndReturn } from "@/lib/flash";
import { actorFor, currentUser } from "@/lib/session";
import { storyActorById } from "@/lib/actor";
import { roleIn } from "@/lib/services/projects";
import { assertCan } from "@/lib/rbac";
import { loadAi } from "@/lib/services/connections";
import { askProject } from "@/lib/services/dashboard";
import { currentSprint } from "@/lib/services/stories";
import { markAllRead, notifyUsers } from "@/lib/services/notifications";
import { cancelSuiteRun, createSuite, deleteSuite, parseSchedule, setSuiteCases, startSuiteRun, updateSuite } from "@/lib/services/regression";
import { addCoverageSuggestions, aiCoverage } from "@/lib/services/coverage";
import { audit } from "@/lib/audit";

const ENVS: Env[] = ["dev", "stg", "prod"];
const envOf = (v: FormDataEntryValue | null): Env => (ENVS.includes(String(v) as Env) ? (String(v) as Env) : "stg");

async function originFromRequest() {
  const h = await headers();
  return process.env.APP_URL || `${h.get("x-forwarded-proto") ?? "http"}://${h.get("host")}`;
}

/** Suite actions: QC or QC Lead of the suite's project. */
async function suiteActor(suiteId: string) {
  const user = await currentUser();
  if (!user) throw new Error("Phiên đăng nhập đã hết.");
  const db = await getDb();
  const [suite] = await db.select().from(regressionSuites).where(eq(regressionSuites.id, suiteId));
  if (!suite) throw new Error("Không tìm thấy bộ regression.");
  assertCan({ isAdmin: user.isAdmin, role: await roleIn(db, user.id, suite.projectId) }, "tc.edit");
  return { db, user, suite };
}

// ---------- dashboard ----------

export async function askAiAction(fd: FormData) {
  await runAndReturn("/dashboard#ask", async () => {
    const { db, user, ctx } = await actorFor("story.view");
    if (!ctx.project) throw new Error("Chưa chọn dự án.");
    const ai = await loadAi(db);
    if (!ai) throw new Error("Cần kết nối Gemini để hỏi AI.");
    const sp = await currentSprint(db, ctx.project.id);
    await askProject(db, ai, ctx.project.id, sp?.id ?? null, user.id, String(fd.get("question") ?? ""));
    return undefined;
  });
}

// ---------- notifications & ownership ----------

export async function markAllReadAction(fd: FormData) {
  const back = String(fd.get("back") || "/inbox");
  await runAndReturn(back, async () => {
    const user = await currentUser();
    if (!user) throw new Error("Phiên đăng nhập đã hết.");
    await markAllRead(await getDb(), user.id);
    return undefined;
  });
}

export async function assignStoryAction(fd: FormData) {
  const key = String(fd.get("key"));
  await runAndReturn(`/stories/${key}`, async () => {
    const { db, user, story } = await storyActorById(String(fd.get("storyId")), "tc.edit");
    const take = fd.get("take") === "1";
    await db.update(stories).set({ qcOwnerId: take ? user.id : null }).where(eq(stories.id, story.id));
    await audit(db, { userId: user.id, action: take ? "Nhận phụ trách story" : "Bỏ phụ trách story", target: story.jiraKey });
    if (take && story.qcOwnerId && story.qcOwnerId !== user.id) {
      await notifyUsers(db, [story.qcOwnerId], { kind: "assigned", title: `${user.name} đã nhận phụ trách ${story.jiraKey}`, link: `/stories/${story.jiraKey}` });
    }
    return take ? "Bạn đang phụ trách story này. Việc của nó sẽ hiện ở “Việc của tôi”." : "Đã bỏ phụ trách.";
  });
}

// ---------- regression ----------

export async function createSuiteAction(fd: FormData) {
  let id = "";
  await runAndReturn(
    () => (id ? `/regression?edit=${id}#s-${id}` : "/regression"),
    async () => {
      const { db, user, ctx } = await actorFor("tc.edit");
      if (!ctx.project) throw new Error("Chưa chọn dự án.");
      id = await createSuite(db, user.id, ctx.project.id, { name: String(fd.get("name") ?? ""), env: envOf(fd.get("env")), description: String(fd.get("description") ?? "") });
      return "Đã tạo bộ regression. Chọn test case cho bộ này bên dưới.";
    },
  );
}

export async function updateSuiteAction(fd: FormData) {
  const id = String(fd.get("suiteId"));
  await runAndReturn(`/regression?edit=${id}#s-${id}`, async () => {
    const { db, user } = await suiteActor(id);
    await updateSuite(db, user.id, id, { name: String(fd.get("name") ?? ""), env: envOf(fd.get("env")), description: String(fd.get("description") ?? ""), schedule: parseSchedule(fd) });
    await setSuiteCases(db, user.id, id, fd.getAll("tcId").map(String));
    return "Đã lưu bộ regression.";
  });
}

export async function deleteSuiteAction(fd: FormData) {
  await runAndReturn("/regression", async () => {
    const id = String(fd.get("suiteId"));
    const { db, user } = await suiteActor(id);
    await deleteSuite(db, user.id, id);
    return "Đã xoá bộ regression.";
  });
}

export async function runSuiteAction(fd: FormData) {
  const id = String(fd.get("suiteId"));
  await runAndReturn(`/regression#s-${id}`, async () => {
    const { db, user } = await suiteActor(id);
    const ai = await loadAi(db);
    if (!ai) throw new Error("Chạy regression cần kết nối Gemini.");
    await startSuiteRun(db, ai, id, { userId: user.id, trigger: "manual", origin: await originFromRequest() });
    return "Đã bắt đầu chạy bộ regression. Trang tự cập nhật tiến độ.";
  });
}

export async function cancelSuiteRunAction(fd: FormData) {
  const runId = String(fd.get("runId"));
  const db = await getDb();
  const [run] = await db.select().from(suiteRuns).where(eq(suiteRuns.id, runId));
  await runAndReturn(`/regression${run ? `#s-${run.suiteId}` : ""}`, async () => {
    if (!run) throw new Error("Không tìm thấy lượt chạy.");
    const { user } = await suiteActor(run.suiteId);
    await cancelSuiteRun(db, user.id, runId);
    return "Đã yêu cầu huỷ.";
  });
}

// ---------- coverage ----------

export async function aiCoverageAction(fd: FormData) {
  const key = String(fd.get("key"));
  await runAndReturn(`/stories/${key}#coverage`, async () => {
    const { db, user, story } = await storyActorById(String(fd.get("storyId")), "ai.run");
    const ai = await loadAi(db);
    if (!ai) throw new Error("Cần kết nối Gemini để AI kiểm tra độ phủ.");
    const c = await aiCoverage(db, ai, story.id, user.id);
    const gaps = c.items.filter((i) => i.status !== "covered").length;
    return gaps ? `AI tìm thấy ${gaps} chỗ chưa phủ đủ và gợi ý ${c.suggestions.length} test case.` : "AI đánh giá các yêu cầu đã được phủ đủ.";
  });
}

export async function addCoverageSuggestionsAction(fd: FormData) {
  const key = String(fd.get("key"));
  await runAndReturn(`/stories/${key}#testcases`, async () => {
    const { db, user, story } = await storyActorById(String(fd.get("storyId")), "tc.edit");
    const n = await addCoverageSuggestions(db, story.id, user.id);
    return n ? `Đã thêm ${n} test case gợi ý dạng nháp. Duyệt ở phần Test case.` : "Không còn gợi ý nào.";
  });
}

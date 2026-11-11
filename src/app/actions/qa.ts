"use server";

import { cookies } from "next/headers";
import { eq } from "drizzle-orm";
import { projects } from "@/lib/db/schema";
import { runAndReturn } from "@/lib/flash";
import { storyActorById, storyIdOfBug, storyIdOfBuild, storyIdOfExecution } from "@/lib/actor";
import { currentUser } from "@/lib/session";
import { getDb } from "@/lib/db";
import { roleIn } from "@/lib/services/projects";
import { loadAi, loadJira, loadTestLink } from "@/lib/services/connections";
import { createNextBuild, markReviewed, pushBuildToTestlink, refreshBlockers, setExecution, ENV_LABEL } from "@/lib/services/execution";
import {
  addEvidence,
  addManualCommit,
  aiBugDraft,
  bugTemplateFromExecution,
  createDraftBug,
  deleteDraftBug,
  parseBugForm,
  publishBug,
  reopenBug,
  updateDraftBug,
  verifyAndClose,
} from "@/lib/services/bugs";
import { generateReport, postReport, saveReportText } from "@/lib/services/reports";
import { advanceStory, evaluateGate, saveGateRules } from "@/lib/services/gates";
import { createMcpToken, revokeMcpToken } from "@/lib/services/mcpTokens";
import type { Env, ExecStatus } from "@/lib/db/schema";

const ENVS: Env[] = ["dev", "stg", "prod"];
const files = (fd: FormData, name = "files") => fd.getAll(name).filter((f): f is File => typeof f !== "string" && f.size > 0);
const runPath = (key: string, build?: string, hash = "") => `/stories/${key}/run${build ? `?build=${build}` : ""}${hash}`;

// ---------- execution ----------

export async function createBuildAction(fd: FormData) {
  const key = String(fd.get("key"));
  let buildId = "";
  await runAndReturn(
    () => runPath(key, buildId || undefined),
    async () => {
      const env = String(fd.get("env")) as Env;
      if (!ENVS.includes(env)) throw new Error("Môi trường không hợp lệ.");
      const { db, user, story } = await storyActorById(String(fd.get("storyId")), "tc.edit");
      const b = await createNextBuild(db, story.id, env, user.id);
      buildId = b.id;
      return `Đã tạo build ${b.name}.`;
    },
  );
}

export async function setResultAction(fd: FormData) {
  const key = String(fd.get("key"));
  const build = String(fd.get("buildId"));
  const execId = String(fd.get("executionId"));
  await runAndReturn(runPath(key, build, `#e-${execId}`), async () => {
    const { db, user } = await storyActorById(await storyIdOfExecution(execId), "tc.edit");
    const status = String(fd.get("status")) as ExecStatus;
    if (!["passed", "failed", "blocked", "not_run"].includes(status)) throw new Error("Kết quả không hợp lệ.");
    await setExecution(db, user.id, execId, { status, linkedIssueKey: fd.has("linkedIssueKey") ? String(fd.get("linkedIssueKey")) : undefined, notes: fd.has("notes") ? String(fd.get("notes")) : undefined });
    const ev = files(fd);
    if (ev.length) await addEvidence(db, user.id, "execution", execId, ev);
    return undefined;
  });
}

export async function reviewAgentResultsAction(fd: FormData) {
  const back = String(fd.get("back") || "/agent");
  await runAndReturn(back, async () => {
    const ids = fd.getAll("executionId").map(String);
    if (!ids.length) throw new Error("Chưa chọn kết quả nào.");
    const { db, user } = await storyActorById(await storyIdOfExecution(ids[0]), "tc.approve");
    for (const id of ids) await storyActorById(await storyIdOfExecution(id), "tc.approve");
    const n = await markReviewed(db, user.id, ids);
    return `Đã duyệt ${n} kết quả do agent ghi.`;
  });
}

export async function pushResultsAction(fd: FormData) {
  const key = String(fd.get("key"));
  const build = String(fd.get("buildId"));
  await runAndReturn(runPath(key, build), async () => {
    const { db, user } = await storyActorById(await storyIdOfBuild(build), "testlink.push");
    const tl = await loadTestLink(db);
    if (!tl) throw new Error("Chưa kết nối TestLink. Admin vào Quản trị → Kết nối.");
    const n = await pushBuildToTestlink(db, tl, build, user.id);
    return n ? `Đã gửi ${n} kết quả lên TestLink.` : "Không có kết quả mới cần gửi.";
  });
}

export async function refreshBlockersAction(fd: FormData) {
  const key = String(fd.get("key"));
  const build = String(fd.get("buildId") || "");
  await runAndReturn(runPath(key, build || undefined), async () => {
    const { db, story } = await storyActorById(String(fd.get("storyId")), "story.view");
    const jira = await loadJira(db);
    if (!jira) throw new Error("Chưa kết nối Jira.");
    const [p] = await db.select().from(projects).where(eq(projects.id, story.projectId));
    const n = await refreshBlockers(db, jira, story.id, p.bugStatusMap.closed);
    return n ? `${n} ticket chặn đã xong, các TC đó cần retest.` : "Chưa có ticket chặn nào xong.";
  });
}

// ---------- bugs ----------

const bugsPath = (key: string, q = "") => `/stories/${key}/bugs${q}`;

export async function newBugFromExecutionAction(fd: FormData) {
  const key = String(fd.get("key"));
  const execId = String(fd.get("executionId"));
  let target = bugsPath(key);
  await runAndReturn(() => target, async () => {
    const storyId = await storyIdOfExecution(execId);
    const { db, user } = await storyActorById(storyId, "tc.edit");
    const useAi = fd.get("ai") === "1";
    let fields;
    if (useAi) {
      const ai = await loadAi(db);
      if (!ai) throw new Error("Chưa kết nối Gemini. Bỏ “AI viết” hoặc nhờ Admin kết nối.");
      fields = await aiBugDraft(db, ai, execId);
    } else fields = await bugTemplateFromExecution(db, execId);
    const id = await createDraftBug(db, user.id, { storyId, executionId: execId, fields, source: useAi ? "ai" : "manual" });
    target = bugsPath(key, `?edit=${id}`);
    return useAi ? "AI đã viết nháp bug. Kiểm tra, đính kèm evidence rồi bấm Tạo." : "Đã tạo nháp bug từ test case.";
  });
}

export async function newBlankBugAction(fd: FormData) {
  const key = String(fd.get("key"));
  let target = bugsPath(key);
  await runAndReturn(() => target, async () => {
    const { db, user, story } = await storyActorById(String(fd.get("storyId")), "tc.edit");
    const id = await createDraftBug(db, user.id, { storyId: story.id, fields: { title: "Bug mới", steps: "", actual: "", expected: "", severity: "major", env: story.currentEnv }, source: "manual" });
    target = bugsPath(key, `?edit=${id}`);
    return "Đã tạo nháp bug. Điền nội dung bên dưới.";
  });
}

export async function saveBugDraftAction(fd: FormData) {
  const key = String(fd.get("key"));
  const bugId = String(fd.get("bugId"));
  const publish = fd.get("publish") === "1";
  await runAndReturn(bugsPath(key, publish ? "" : `?edit=${bugId}`), async () => {
    const { db, user } = await storyActorById(await storyIdOfBug(bugId), "tc.edit");
    await updateDraftBug(db, user.id, bugId, parseBugForm(fd));
    const ev = files(fd);
    if (ev.length) await addEvidence(db, user.id, "bug", bugId, ev);
    if (!publish) return "Đã lưu nháp.";
    const code = await publishBug(db, await loadJira(db), bugId, user.id);
    return code.startsWith("LOCAL-") ? `Đã tạo bug ${code} (chưa có trên Jira).` : `Đã tạo sub-bug ${code} trên Jira.`;
  });
}

export async function deleteBugDraftAction(fd: FormData) {
  const key = String(fd.get("key"));
  await runAndReturn(bugsPath(key), async () => {
    const bugId = String(fd.get("bugId"));
    const { db, user } = await storyActorById(await storyIdOfBug(bugId), "tc.edit");
    await deleteDraftBug(db, user.id, bugId);
    return "Đã bỏ nháp bug.";
  });
}

export async function uploadFixEvidenceAction(fd: FormData) {
  const key = String(fd.get("key"));
  const bugId = String(fd.get("bugId"));
  await runAndReturn(bugsPath(key, `#b-${bugId}`), async () => {
    const { db, user } = await storyActorById(await storyIdOfBug(bugId), "tc.edit");
    const ev = files(fd);
    if (!ev.length) throw new Error("Chọn ít nhất một file.");
    await addEvidence(db, user.id, "bug_fix", bugId, ev);
    return "Đã đính kèm evidence đã fix.";
  });
}

export async function verifyBugAction(fd: FormData) {
  const key = String(fd.get("key"));
  const bugId = String(fd.get("bugId"));
  await runAndReturn(bugsPath(key, `#b-${bugId}`), async () => {
    const { db, user } = await storyActorById(await storyIdOfBug(bugId), "tc.edit");
    const ev = files(fd);
    if (ev.length) await addEvidence(db, user.id, "bug_fix", bugId, ev);
    await verifyAndClose(db, await loadJira(db), bugId, user.id, String(fd.get("note") ?? ""));
    return "Đã verify và đóng bug. Nhớ retest TC liên quan ở round sau.";
  });
}

export async function reopenBugAction(fd: FormData) {
  const key = String(fd.get("key"));
  const bugId = String(fd.get("bugId"));
  await runAndReturn(bugsPath(key, `#b-${bugId}`), async () => {
    const { db, user } = await storyActorById(await storyIdOfBug(bugId), "tc.edit");
    await reopenBug(db, await loadJira(db), bugId, user.id, String(fd.get("note") ?? ""));
    return "Đã mở lại bug.";
  });
}

export async function addCommitAction(fd: FormData) {
  const key = String(fd.get("key"));
  const bugId = String(fd.get("bugId"));
  await runAndReturn(bugsPath(key, `#b-${bugId}`), async () => {
    const { db, user } = await storyActorById(await storyIdOfBug(bugId), "tc.edit");
    await addManualCommit(db, user.id, bugId, String(fd.get("commit") ?? ""));
    return "Đã gắn commit.";
  });
}

// ---------- reports ----------

const reportsPath = (key: string, build: string) => `/stories/${key}/reports?build=${build}`;

export async function generateReportAction(fd: FormData) {
  const key = String(fd.get("key"));
  const build = String(fd.get("buildId"));
  await runAndReturn(reportsPath(key, build), async () => {
    const { db, user } = await storyActorById(await storyIdOfBuild(build), "tc.edit");
    const useAi = fd.get("ai") === "1";
    const ai = useAi ? await loadAi(db) : null;
    if (useAi && !ai) throw new Error("Chưa kết nối Gemini. Bấm “Tính lại số liệu” để tạo report không có AI.");
    await generateReport(db, ai, build, user.id);
    return useAi ? "Đã tạo report kèm nhận xét AI. Sửa lại trước khi đăng." : "Đã tính lại số liệu.";
  });
}

export async function saveReportAction(fd: FormData) {
  const key = String(fd.get("key"));
  const build = String(fd.get("buildId"));
  await runAndReturn(reportsPath(key, build), async () => {
    const { db, user } = await storyActorById(await storyIdOfBuild(build), "tc.edit");
    await saveReportText(db, user.id, build, String(fd.get("finalText") ?? ""));
    return "Đã lưu nhận xét.";
  });
}

export async function postReportAction(fd: FormData) {
  const key = String(fd.get("key"));
  const build = String(fd.get("buildId"));
  await runAndReturn(reportsPath(key, build), async () => {
    const { db, user } = await storyActorById(await storyIdOfBuild(build), "tc.edit");
    if (fd.has("finalText")) await saveReportText(db, user.id, build, String(fd.get("finalText") ?? ""));
    const where = await postReport(db, await loadJira(db), build, user.id);
    return where.length ? `Đã đăng report lên ${where.join(" và ")}.` : "Đã đánh dấu report là đã đăng (chưa kết nối Jira/Slack nên không gửi đi đâu).";
  });
}

// ---------- gates ----------

export async function advanceAction(fd: FormData) {
  const key = String(fd.get("key"));
  await runAndReturn(`/stories/${key}/env`, async () => {
    const { db, user, story, role } = await storyActorById(String(fd.get("storyId")), "tc.edit");
    const reason = String(fd.get("reason") ?? "").trim();
    const g = await evaluateGate(db, story.id);
    if (!g.pass) {
      if (role !== "lead") throw new Error("Chưa qua gate. Chỉ QC Lead được vượt gate (kèm lý do).");
      if (!reason) throw new Error("Vượt gate cần ghi lý do.");
    }
    const next = await advanceStory(db, await loadJira(db), story.id, user.id, g.pass ? null : reason);
    return next === "done" ? "Story đã hoàn tất." : `Đã chuyển sang ${ENV_LABEL[next]} và báo dev deploy. Build mới đã được tạo.`;
  });
}

export async function saveGatesAction(fd: FormData) {
  await runAndReturn("/gates", async () => {
    const user = await currentUser();
    if (!user) throw new Error("Phiên đăng nhập đã hết.");
    const db = await getDb();
    const projectId = String(fd.get("projectId"));
    const role = await roleIn(db, user.id, projectId);
    if (!user.isAdmin && role !== "lead") throw new Error("Chỉ Admin hoặc QC Lead được sửa quy tắc gate.");
    await saveGateRules(db, user.id, projectId, fd);
    return "Đã lưu quy tắc gate.";
  });
}

// ---------- MCP tokens ----------

export async function createTokenAction(fd: FormData) {
  await runAndReturn("/profile#mcp", async () => {
    const user = await currentUser();
    if (!user) throw new Error("Phiên đăng nhập đã hết.");
    const scope = fd.get("scope") === "write" ? "write" : "read";
    const token = await createMcpToken(await getDb(), user.id, String(fd.get("name") ?? ""), scope, Number(fd.get("days") ?? 90));
    // Shown once on the next page load, never put in the URL.
    (await cookies()).set("qfh_new_token", token, { httpOnly: true, sameSite: "strict", path: "/profile", maxAge: 120 });
    return "Đã tạo token. Copy ngay, token chỉ hiện một lần.";
  });
}

export async function revokeTokenAction(fd: FormData) {
  await runAndReturn("/profile#mcp", async () => {
    const user = await currentUser();
    if (!user) throw new Error("Phiên đăng nhập đã hết.");
    await revokeMcpToken(await getDb(), user.id, String(fd.get("id")));
    return "Đã thu hồi token.";
  });
}

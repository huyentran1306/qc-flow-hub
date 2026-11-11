import { and, desc, eq, inArray, notInArray } from "drizzle-orm";
import { Type } from "@google/genai";
import type { DB } from "../db";
import { bugs, builds, evidence, executions, projects, stories, testCases, type BugStatus, type BugStatusMap, type Env, type FixCommit, type Severity } from "../db/schema";
import { audit } from "../audit";
import type { AiClient } from "../integrations/gemini";
import type { JiraClient } from "../integrations/jira";
import { readUpload, safeMime, saveUpload } from "../storage";
import { notify } from "./notify";
import { ENV_LABEL } from "./execution";
import { tcCode } from "../format";

type Bug = typeof bugs.$inferSelect;

export const SEVERITY_LABEL: Record<Severity, string> = { critical: "Critical", major: "Major", minor: "Minor" };
export const BUG_STATUS_LABEL: Record<BugStatus, string> = { draft: "Nháp", open: "Open", in_progress: "In progress", resolved: "Resolved", closed: "Closed" };

/** Key shown to people and stored on executions: the Jira key, or LOCAL-xxxxxx before/without Jira. */
export function bugCode(b: Pick<Bug, "id" | "jiraKey">): string {
  return b.jiraKey ?? `LOCAL-${b.id.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
}

export function mapJiraStatus(name: string, map: BugStatusMap): BugStatus {
  const n = name.toLowerCase();
  if (map.closed.some((x) => x.toLowerCase() === n)) return "closed";
  if (map.resolved.some((x) => x.toLowerCase() === n)) return "resolved";
  if (/progress|doing|review/.test(n)) return "in_progress";
  return "open";
}

export type BugFields = { title: string; steps: string; actual: string; expected: string; severity: Severity; env: Env };

export function parseBugForm(fd: FormData): BugFields {
  const title = String(fd.get("title") ?? "").trim();
  if (!title) throw new Error("Bug cần có tiêu đề.");
  const severity = String(fd.get("severity")) as Severity;
  const env = String(fd.get("env")) as Env;
  return {
    title,
    steps: String(fd.get("steps") ?? "").trim(),
    actual: String(fd.get("actual") ?? "").trim(),
    expected: String(fd.get("expected") ?? "").trim(),
    severity: ["critical", "major", "minor"].includes(severity) ? severity : "major",
    env: ["dev", "stg", "prod"].includes(env) ? env : "dev",
  };
}

async function execContext(db: DB, executionId: string) {
  const [row] = await db
    .select({ e: executions, b: builds, tc: testCases, s: stories })
    .from(executions)
    .innerJoin(builds, eq(builds.id, executions.buildId))
    .innerJoin(testCases, eq(testCases.id, executions.testCaseId))
    .innerJoin(stories, eq(stories.id, builds.storyId))
    .where(eq(executions.id, executionId));
  if (!row) throw new Error("Không tìm thấy lần thực thi.");
  return row;
}

/** Prefilled bug from a failed execution, without AI. */
export async function bugTemplateFromExecution(db: DB, executionId: string): Promise<BugFields> {
  const { e, b, tc, s } = await execContext(db, executionId);
  return {
    title: `[${s.summary.match(/^\[[^\]]+\]/)?.[0]?.slice(1, -1) ?? s.jiraKey}][${tc.usCode}] ${tc.title}`,
    steps: [tc.preconditions && `Điều kiện: ${tc.preconditions}`, ...tc.steps.map((st, i) => `${i + 1}. ${st.action}`)].filter(Boolean).join("\n"),
    actual: e.notes,
    expected: tc.steps.map((st) => st.expected).filter(Boolean).at(-1) ?? "",
    severity: tc.priority === "high" ? "major" : "minor",
    env: b.env,
  };
}

const BUG_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    title: { type: Type.STRING },
    steps: { type: Type.STRING },
    actual: { type: Type.STRING },
    expected: { type: Type.STRING },
    severity: { type: Type.STRING, enum: ["critical", "major", "minor"] },
  },
  required: ["title", "steps", "actual", "expected", "severity"],
};

export async function aiBugDraft(db: DB, ai: AiClient, executionId: string): Promise<BugFields> {
  const { e, b, tc, s } = await execContext(db, executionId);
  const r = await ai.generateJson<Omit<BugFields, "env">>({
    system: `Bạn là QC senior. Viết bug report tiếng Việt, ngắn gọn, đủ để dev tái hiện.
- title: dạng [Chức năng][US] mô tả lỗi, không quá 120 ký tự.
- steps: các bước đánh số, mỗi bước một dòng.
- actual: điều thực tế xảy ra (dựa vào ghi chú của QC, không bịa thêm).
- expected: kết quả đúng theo test case.
- severity: critical nếu chặn chức năng chính hoặc mất dữ liệu, major nếu sai nghiệp vụ, minor nếu lỗi hiển thị.`,
    prompt: `Story: ${s.jiraKey} ${s.summary}
Môi trường: ${ENV_LABEL[b.env]} (build ${b.name})
Test case ${tcCode(tc.seq)} [${tc.usCode}]: ${tc.title}
Điều kiện: ${tc.preconditions || "(không)"}
Các bước và kết quả mong đợi:
${tc.steps.map((st, i) => `${i + 1}. ${st.action} => ${st.expected}`).join("\n")}
Ghi chú của QC khi test fail: ${e.notes || "(không có)"}`,
    schema: BUG_SCHEMA,
  });
  return { ...r, severity: (["critical", "major", "minor"].includes(r.severity) ? r.severity : "major") as Severity, env: b.env };
}

export async function createDraftBug(
  db: DB,
  userId: string | null,
  input: { storyId: string; executionId?: string | null; fields: BugFields; source: "manual" | "ai" | "agent" },
): Promise<string> {
  const [b] = await db
    .insert(bugs)
    .values({ storyId: input.storyId, executionId: input.executionId ?? null, ...input.fields, status: "draft", source: input.source, createdBy: userId })
    .returning({ id: bugs.id });
  const [s] = await db.select().from(stories).where(eq(stories.id, input.storyId));
  await audit(db, { userId, action: input.source === "agent" ? "Agent tạo nháp bug" : "Tạo nháp bug", target: s.jiraKey, detail: { title: input.fields.title }, source: input.source === "agent" ? "mcp" : "ui" });
  return b.id;
}

export async function updateDraftBug(db: DB, userId: string, bugId: string, fields: BugFields) {
  const [b] = await db.select().from(bugs).where(eq(bugs.id, bugId));
  if (!b) throw new Error("Không tìm thấy bug.");
  if (b.status !== "draft") throw new Error("Bug đã gửi đi, hãy sửa trên Jira.");
  await db.update(bugs).set(fields).where(eq(bugs.id, bugId));
}

export async function addEvidence(db: DB, userId: string | null, ownerType: "bug" | "bug_fix" | "execution", ownerId: string, files: File[]) {
  const saved: string[] = [];
  for (const f of files) {
    if (!f || typeof f === "string" || f.size === 0) continue;
    const data = Buffer.from(await f.arrayBuffer());
    const storedName = saveUpload(f.name, data);
    const [ev] = await db
      .insert(evidence)
      .values({ ownerType, ownerId, fileName: f.name, mime: safeMime(f.type), size: data.length, storedName, uploadedBy: userId })
      .returning({ id: evidence.id });
    saved.push(ev.id);
  }
  return saved;
}

export async function evidenceOf(db: DB, ownerType: "bug" | "bug_fix" | "execution", ownerIds: string[]) {
  if (!ownerIds.length) return [];
  return db.select().from(evidence).where(and(eq(evidence.ownerType, ownerType), inArray(evidence.ownerId, ownerIds)));
}

function wikiDescription(b: Bug, tcLine: string | null, buildName: string | null) {
  const steps = b.steps
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => `# ${l.replace(/^\d+[.)]\s*/, "")}`)
    .join("\n");
  return [
    `*Môi trường:* ${ENV_LABEL[b.env]}${buildName ? ` (build ${buildName})` : ""}`,
    tcLine ? `*Test case:* ${tcLine}` : null,
    `*Severity:* ${SEVERITY_LABEL[b.severity]}`,
    "",
    "h4. Steps to reproduce",
    steps || "(không có)",
    "",
    "h4. Actual",
    b.actual || "(không có)",
    "",
    "h4. Expected",
    b.expected || "(không có)",
    "",
    "_Tạo từ QA Flow Hub_",
  ]
    .filter((x) => x !== null)
    .join("\n");
}

/** Sends a draft bug to Jira (as a sub-task of the story) or keeps it local, then links the failed execution. */
export async function publishBug(db: DB, jira: JiraClient | null, bugId: string, userId: string): Promise<string> {
  const [b] = await db.select().from(bugs).where(eq(bugs.id, bugId));
  if (!b) throw new Error("Không tìm thấy bug.");
  if (b.status !== "draft") return bugCode(b);
  const [s] = await db.select().from(stories).where(eq(stories.id, b.storyId));
  const [p] = await db.select().from(projects).where(eq(projects.id, s.projectId));
  let tcLine: string | null = null;
  let buildName: string | null = null;
  if (b.executionId) {
    const ctx = await execContext(db, b.executionId).catch(() => null);
    if (ctx) {
      tcLine = `${tcCode(ctx.tc.seq)} ${ctx.tc.title}`;
      buildName = ctx.b.name;
    }
  }
  let jiraKey: string | null = null;
  if (jira && !p.isDemo) {
    const extra: Record<string, unknown> = {};
    if (p.mapping.severityField) extra[p.mapping.severityField] = { value: SEVERITY_LABEL[b.severity] };
    if (p.mapping.environmentField) extra[p.mapping.environmentField] = { value: ENV_LABEL[b.env] };
    jiraKey = await jira.createIssue({
      projectKey: p.key,
      issueType: p.mapping.subBugIssueType,
      parentKey: s.jiraKey,
      summary: b.title,
      description: wikiDescription(b, tcLine, buildName),
      extraFields: extra,
    });
    for (const ev of await evidenceOf(db, "bug", [b.id])) {
      await jira.attachFile(jiraKey, ev.fileName, readUpload(ev.storedName), ev.mime).catch((e) => console.error("[attach]", e));
    }
  }
  await db.update(bugs).set({ status: "open", jiraKey, jiraStatus: jiraKey ? "Open" : null }).where(eq(bugs.id, bugId));
  const code = bugCode({ id: b.id, jiraKey });
  if (b.executionId) await db.update(executions).set({ status: "failed", linkedIssueKey: code }).where(eq(executions.id, b.executionId));
  await audit(db, { userId, action: jiraKey ? "Tạo sub-bug trên Jira" : "Tạo bug (chưa có trên Jira)", target: code, detail: { title: b.title } });
  return code;
}

export async function deleteDraftBug(db: DB, userId: string, bugId: string) {
  const [b] = await db.select().from(bugs).where(eq(bugs.id, bugId));
  if (!b) return;
  if (b.status !== "draft") throw new Error("Chỉ xoá được bug nháp.");
  await db.delete(bugs).where(eq(bugs.id, bugId));
  await audit(db, { userId, action: "Bỏ nháp bug", detail: { title: b.title } });
}

/** Applies a Jira status to the local bug; notifies QC when it becomes Resolved. */
export async function applyJiraStatus(db: DB, jiraKey: string, statusName: string) {
  const [b] = await db.select().from(bugs).where(eq(bugs.jiraKey, jiraKey));
  if (!b || b.status === "draft") return false;
  const [s] = await db.select().from(stories).where(eq(stories.id, b.storyId));
  const [p] = await db.select().from(projects).where(eq(projects.id, s.projectId));
  const next = mapJiraStatus(statusName, p.bugStatusMap);
  if (b.jiraStatus === statusName && b.status === next) return false;
  await db.update(bugs).set({ jiraStatus: statusName, status: next, ...(next === "closed" && !b.closedAt ? { closedAt: new Date() } : {}) }).where(eq(bugs.id, b.id));
  if (next === "resolved" && b.status !== "resolved") {
    await notify(db, `🔧 ${jiraKey} đã được dev chuyển ${statusName}, cần QC verify: ${b.title}`);
    await audit(db, { userId: null, action: "Bug chờ QC verify", target: jiraKey, source: "system" });
  }
  return true;
}

export async function addFixCommit(db: DB, key: string, commit: FixCommit): Promise<boolean> {
  const [b] = await db.select().from(bugs).where(eq(bugs.jiraKey, key));
  if (!b) return false;
  if (b.fixCommits.some((c) => c.sha === commit.sha)) return false;
  await db.update(bugs).set({ fixCommits: [...b.fixCommits, commit] }).where(eq(bugs.id, b.id));
  await audit(db, { userId: null, action: "Gắn commit fix", target: key, detail: { sha: commit.sha.slice(0, 8), message: commit.message }, source: "webhook" });
  return true;
}

export async function addManualCommit(db: DB, userId: string, bugId: string, text: string) {
  const t = text.trim();
  if (!t) throw new Error("Nhập mã commit hoặc link commit.");
  const [b] = await db.select().from(bugs).where(eq(bugs.id, bugId));
  const sha = t.match(/[0-9a-f]{7,40}/i)?.[0] ?? t.slice(0, 12);
  const commit: FixCommit = { sha, message: "Nhập tay", url: /^https?:\/\//.test(t) ? t : undefined };
  await db.update(bugs).set({ fixCommits: [...b.fixCommits, commit] }).where(eq(bugs.id, bugId));
  await audit(db, { userId, action: "Gắn commit fix (nhập tay)", target: bugCode(b) });
}

/** QC verified the fix: needs fix evidence, closes on Jira when possible. */
export async function verifyAndClose(db: DB, jira: JiraClient | null, bugId: string, userId: string, note: string) {
  const [b] = await db.select().from(bugs).where(eq(bugs.id, bugId));
  if (!b) throw new Error("Không tìm thấy bug.");
  if (b.status === "draft" || b.status === "closed") throw new Error("Bug này không ở trạng thái chờ verify.");
  const fixEv = await evidenceOf(db, "bug_fix", [b.id]);
  if (!fixEv.length) throw new Error("Cần đính kèm ít nhất một ảnh/video chứng minh đã fix trước khi đóng bug.");
  const [s] = await db.select().from(stories).where(eq(stories.id, b.storyId));
  const [p] = await db.select().from(projects).where(eq(projects.id, s.projectId));
  let jiraStatus = b.jiraStatus;
  if (jira && b.jiraKey && !p.isDemo) {
    for (const ev of fixEv) await jira.attachFile(b.jiraKey, `fixed-${ev.fileName}`, readUpload(ev.storedName), ev.mime).catch((e) => console.error("[attach]", e));
    await jira.addComment(b.jiraKey, `QC đã verify, bug đã được fix.${note ? `\n${note}` : ""}`);
    const moved = await jira.transitionTo(b.jiraKey, p.bugStatusMap.closed);
    if (!moved) throw new Error(`Đã comment và đính kèm, nhưng không tìm thấy transition sang ${p.bugStatusMap.closed.join("/")} trên Jira. Kiểm tra ánh xạ trạng thái ở Quản trị → Dự án.`);
    jiraStatus = moved;
  }
  await db.update(bugs).set({ status: "closed", jiraStatus, closedBy: userId, closedAt: new Date() }).where(eq(bugs.id, bugId));
  await audit(db, { userId, action: "Verify và đóng bug", target: bugCode(b) });
}

export async function reopenBug(db: DB, jira: JiraClient | null, bugId: string, userId: string, note: string) {
  const [b] = await db.select().from(bugs).where(eq(bugs.id, bugId));
  if (!b || b.status === "draft") throw new Error("Không mở lại được bug này.");
  if (!note.trim()) throw new Error("Ghi lý do mở lại để dev biết còn lỗi gì.");
  const [s] = await db.select().from(stories).where(eq(stories.id, b.storyId));
  const [p] = await db.select().from(projects).where(eq(projects.id, s.projectId));
  let jiraStatus = b.jiraStatus;
  if (jira && b.jiraKey && !p.isDemo) {
    await jira.addComment(b.jiraKey, `QC mở lại bug: ${note}`);
    jiraStatus = (await jira.transitionTo(b.jiraKey, p.bugStatusMap.reopened)) ?? jiraStatus;
  }
  await db.update(bugs).set({ status: "open", jiraStatus, closedAt: null, closedBy: null }).where(eq(bugs.id, bugId));
  await audit(db, { userId, action: "Mở lại bug", target: bugCode(b), detail: { message: note } });
}

export async function listBugs(db: DB, where: { projectId?: string; storyId?: string; statuses?: BugStatus[]; excludeDraft?: boolean }) {
  const conds = [];
  if (where.storyId) conds.push(eq(bugs.storyId, where.storyId));
  if (where.projectId) conds.push(eq(stories.projectId, where.projectId));
  if (where.statuses?.length) conds.push(inArray(bugs.status, where.statuses));
  if (where.excludeDraft) conds.push(notInArray(bugs.status, ["draft"]));
  return db
    .select({ bug: bugs, storyKey: stories.jiraKey, storySummary: stories.summary })
    .from(bugs)
    .innerJoin(stories, eq(stories.id, bugs.storyId))
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(bugs.createdAt));
}

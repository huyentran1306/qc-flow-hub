import { and, eq, inArray, isNull } from "drizzle-orm";
import { insertWithNextSeq } from "../seq";
import type { DB } from "../db";
import { projects, stories, testCases, type TcPriority, type TcStep, type TcType } from "../db/schema";
import { audit } from "../audit";
import type { TestLinkClient } from "../integrations/testlink";
import { testcaseName } from "../testlinkXml";
import { tcCode } from "../format";

export async function tcWithStory(db: DB, tcId: string) {
  const [tc] = await db.select().from(testCases).where(eq(testCases.id, tcId));
  if (!tc) throw new Error("Không tìm thấy test case.");
  const [s] = await db.select().from(stories).where(eq(stories.id, tc.storyId));
  return { tc, s };
}

/** Parses "action => expected" lines from the manual editor. */
export function parseSteps(text: string): TcStep[] {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const [action, ...rest] = l.split("=>");
      return { action: action.trim(), expected: rest.join("=>").trim() };
    });
}

export function stepsToText(steps: TcStep[]): string {
  return steps.map((s) => `${s.action} => ${s.expected}`).join("\n");
}

export type TcInput = { usCode: string; title: string; type: TcType; kind?: "ui" | "api"; priority: TcPriority; preconditions: string; steps: TcStep[] };

export function parseTcForm(fd: FormData): TcInput {
  const title = String(fd.get("title") ?? "").trim();
  if (!title) throw new Error("Cần nhập tiêu đề test case.");
  const steps = parseSteps(String(fd.get("steps") ?? ""));
  if (!steps.length) throw new Error("Cần ít nhất một bước, dạng: hành động => kết quả mong đợi.");
  const type = String(fd.get("type")) as TcType;
  const priority = String(fd.get("priority")) as TcPriority;
  return {
    usCode: String(fd.get("usCode") ?? "US1").trim() || "US1",
    title,
    type: ["happy", "negative", "edge"].includes(type) ? type : "happy",
    kind: fd.get("kind") === "api" ? "api" : "ui",
    priority: ["high", "medium", "low"].includes(priority) ? priority : "medium",
    preconditions: String(fd.get("preconditions") ?? "").trim(),
    steps,
  };
}

export async function addManualTc(db: DB, userId: string, storyId: string, input: TcInput) {
  const seq = await insertWithNextSeq(db, storyId, async (seq) => {
    await db.insert(testCases).values({ ...input, storyId, seq, source: "manual", status: "approved", createdBy: userId, approvedBy: userId });
    return seq;
  });
  const [s] = await db.select().from(stories).where(eq(stories.id, storyId));
  if (s.qaStage === "analyzing" || s.qaStage === "qna") await db.update(stories).set({ qaStage: "tc_ready" }).where(eq(stories.id, storyId));
  await audit(db, { userId, action: "Thêm test case", target: `${s.jiraKey} ${tcCode(seq)}` });
}

export async function updateTc(db: DB, userId: string, tcId: string, input: TcInput) {
  const { tc, s } = await tcWithStory(db, tcId);
  await db.update(testCases).set(input).where(eq(testCases.id, tcId));
  await audit(db, { userId, action: "Sửa test case", target: `${s.jiraKey} ${tcCode(tc.seq)}` });
}

export async function approveTcs(db: DB, userId: string, storyId: string, ids: string[] | "all-drafts") {
  const where =
    ids === "all-drafts"
      ? and(eq(testCases.storyId, storyId), eq(testCases.status, "draft"))
      : and(eq(testCases.storyId, storyId), inArray(testCases.id, ids));
  const done = await db.update(testCases).set({ status: "approved", approvedBy: userId }).where(where).returning({ seq: testCases.seq });
  const [s] = await db.select().from(stories).where(eq(stories.id, storyId));
  if (done.length) {
    if (s.qaStage === "analyzing" || s.qaStage === "qna") await db.update(stories).set({ qaStage: "tc_ready" }).where(eq(stories.id, storyId));
    await audit(db, { userId, action: `Duyệt ${done.length} test case`, target: s.jiraKey });
  }
  return done.length;
}

export async function deleteTc(db: DB, userId: string, tcId: string) {
  const { tc, s } = await tcWithStory(db, tcId);
  if (tc.testlinkId) throw new Error("Test case đã có trên TestLink, hãy xoá trên TestLink trước.");
  await db.delete(testCases).where(eq(testCases.id, tcId));
  await audit(db, { userId, action: tc.status === "draft" ? "Bỏ test case nháp" : "Xoá test case", target: `${s.jiraKey} ${tcCode(tc.seq)}` });
}

/** Creates (or reuses) a suite named after the story and pushes approved TCs not yet on TestLink. */
export async function pushToTestlink(db: DB, tl: TestLinkClient, storyId: string, userId: string) {
  const [s] = await db.select().from(stories).where(eq(stories.id, storyId));
  const [p] = await db.select().from(projects).where(eq(projects.id, s.projectId));
  if (!p.testlinkProjectName) throw new Error(`Dự án ${p.key} chưa ánh xạ tên project TestLink. Vào Quản trị → Dự án.`);
  const pending = await db
    .select()
    .from(testCases)
    .where(and(eq(testCases.storyId, storyId), eq(testCases.status, "approved"), isNull(testCases.testlinkId)))
    .orderBy(testCases.seq);
  if (!pending.length) return { pushed: 0, failed: [] as string[] };
  const tp = await tl.projectByName(p.testlinkProjectName);
  const suiteId = await tl.ensureSuite(tp.id, `${s.jiraKey} ${s.summary}`, `Đồng bộ từ QA Flow Hub cho ${s.jiraKey}`);
  let pushed = 0;
  const failed: string[] = [];
  for (const tc of pending) {
    try {
      const r = await tl.createTestCase({
        projectId: tp.id,
        suiteId,
        name: testcaseName(tc),
        summary: tc.requirementRef ? `Ref: ${tc.requirementRef}` : "",
        preconditions: tc.preconditions,
        priority: tc.priority,
        steps: tc.steps,
      });
      await db
        .update(testCases)
        .set({ testlinkId: r.id, testlinkExternalId: r.externalId ? `${tp.prefix}-${r.externalId}` : null })
        .where(eq(testCases.id, tc.id));
      pushed++;
    } catch (e) {
      failed.push(`${tcCode(tc.seq)}: ${(e as Error).message}`);
    }
  }
  await audit(db, { userId, action: `Đẩy ${pushed} test case lên TestLink`, target: s.jiraKey, detail: { failed } });
  return { pushed, failed };
}

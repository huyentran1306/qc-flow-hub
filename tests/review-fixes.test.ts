import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { openDb } from "@/lib/db";
import { builds, executions, reports, stories, testCases, users } from "@/lib/db/schema";
import { safeMime } from "@/lib/storage";
import { isQcSubtask } from "@/lib/services/stories";
import { createFirstAdmin, changePassword } from "@/lib/services/users";
import { seedDemo } from "@/lib/services/demo";
import { generateReport, saveReportText } from "@/lib/services/reports";
import { setExecution } from "@/lib/services/execution";
import { addManualTc } from "@/lib/services/testcases";
import { insertWithNextSeq } from "@/lib/seq";
import { runTool } from "@/lib/agent/tools";

process.env.UPLOAD_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "qfh-rv-"));

describe("review fixes", () => {
  it("never marks active content as inline", () => {
    expect(safeMime("image/png")).toBe("image/png");
    expect(safeMime("image/svg+xml")).toBe("application/octet-stream");
    expect(safeMime("text/html")).toBe("application/octet-stream");
    expect(safeMime(undefined)).toBe("application/octet-stream");
  });

  it("escapes the QC subtask marker", () => {
    const st = (summary: string) => ({ key: "X-1", summary, status: "", issueType: "Sub-task", labels: [] });
    const m = (qcSubtaskLabel: string) => ({ storyIssueType: "Story", subBugIssueType: "Sub-bug", qcSubtaskLabel });
    expect(() => isQcSubtask(st("abc"), m("QC+"))).not.toThrow();
    expect(isQcSubtask(st("[QC] viết TC"), m("[QC]"))).toBe(true);
    expect(isQcSubtask(st("QCC viết TC"), m("QC."))).toBe(false);
  });

  it("bumps the session version on password change, keeps edited report text, keeps notes, numbers TCs uniquely", async () => {
    const db = await openDb({ memory: true });
    const u = await createFirstAdmin(db, { email: "a@b.c", name: "A", password: "password123" });
    await changePassword(db, u, "password123", "password456");
    expect((await db.select().from(users).where(eq(users.id, u)))[0].sessionVersion).toBe(1);

    await seedDemo(db, u);
    const [s] = await db.select().from(stories).where(eq(stories.jiraKey, "DEMO-110859"));
    const [b] = await db.select().from(builds).where(eq(builds.storyId, s.id));
    await generateReport(db, null, b.id, u);
    await saveReportText(db, u, b.id, "Nhận xét QC tự viết");
    await generateReport(db, null, b.id, u);
    expect((await db.select().from(reports).where(eq(reports.buildId, b.id)))[0].finalText).toBe("Nhận xét QC tự viết");

    const [e] = await db.select().from(executions).where(eq(executions.buildId, b.id)).limit(1);
    await setExecution(db, u, e.id, { status: "failed", notes: "Ghi chú của QC" });
    const { createMcpToken, authenticateMcp } = await import("@/lib/services/mcpTokens");
    const auth = (await authenticateMcp(db, `Bearer ${await createMcpToken(db, u, "t", "write", 1)}`))!;
    await runTool(db, auth, "record_execution", { executionId: e.id, status: "passed" });
    expect((await db.select().from(executions).where(eq(executions.id, e.id)))[0].notes).toBe("Ghi chú của QC");

    // Two concurrent allocations: the second one retries and gets the next free number.
    const step = [{ action: "a", expected: "b" }];
    await Promise.all([
      addManualTc(db, u, s.id, { usCode: "US1", title: "A", type: "happy", priority: "low", preconditions: "", steps: step }),
      insertWithNextSeq(db, s.id, (seq) => db.insert(testCases).values({ storyId: s.id, seq, usCode: "US1", title: "B", type: "happy", priority: "low", steps: step, source: "manual", status: "approved" })),
    ]);
    const seqs = (await db.select({ seq: testCases.seq }).from(testCases).where(eq(testCases.storyId, s.id))).map((x) => x.seq).sort((a, z) => a - z);
    expect(new Set(seqs).size).toBe(seqs.length);
    expect(seqs.slice(-2)).toEqual([13, 14]);
  });
});

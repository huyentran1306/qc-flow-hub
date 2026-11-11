"use server";

import { headers } from "next/headers";
import { runAndReturn } from "@/lib/flash";
import { storyActorById, storyIdOfBuild } from "@/lib/actor";
import { loadAi } from "@/lib/services/connections";
import { cancelAutoRun, startAutoRun } from "@/lib/autorun/runner";
import { getDb } from "@/lib/db";
import { autoRuns } from "@/lib/db/schema";
import { eq } from "drizzle-orm";

export async function startAutoRunAction(fd: FormData) {
  const key = String(fd.get("key"));
  const buildId = String(fd.get("buildId"));
  await runAndReturn(`/stories/${key}/run?build=${buildId}#autorun`, async () => {
    const { db, user } = await storyActorById(await storyIdOfBuild(buildId), "tc.edit");
    const ai = await loadAi(db);
    if (!ai) throw new Error("Chạy tự động cần Gemini để đọc test case. Admin vào Quản trị → Kết nối để nhập API key.");
    const h = await headers();
    const origin = process.env.APP_URL || `${h.get("x-forwarded-proto") ?? "http"}://${h.get("host")}`;
    await startAutoRun(db, ai, { buildId, userId: user.id, headed: fd.get("headed") === "on", rerun: fd.get("rerun") === "on", origin });
    return "Đã bắt đầu chạy tự động. Trang tự cập nhật tiến độ.";
  });
}

export async function cancelAutoRunAction(fd: FormData) {
  const key = String(fd.get("key"));
  const runId = String(fd.get("runId"));
  const db = await getDb();
  const [run] = await db.select().from(autoRuns).where(eq(autoRuns.id, runId));
  await runAndReturn(`/stories/${key}/run${run ? `?build=${run.buildId}` : ""}#autorun`, async () => {
    if (!run) throw new Error("Không tìm thấy lượt chạy.");
    const { user } = await storyActorById(await storyIdOfBuild(run.buildId), "tc.edit");
    await cancelAutoRun(db, runId, user.id);
    return "Đã yêu cầu huỷ. Test case đang chạy dở sẽ chạy nốt rồi dừng.";
  });
}

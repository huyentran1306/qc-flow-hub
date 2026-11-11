import Link from "next/link";
import { and, desc, eq, inArray, isNotNull, ne } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { bugs, builds, executions, questions, reports, stories, testCases } from "@/lib/db/schema";
import { requireUser, currentProjectContext } from "@/lib/session";
import { can } from "@/lib/rbac";
import { bugCode, SEVERITY_LABEL } from "@/lib/services/bugs";
import { evaluateGate, NEXT_LABEL } from "@/lib/services/gates";
import { ENV_LABEL } from "@/lib/services/execution";
import { Icon, type IconName } from "@/components/Icon";

type Item = { text: React.ReactNode; href: string; action: string };

function Group({ icon, title, items, empty }: { icon: IconName; title: string; items: Item[]; empty: string }) {
  return (
    <div className="card">
      <h2>
        <span className="inline">
          <Icon name={icon} /> {title}
        </span>
        <span className={`pill ${items.length ? "p-acc" : "p-nr"}`}>{items.length}</span>
      </h2>
      {items.length === 0 ? (
        <p className="small muted">{empty}</p>
      ) : (
        <div className="worklist">
          {items.map((it, i) => (
            <div key={i} className="workitem">
              <span>{it.text}</span>
              <Link className="btn sm" href={it.href}>
                {it.action}
              </Link>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default async function MyWorkPage() {
  const user = await requireUser();
  const db = await getDb();
  const ctx = await currentProjectContext(user, db);
  const actor = { isAdmin: user.isAdmin, role: ctx.role };
  if (!ctx.project || !can(actor, "story.view")) return <div className="empty">Chưa chọn dự án.</div>;
  const all = await db.select().from(stories).where(eq(stories.projectId, ctx.project.id));
  const mine = all.filter((s) => s.qcOwnerId === user.id);
  const scope = mine.length ? mine : all;
  const ids = scope.map((s) => s.id);
  const keyOf = new Map(all.map((s) => [s.id, s.jiraKey]));

  // 1. Test cases waiting to be run in each story's latest round of its current environment.
  const toRun: Item[] = [];
  for (const s of scope) {
    if (s.qaStage === "done") continue;
    const [b] = await db.select().from(builds).where(and(eq(builds.storyId, s.id), eq(builds.env, s.currentEnv), eq(builds.kind, "round"))).orderBy(desc(builds.round)).limit(1);
    if (!b) continue;
    const pending = await db.select({ id: executions.id }).from(executions).where(and(eq(executions.buildId, b.id), eq(executions.status, "not_run")));
    if (pending.length)
      toRun.push({ text: <><b>{s.jiraKey}</b> {b.name}: {pending.length} test case chưa chạy</>, href: `/stories/${s.jiraKey}/run?build=${b.id}`, action: "Chấm / chạy tự động" });
  }

  // 2. Bugs waiting for verification.
  const verify: Item[] = ids.length
    ? (await db.select().from(bugs).where(and(inArray(bugs.storyId, ids), eq(bugs.status, "resolved")))).map((b) => ({
        text: <><span className="key">{bugCode(b)}</span> {b.title} <span className="tag">{SEVERITY_LABEL[b.severity]}</span></>,
        href: `/stories/${keyOf.get(b.storyId)}/bugs#b-${b.id}`,
        action: "Verify",
      }))
    : [];

  // 3. Things AI or Antigravity prepared.
  const drafts: Item[] = [];
  if (can(actor, "tc.approve") && ids.length) {
    const tcDrafts = await db.select({ storyId: testCases.storyId }).from(testCases).where(and(inArray(testCases.storyId, ids), eq(testCases.status, "draft")));
    const per = new Map<string, number>();
    for (const t of tcDrafts) per.set(t.storyId, (per.get(t.storyId) ?? 0) + 1);
    for (const [sid, n] of per) drafts.push({ text: <><b>{keyOf.get(sid)}</b>: {n} test case nháp</>, href: `/stories/${keyOf.get(sid)}#testcases`, action: "Duyệt" });
    const bugDrafts = await db.select().from(bugs).where(and(inArray(bugs.storyId, ids), eq(bugs.status, "draft")));
    for (const b of bugDrafts) drafts.push({ text: <>Nháp bug: {b.title}</>, href: `/stories/${keyOf.get(b.storyId)}/bugs?edit=${b.id}#edit`, action: "Hoàn thiện" });
    const agentRows = await db
      .select({ storyId: builds.storyId, buildId: builds.id, name: builds.name })
      .from(executions)
      .innerJoin(builds, eq(builds.id, executions.buildId))
      .where(and(inArray(builds.storyId, ids), eq(executions.byAgent, true), eq(executions.reviewed, false)));
    const perBuild = new Map<string, { storyId: string; name: string; n: number }>();
    for (const r of agentRows) perBuild.set(r.buildId, { storyId: r.storyId, name: r.name, n: (perBuild.get(r.buildId)?.n ?? 0) + 1 });
    for (const [bid, v] of perBuild) drafts.push({ text: <><b>{keyOf.get(v.storyId)}</b> {v.name}: {v.n} kết quả tự động chờ duyệt</>, href: `/stories/${keyOf.get(v.storyId)}/run?build=${bid}`, action: "Xem" });
  }

  // 4. Q&A: replies found on Jira, and my open questions.
  const qna: Item[] = ids.length
    ? (await db.select().from(questions).where(and(inArray(questions.storyId, ids), ne(questions.status, "answered")))).flatMap((q) =>
        q.jiraReply
          ? [{ text: <><b>{keyOf.get(q.storyId)}</b>: có câu trả lời trên Jira cho “{q.content.slice(0, 80)}”</>, href: `/stories/${keyOf.get(q.storyId)}#qna`, action: "Xác nhận" }]
          : q.createdBy === user.id && q.status === "open"
            ? [{ text: <><b>{keyOf.get(q.storyId)}</b>: chờ trả lời “{q.content.slice(0, 80)}”</>, href: `/stories/${keyOf.get(q.storyId)}#qna`, action: "Xem" }]
            : [],
      )
    : [];

  // 5. Reports to post and gates that are open.
  const finish: Item[] = [];
  for (const s of scope) {
    if (s.qaStage !== "testing") continue;
    const [b] = await db.select().from(builds).where(and(eq(builds.storyId, s.id), eq(builds.env, s.currentEnv), eq(builds.kind, "round"))).orderBy(desc(builds.round)).limit(1);
    if (b) {
      const notRun = await db.select({ id: executions.id }).from(executions).where(and(eq(executions.buildId, b.id), eq(executions.status, "not_run")));
      const [rep] = await db.select().from(reports).where(and(eq(reports.buildId, b.id), isNotNull(reports.postedAt)));
      if (!notRun.length && !rep) finish.push({ text: <><b>{s.jiraKey}</b> {b.name}: đã chạy xong, chưa đăng report</>, href: `/stories/${s.jiraKey}/reports?build=${b.id}`, action: "Viết report" });
    }
    const g = await evaluateGate(db, s.id);
    if (g.pass) finish.push({ text: <><b>{s.jiraKey}</b>: đã đạt gate {ENV_LABEL[g.env]} → {NEXT_LABEL[g.env]}</>, href: `/stories/${s.jiraKey}/env`, action: "Chuyển tiếp" });
  }

  const unowned = all.filter((s) => !s.qcOwnerId && s.qaStage !== "done");
  return (
    <>
      <div className="sh">
        <div>
          <h1>Việc của tôi</h1>
          <p>
            {mine.length
              ? `${mine.length} story bạn đang phụ trách ở ${ctx.project.key}.`
              : `Bạn chưa nhận story nào ở ${ctx.project.key}, đang hiện việc của cả dự án. Mở một story và bấm “Nhận story” để lọc theo bạn.`}
          </p>
        </div>
      </div>
      <div className="dash-grid">
        <Group icon="play" title="Cần chạy test" items={toRun} empty="Không còn test case nào chờ chạy." />
        <Group icon="shield" title="Bug chờ verify" items={verify} empty="Không có bug nào chờ verify." />
        <Group icon="sparkles" title="Nháp AI chờ duyệt" items={drafts} empty="Không có gì chờ duyệt." />
        <Group icon="message" title="Q&A" items={qna} empty="Không có câu hỏi nào cần xử lý." />
        <Group icon="rocket" title="Report và chuyển môi trường" items={finish} empty="Chưa có round nào xong hoặc gate nào đạt." />
        <div className="card">
          <h2>
            <span className="inline">
              <Icon name="users" /> Story chưa ai phụ trách
            </span>
            <span className="pill p-nr">{unowned.length}</span>
          </h2>
          {unowned.length === 0 ? (
            <p className="small muted">Story nào cũng đã có người phụ trách.</p>
          ) : (
            <div className="worklist">
              {unowned.slice(0, 10).map((s) => (
                <div key={s.id} className="workitem">
                  <span>
                    <b>{s.jiraKey}</b> {s.summary}
                  </span>
                  <Link className="btn sm" href={`/stories/${s.jiraKey}`}>
                    Mở
                  </Link>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </>
  );
}

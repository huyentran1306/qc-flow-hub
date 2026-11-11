import { and, asc, desc, eq, sql } from "drizzle-orm";
import type { DB } from "../db";
import { projects, questions, sprints, stories, testCases, userStories, type JiraSubtask, type ProjectMapping } from "../db/schema";
import { audit } from "../audit";
import type { JiraClient } from "../integrations/jira";
import { applyJiraStatus } from "./bugs";
import { syncQnaReplies } from "./questions";

export function isQcSubtask(s: JiraSubtask, mapping: ProjectMapping): boolean {
  const marker = mapping.qcSubtaskLabel.toLowerCase();
  const escaped = marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return s.labels.some((l) => l.toLowerCase() === marker) || new RegExp(`(^|[^a-z])${escaped}([^a-z]|$)`, "i").test(s.summary);
}

export function isSubBug(s: JiraSubtask, mapping: ProjectMapping): boolean {
  return s.issueType.toLowerCase() === mapping.subBugIssueType.toLowerCase();
}

/** Pulls the active sprint(s) of the project's board and upserts their stories. */
export async function syncProjectFromJira(db: DB, jira: JiraClient, project: typeof projects.$inferSelect, userId: string) {
  if (!project.jiraBoardId) throw new Error(`Dự án ${project.key} chưa có Jira board id. Vào Quản trị → Dự án để nhập.`);
  const active = await jira.activeSprints(project.jiraBoardId);
  if (!active.length) throw new Error("Board không có sprint nào đang chạy.");
  let created = 0;
  let updated = 0;
  let replies = 0;
  for (const sp of active) {
    const [sprint] = await db
      .insert(sprints)
      .values({
        projectId: project.id,
        jiraId: sp.id,
        name: sp.name,
        state: sp.state,
        startDate: sp.startDate ? new Date(sp.startDate) : null,
        endDate: sp.endDate ? new Date(sp.endDate) : null,
      })
      .onConflictDoUpdate({
        target: [sprints.projectId, sprints.jiraId],
        set: { name: sp.name, state: sp.state, startDate: sp.startDate ? new Date(sp.startDate) : null, endDate: sp.endDate ? new Date(sp.endDate) : null },
      })
      .returning({ id: sprints.id });
    const items = await jira.sprintStories(sp.id, project.mapping.storyIssueType);
    for (const it of items) {
      const [existing] = await db.select({ id: stories.id }).from(stories).where(eq(stories.jiraKey, it.key));
      const data = { summary: it.summary, description: it.description, jiraStatus: it.status, subtasks: it.subtasks, sprintId: sprint.id, syncedAt: new Date() };
      if (existing) {
        await db.update(stories).set(data).where(eq(stories.id, existing.id));
        updated++;
      } else {
        await db.insert(stories).values({ ...data, projectId: project.id, jiraKey: it.key });
        created++;
      }
      // Sub-bugs are sub-tasks of the story: their status comes along with the sync.
      for (const st of it.subtasks) if (isSubBug(st, project.mapping)) await applyJiraStatus(db, st.key, st.status);
      const [row] = await db.select({ id: stories.id }).from(stories).where(eq(stories.jiraKey, it.key));
      replies += await syncQnaReplies(db, jira, row.id).catch(() => 0);
    }
  }
  await audit(db, { userId, action: "Đồng bộ Jira", target: project.key, detail: { sprints: active.map((s) => s.name), created, updated, replies } });
  return { sprints: active.map((s) => s.name), created, updated, replies };
}

export async function currentSprint(db: DB, projectId: string) {
  const [s] = await db
    .select()
    .from(sprints)
    .where(and(eq(sprints.projectId, projectId), eq(sprints.state, "active")))
    .orderBy(desc(sprints.startDate))
    .limit(1);
  return s ?? null;
}

/** Stories for the board with test case and question counters. */
export async function boardStories(db: DB, projectId: string, sprintId: string | null) {
  const where = sprintId ? and(eq(stories.projectId, projectId), eq(stories.sprintId, sprintId)) : eq(stories.projectId, projectId);
  return db
    .select({
      id: stories.id,
      jiraKey: stories.jiraKey,
      summary: stories.summary,
      jiraStatus: stories.jiraStatus,
      qaStage: stories.qaStage,
      currentEnv: stories.currentEnv,
      subtasks: stories.subtasks,
      // Correlated subqueries are written with explicit table names: Drizzle renders column
      // references unqualified inside sql``, which would bind "id" to the inner table.
      tcApproved: sql<number>`(select count(*) from "test_cases" t where t."story_id" = "stories"."id" and t."status" = 'approved')`.mapWith(Number),
      tcDraft: sql<number>`(select count(*) from "test_cases" t where t."story_id" = "stories"."id" and t."status" = 'draft')`.mapWith(Number),
      qOpen: sql<number>`(select count(*) from "questions" q where q."story_id" = "stories"."id" and q."status" <> 'answered')`.mapWith(Number),
      usTitles: sql<string | null>`(select string_agg(u."title", ' · ' order by u."position") from "user_stories" u where u."story_id" = "stories"."id")`,
      bugsOpen: sql<number>`(select count(*) from "bugs" b where b."story_id" = "stories"."id" and b."status" in ('open','in_progress','resolved'))`.mapWith(Number),
      bugsVerify: sql<number>`(select count(*) from "bugs" b where b."story_id" = "stories"."id" and b."status" = 'resolved')`.mapWith(Number),
      lastBuild: sql<string | null>`(select bd."name" from "builds" bd where bd."story_id" = "stories"."id" order by bd."created_at" desc, bd."round" desc limit 1)`,
    })
    .from(stories)
    .where(where)
    .orderBy(asc(stories.jiraKey));
}

export async function storyByKey(db: DB, key: string) {
  const [s] = await db.select().from(stories).where(eq(stories.jiraKey, key.toUpperCase()));
  if (!s) return null;
  const [project] = await db.select().from(projects).where(eq(projects.id, s.projectId));
  const us = await db.select().from(userStories).where(eq(userStories.storyId, s.id)).orderBy(asc(userStories.position));
  const qs = await db.select().from(questions).where(eq(questions.storyId, s.id)).orderBy(asc(questions.createdAt));
  const tcs = await db.select().from(testCases).where(eq(testCases.storyId, s.id)).orderBy(asc(testCases.seq));
  return { story: s, project, userStories: us, questions: qs, testCases: tcs };
}

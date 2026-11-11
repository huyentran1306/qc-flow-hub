import { pgTable, text, timestamp, boolean, integer, jsonb, primaryKey, uniqueIndex, index } from "drizzle-orm/pg-core";

const id = () => text("id").primaryKey().$defaultFn(() => crypto.randomUUID());
const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

export const users = pgTable("users", {
  id: id(),
  email: text("email").notNull().unique(),
  name: text("name").notNull(),
  passwordHash: text("password_hash").notNull(),
  isAdmin: boolean("is_admin").notNull().default(false),
  disabled: boolean("disabled").notNull().default(false),
  // Bumped on password change: sessions signed with an older version stop working.
  sessionVersion: integer("session_version").notNull().default(0),
  createdAt: createdAt(),
});

export type ProjectMapping = {
  storyIssueType: string;
  subBugIssueType: string;
  qcSubtaskLabel: string;
  severityField?: string;
  environmentField?: string;
};

export const defaultMapping: ProjectMapping = {
  storyIssueType: "Story",
  subBugIssueType: "Sub-bug",
  qcSubtaskLabel: "QC",
};

export const ENVS = ["dev", "stg", "prod"] as const;
export type Env = (typeof ENVS)[number];

export type GateRule = {
  minPassRate: number; // percent of in-scope test cases whose latest result is Passed
  maxOpenCritical: number;
  maxOpenMajor: number;
  maxOpenMinor: number;
  maxBlocked: number;
  requireReport: boolean;
};
/** Gate to leave each environment: dev → stg, stg → prod, prod → done. */
export type GateRules = Record<Env, GateRule>;

export const defaultGateRules: GateRules = {
  dev: { minPassRate: 95, maxOpenCritical: 0, maxOpenMajor: 0, maxOpenMinor: 3, maxBlocked: 0, requireReport: true },
  stg: { minPassRate: 100, maxOpenCritical: 0, maxOpenMajor: 0, maxOpenMinor: 1, maxBlocked: 0, requireReport: true },
  prod: { minPassRate: 100, maxOpenCritical: 0, maxOpenMajor: 0, maxOpenMinor: 99, maxBlocked: 0, requireReport: true },
};

/** Jira status names that mean a bug is resolved (waiting for QC) or closed. */
export type BugStatusMap = { resolved: string[]; closed: string[]; reopened: string[] };
export const defaultBugStatusMap: BugStatusMap = {
  resolved: ["Resolved", "Ready for QC", "Ready for Test", "Fixed"],
  closed: ["Closed", "Done"],
  reopened: ["Reopened", "To Do", "Open"],
};

export const projects = pgTable("projects", {
  id: id(),
  key: text("key").notNull().unique(), // Jira project key, e.g. OP
  name: text("name").notNull(),
  jiraBoardId: integer("jira_board_id"),
  testlinkProjectName: text("testlink_project_name"),
  mapping: jsonb("mapping").$type<ProjectMapping>().notNull().default(defaultMapping),
  isDemo: boolean("is_demo").notNull().default(false),
  gateRules: jsonb("gate_rules").$type<GateRules>().notNull().default(defaultGateRules),
  bugStatusMap: jsonb("bug_status_map").$type<BugStatusMap>().notNull().default(defaultBugStatusMap),
  envUrls: jsonb("env_urls").$type<Partial<Record<Env, string>>>().notNull().default({}),
  // {dev:{username,password},…} encrypted with APP_SECRET; passwords never leave the server.
  testAccountsEnc: text("test_accounts_enc"),
  createdAt: createdAt(),
});

export const ROLES = ["lead", "qc", "dev", "po"] as const;
export type Role = (typeof ROLES)[number];

export const memberships = pgTable(
  "memberships",
  {
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
    role: text("role").$type<Role>().notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.projectId] })],
);

export type ConnectionKind = "jira" | "testlink" | "gemini" | "slack" | "git" | "sso";

export const connections = pgTable("connections", {
  kind: text("kind").$type<ConnectionKind>().primaryKey(),
  config: jsonb("config").$type<Record<string, string>>().notNull().default({}),
  secretEnc: text("secret_enc"), // AES-GCM, never sent to the browser
  secretHint: text("secret_hint"), // last 4 chars, for display
  status: text("status").$type<"ok" | "error" | "unchecked">().notNull().default("unchecked"),
  statusMessage: text("status_message"),
  checkedAt: timestamp("checked_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const sprints = pgTable(
  "sprints",
  {
    id: id(),
    projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
    jiraId: integer("jira_id").notNull(),
    name: text("name").notNull(),
    state: text("state").notNull(),
    startDate: timestamp("start_date", { withTimezone: true }),
    endDate: timestamp("end_date", { withTimezone: true }),
  },
  (t) => [uniqueIndex("sprints_project_jira").on(t.projectId, t.jiraId)],
);

export type QaStage = "analyzing" | "qna" | "tc_ready" | "testing" | "done";

export type JiraSubtask = { key: string; summary: string; status: string; issueType: string; labels: string[] };

export type StoryAnalysis = {
  testPoints: string[];
  dependencies: string[];
  risks: string[];
  model: string;
  at: string;
};

export const stories = pgTable(
  "stories",
  {
    id: id(),
    projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
    sprintId: text("sprint_id").references(() => sprints.id, { onDelete: "set null" }),
    jiraKey: text("jira_key").notNull().unique(),
    summary: text("summary").notNull(),
    description: text("description").notNull().default(""),
    jiraStatus: text("jira_status").notNull().default(""),
    subtasks: jsonb("subtasks").$type<JiraSubtask[]>().notNull().default([]),
    qaStage: text("qa_stage").$type<QaStage>().notNull().default("analyzing"),
    currentEnv: text("current_env").$type<Env>().notNull().default("dev"),
    qcOwnerId: text("qc_owner_id").references(() => users.id, { onDelete: "set null" }),
    analysis: jsonb("analysis").$type<StoryAnalysis>(),
    syncedAt: timestamp("synced_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index("stories_project").on(t.projectId)],
);

export const userStories = pgTable("user_stories", {
  id: id(),
  storyId: text("story_id").notNull().references(() => stories.id, { onDelete: "cascade" }),
  code: text("code").notNull(), // US1, US2
  title: text("title").notNull(),
  description: text("description").notNull().default(""),
  position: integer("position").notNull().default(0),
});

export const questions = pgTable("questions", {
  id: id(),
  storyId: text("story_id").notNull().references(() => stories.id, { onDelete: "cascade" }),
  content: text("content").notNull(),
  askedTo: text("asked_to"),
  answer: text("answer"),
  status: text("status").$type<"draft" | "open" | "answered">().notNull().default("open"),
  source: text("source").$type<"ai" | "manual">().notNull().default("manual"),
  jiraCommentId: text("jira_comment_id"),
  // Reply found in the story's Jira comments, waiting for QC to accept it as the answer.
  jiraReply: text("jira_reply"),
  jiraReplyAuthor: text("jira_reply_author"),
  jiraReplyId: text("jira_reply_id"),
  createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
  answeredBy: text("answered_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: createdAt(),
});

export type TcStep = { action: string; expected: string };
export type TcType = "happy" | "negative" | "edge";
export type TcPriority = "high" | "medium" | "low";
export type TcKind = "ui" | "api";

export const testCases = pgTable(
  "test_cases",
  {
  id: id(),
  storyId: text("story_id").notNull().references(() => stories.id, { onDelete: "cascade" }),
  seq: integer("seq").notNull(), // TC-01, TC-02 within the story
  usCode: text("us_code").notNull(),
  title: text("title").notNull(),
  type: text("type").$type<TcType>().notNull(),
  kind: text("kind").$type<TcKind>().notNull().default("ui"),
  priority: text("priority").$type<TcPriority>().notNull(),
  preconditions: text("preconditions").notNull().default(""),
  steps: jsonb("steps").$type<TcStep[]>().notNull().default([]),
  requirementRef: text("requirement_ref"),
  source: text("source").$type<"ai" | "manual" | "agent">().notNull(),
  status: text("status").$type<"draft" | "approved">().notNull().default("draft"),
  testlinkId: text("testlink_id"),
  testlinkExternalId: text("testlink_external_id"),
  createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
  approvedBy: text("approved_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: createdAt(),
  },
  (t) => [uniqueIndex("test_cases_story_seq").on(t.storyId, t.seq)],
);

export const builds = pgTable(
  "builds",
  {
    id: id(),
    storyId: text("story_id").notNull().references(() => stories.id, { onDelete: "cascade" }),
    env: text("env").$type<Env>().notNull(),
    round: integer("round").notNull(),
    name: text("name").notNull(), // DEV-R1, STG-R2, PROD-SMOKE
    testlinkPlanId: text("testlink_plan_id"),
    testlinkBuildId: text("testlink_build_id"),
    createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("builds_story_env_round").on(t.storyId, t.env, t.round)],
);

export type ExecStatus = "passed" | "failed" | "blocked" | "not_run";

export const executions = pgTable(
  "executions",
  {
    id: id(),
    buildId: text("build_id").notNull().references(() => builds.id, { onDelete: "cascade" }),
    testCaseId: text("test_case_id").notNull().references(() => testCases.id, { onDelete: "cascade" }),
    status: text("status").$type<ExecStatus>().notNull().default("not_run"),
    linkedIssueKey: text("linked_issue_key"), // bug key for Failed, blocking ticket for Blocked
    blockerDone: boolean("blocker_done").notNull().default(false),
    notes: text("notes").notNull().default(""),
    byAgent: boolean("by_agent").notNull().default(false),
    agentSource: text("agent_source").$type<"antigravity" | "auto">(),
    reviewed: boolean("reviewed").notNull().default(true), // agent results start unreviewed
    executedBy: text("executed_by").references(() => users.id, { onDelete: "set null" }),
    executedAt: timestamp("executed_at", { withTimezone: true }),
    pushedAt: timestamp("pushed_at", { withTimezone: true }),
  },
  (t) => [uniqueIndex("exec_build_tc").on(t.buildId, t.testCaseId)],
);

export type Severity = "critical" | "major" | "minor";
export type BugStatus = "draft" | "open" | "in_progress" | "resolved" | "closed";
export type FixCommit = { sha: string; message: string; url?: string; author?: string; at?: string };

export const bugs = pgTable("bugs", {
  id: id(),
  storyId: text("story_id").notNull().references(() => stories.id, { onDelete: "cascade" }),
  executionId: text("execution_id").references(() => executions.id, { onDelete: "set null" }),
  jiraKey: text("jira_key").unique(),
  title: text("title").notNull(),
  steps: text("steps").notNull().default(""),
  actual: text("actual").notNull().default(""),
  expected: text("expected").notNull().default(""),
  severity: text("severity").$type<Severity>().notNull().default("major"),
  env: text("env").$type<Env>().notNull().default("dev"),
  status: text("status").$type<BugStatus>().notNull().default("open"),
  jiraStatus: text("jira_status"),
  fixCommits: jsonb("fix_commits").$type<FixCommit[]>().notNull().default([]),
  source: text("source").$type<"manual" | "ai" | "agent">().notNull().default("manual"),
  createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
  closedBy: text("closed_by").references(() => users.id, { onDelete: "set null" }),
  closedAt: timestamp("closed_at", { withTimezone: true }),
  createdAt: createdAt(),
});

export const evidence = pgTable("evidence", {
  id: id(),
  ownerType: text("owner_type").$type<"bug" | "bug_fix" | "execution">().notNull(),
  ownerId: text("owner_id").notNull(),
  fileName: text("file_name").notNull(),
  mime: text("mime").notNull(),
  size: integer("size").notNull(),
  storedName: text("stored_name").notNull(),
  uploadedBy: text("uploaded_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: createdAt(),
});

export type ReportCounts = {
  build: { passed: number; failed: number; blocked: number; notRun: number; total: number };
  env: { passed: number; failed: number; blocked: number; notRun: number; total: number };
  byUs: { us: string; passed: number; failed: number; blocked: number; notRun: number; total: number }[];
  openBugs: { key: string; title: string; severity: Severity }[];
  closedBugs: number;
  blockers: string[];
  api?: { total: number; failed: number; failures: { tc: string; method: string; url: string; status: number | null }[] };
};

export const reports = pgTable("reports", {
  id: id(),
  buildId: text("build_id").notNull().unique().references(() => builds.id, { onDelete: "cascade" }),
  counts: jsonb("counts").$type<ReportCounts>().notNull(),
  aiSummary: text("ai_summary"),
  finalText: text("final_text").notNull().default(""),
  postedAt: timestamp("posted_at", { withTimezone: true }),
  postedBy: text("posted_by").references(() => users.id, { onDelete: "set null" }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type AutoRunStatus = "queued" | "running" | "done" | "failed" | "cancelled";

export const autoRuns = pgTable("auto_runs", {
  id: id(),
  buildId: text("build_id").notNull().references(() => builds.id, { onDelete: "cascade" }),
  status: text("status").$type<AutoRunStatus>().notNull().default("queued"),
  total: integer("total").notNull().default(0),
  done: integer("done").notNull().default(0),
  passed: integer("passed").notNull().default(0),
  failed: integer("failed").notNull().default(0),
  blocked: integer("blocked").notNull().default(0),
  current: text("current"),
  log: jsonb("log").$type<string[]>().notNull().default([]),
  error: text("error"),
  options: jsonb("options").$type<{ headed: boolean; rerun: boolean }>().notNull().default({ headed: false, rerun: false }),
  startedBy: text("started_by").references(() => users.id, { onDelete: "set null" }),
  startedAt: createdAt(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
});

/** HTTP calls observed or made while running a test case: the "API result" of the case. */
export const apiCalls = pgTable(
  "api_calls",
  {
    id: id(),
    executionId: text("execution_id").notNull().references(() => executions.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    source: text("source").$type<"ui" | "api" | "agent">().notNull(), // seen in the page, called directly, or sent by Antigravity
    method: text("method").notNull(),
    url: text("url").notNull(),
    status: integer("status"), // null = network error
    durationMs: integer("duration_ms"),
    requestBody: text("request_body"),
    responseBody: text("response_body"),
    error: text("error"),
    at: createdAt(),
  },
  (t) => [index("api_calls_exec").on(t.executionId)],
);

export const gateEvents = pgTable("gate_events", {
  id: id(),
  storyId: text("story_id").notNull().references(() => stories.id, { onDelete: "cascade" }),
  fromEnv: text("from_env").$type<Env>().notNull(),
  toEnv: text("to_env").notNull(), // stg | prod | done
  overridden: boolean("overridden").notNull().default(false),
  reason: text("reason"),
  failedChecks: jsonb("failed_checks").$type<string[]>().notNull().default([]),
  userId: text("user_id").references(() => users.id, { onDelete: "set null" }),
  at: createdAt(),
});

export const mcpTokens = pgTable("mcp_tokens", {
  id: id(),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  tokenHash: text("token_hash").notNull().unique(),
  hint: text("hint").notNull(),
  scope: text("scope").$type<"read" | "write">().notNull(),
  createdAt: createdAt(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
});

export const auditLogs = pgTable(
  "audit_logs",
  {
    id: id(),
    at: createdAt(),
    userId: text("user_id").references(() => users.id, { onDelete: "set null" }),
    source: text("source").$type<"ui" | "mcp" | "webhook" | "system">().notNull().default("ui"),
    action: text("action").notNull(),
    target: text("target"),
    detail: jsonb("detail").$type<Record<string, unknown>>(),
  },
  (t) => [index("audit_at").on(t.at)],
);

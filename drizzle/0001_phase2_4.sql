CREATE TABLE "bugs" (
	"id" text PRIMARY KEY NOT NULL,
	"story_id" text NOT NULL,
	"execution_id" text,
	"jira_key" text,
	"title" text NOT NULL,
	"steps" text DEFAULT '' NOT NULL,
	"actual" text DEFAULT '' NOT NULL,
	"expected" text DEFAULT '' NOT NULL,
	"severity" text DEFAULT 'major' NOT NULL,
	"env" text DEFAULT 'dev' NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"jira_status" text,
	"fix_commits" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"source" text DEFAULT 'manual' NOT NULL,
	"created_by" text,
	"closed_by" text,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bugs_jira_key_unique" UNIQUE("jira_key")
);
--> statement-breakpoint
CREATE TABLE "builds" (
	"id" text PRIMARY KEY NOT NULL,
	"story_id" text NOT NULL,
	"env" text NOT NULL,
	"round" integer NOT NULL,
	"name" text NOT NULL,
	"testlink_plan_id" text,
	"testlink_build_id" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "evidence" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_type" text NOT NULL,
	"owner_id" text NOT NULL,
	"file_name" text NOT NULL,
	"mime" text NOT NULL,
	"size" integer NOT NULL,
	"stored_name" text NOT NULL,
	"uploaded_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "executions" (
	"id" text PRIMARY KEY NOT NULL,
	"build_id" text NOT NULL,
	"test_case_id" text NOT NULL,
	"status" text DEFAULT 'not_run' NOT NULL,
	"linked_issue_key" text,
	"blocker_done" boolean DEFAULT false NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"by_agent" boolean DEFAULT false NOT NULL,
	"reviewed" boolean DEFAULT true NOT NULL,
	"executed_by" text,
	"executed_at" timestamp with time zone,
	"pushed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "gate_events" (
	"id" text PRIMARY KEY NOT NULL,
	"story_id" text NOT NULL,
	"from_env" text NOT NULL,
	"to_env" text NOT NULL,
	"overridden" boolean DEFAULT false NOT NULL,
	"reason" text,
	"failed_checks" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mcp_tokens" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"token_hash" text NOT NULL,
	"hint" text NOT NULL,
	"scope" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "mcp_tokens_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "reports" (
	"id" text PRIMARY KEY NOT NULL,
	"build_id" text NOT NULL,
	"counts" jsonb NOT NULL,
	"ai_summary" text,
	"final_text" text DEFAULT '' NOT NULL,
	"posted_at" timestamp with time zone,
	"posted_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reports_build_id_unique" UNIQUE("build_id")
);
--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "gate_rules" jsonb DEFAULT '{"dev":{"minPassRate":95,"maxOpenCritical":0,"maxOpenMajor":0,"maxOpenMinor":3,"maxBlocked":0,"requireReport":true},"stg":{"minPassRate":100,"maxOpenCritical":0,"maxOpenMajor":0,"maxOpenMinor":1,"maxBlocked":0,"requireReport":true},"prod":{"minPassRate":100,"maxOpenCritical":0,"maxOpenMajor":0,"maxOpenMinor":99,"maxBlocked":0,"requireReport":true}}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "bug_status_map" jsonb DEFAULT '{"resolved":["Resolved","Ready for QC","Ready for Test","Fixed"],"closed":["Closed","Done"],"reopened":["Reopened","To Do","Open"]}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "env_urls" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "stories" ADD COLUMN "current_env" text DEFAULT 'dev' NOT NULL;--> statement-breakpoint
ALTER TABLE "bugs" ADD CONSTRAINT "bugs_story_id_stories_id_fk" FOREIGN KEY ("story_id") REFERENCES "public"."stories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bugs" ADD CONSTRAINT "bugs_execution_id_executions_id_fk" FOREIGN KEY ("execution_id") REFERENCES "public"."executions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bugs" ADD CONSTRAINT "bugs_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bugs" ADD CONSTRAINT "bugs_closed_by_users_id_fk" FOREIGN KEY ("closed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "builds" ADD CONSTRAINT "builds_story_id_stories_id_fk" FOREIGN KEY ("story_id") REFERENCES "public"."stories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "builds" ADD CONSTRAINT "builds_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence" ADD CONSTRAINT "evidence_uploaded_by_users_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "executions" ADD CONSTRAINT "executions_build_id_builds_id_fk" FOREIGN KEY ("build_id") REFERENCES "public"."builds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "executions" ADD CONSTRAINT "executions_test_case_id_test_cases_id_fk" FOREIGN KEY ("test_case_id") REFERENCES "public"."test_cases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "executions" ADD CONSTRAINT "executions_executed_by_users_id_fk" FOREIGN KEY ("executed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gate_events" ADD CONSTRAINT "gate_events_story_id_stories_id_fk" FOREIGN KEY ("story_id") REFERENCES "public"."stories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gate_events" ADD CONSTRAINT "gate_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_tokens" ADD CONSTRAINT "mcp_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_build_id_builds_id_fk" FOREIGN KEY ("build_id") REFERENCES "public"."builds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_posted_by_users_id_fk" FOREIGN KEY ("posted_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "builds_story_env_round" ON "builds" USING btree ("story_id","env","round");--> statement-breakpoint
CREATE UNIQUE INDEX "exec_build_tc" ON "executions" USING btree ("build_id","test_case_id");
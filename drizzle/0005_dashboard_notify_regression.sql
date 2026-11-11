CREATE TABLE "ai_answers" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text,
	"project_id" text NOT NULL,
	"question" text NOT NULL,
	"answer" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"body" text,
	"link" text,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "regression_suites" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"name" text NOT NULL,
	"env" text DEFAULT 'stg' NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"schedule" jsonb DEFAULT '{"mode":"off","time":"02:00"}'::jsonb NOT NULL,
	"next_run_at" timestamp with time zone,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "suite_cases" (
	"suite_id" text NOT NULL,
	"test_case_id" text NOT NULL,
	CONSTRAINT "suite_cases_suite_id_test_case_id_pk" PRIMARY KEY("suite_id","test_case_id")
);
--> statement-breakpoint
CREATE TABLE "suite_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"suite_id" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"trigger" text DEFAULT 'manual' NOT NULL,
	"build_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"total" integer DEFAULT 0 NOT NULL,
	"passed" integer DEFAULT 0 NOT NULL,
	"failed" integer DEFAULT 0 NOT NULL,
	"blocked" integer DEFAULT 0 NOT NULL,
	"error" text,
	"started_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
DROP INDEX "builds_story_env_round";--> statement-breakpoint
ALTER TABLE "auto_runs" ADD COLUMN "suite_run_id" text;--> statement-breakpoint
ALTER TABLE "bugs" ADD COLUMN "resolved_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "builds" ADD COLUMN "kind" text DEFAULT 'round' NOT NULL;--> statement-breakpoint
ALTER TABLE "ai_answers" ADD CONSTRAINT "ai_answers_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_answers" ADD CONSTRAINT "ai_answers_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "regression_suites" ADD CONSTRAINT "regression_suites_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "regression_suites" ADD CONSTRAINT "regression_suites_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "suite_cases" ADD CONSTRAINT "suite_cases_suite_id_regression_suites_id_fk" FOREIGN KEY ("suite_id") REFERENCES "public"."regression_suites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "suite_cases" ADD CONSTRAINT "suite_cases_test_case_id_test_cases_id_fk" FOREIGN KEY ("test_case_id") REFERENCES "public"."test_cases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "suite_runs" ADD CONSTRAINT "suite_runs_suite_id_regression_suites_id_fk" FOREIGN KEY ("suite_id") REFERENCES "public"."regression_suites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "suite_runs" ADD CONSTRAINT "suite_runs_started_by_users_id_fk" FOREIGN KEY ("started_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "notifications_user" ON "notifications" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "builds_story_env_kind_round" ON "builds" USING btree ("story_id","env","kind","round");
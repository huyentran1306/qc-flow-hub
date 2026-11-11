CREATE TABLE "api_calls" (
	"id" text PRIMARY KEY NOT NULL,
	"execution_id" text NOT NULL,
	"seq" integer NOT NULL,
	"source" text NOT NULL,
	"method" text NOT NULL,
	"url" text NOT NULL,
	"status" integer,
	"duration_ms" integer,
	"request_body" text,
	"response_body" text,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auto_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"build_id" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"total" integer DEFAULT 0 NOT NULL,
	"done" integer DEFAULT 0 NOT NULL,
	"passed" integer DEFAULT 0 NOT NULL,
	"failed" integer DEFAULT 0 NOT NULL,
	"blocked" integer DEFAULT 0 NOT NULL,
	"current" text,
	"log" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"error" text,
	"options" jsonb DEFAULT '{"headed":false,"rerun":false}'::jsonb NOT NULL,
	"started_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "executions" ADD COLUMN "agent_source" text;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "test_accounts_enc" text;--> statement-breakpoint
ALTER TABLE "test_cases" ADD COLUMN "kind" text DEFAULT 'ui' NOT NULL;--> statement-breakpoint
ALTER TABLE "api_calls" ADD CONSTRAINT "api_calls_execution_id_executions_id_fk" FOREIGN KEY ("execution_id") REFERENCES "public"."executions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auto_runs" ADD CONSTRAINT "auto_runs_build_id_builds_id_fk" FOREIGN KEY ("build_id") REFERENCES "public"."builds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auto_runs" ADD CONSTRAINT "auto_runs_started_by_users_id_fk" FOREIGN KEY ("started_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "api_calls_exec" ON "api_calls" USING btree ("execution_id");
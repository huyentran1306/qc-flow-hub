ALTER TABLE "users" ADD COLUMN "session_version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "test_cases_story_seq" ON "test_cases" USING btree ("story_id","seq");
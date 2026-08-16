CREATE TYPE "public"."operator_command_status" AS ENUM('queued', 'waiting', 'running', 'succeeded', 'abandoned');--> statement-breakpoint
CREATE TABLE "operator_commands" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"command" text NOT NULL,
	"task" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" "operator_command_status" DEFAULT 'queued' NOT NULL,
	"waiting_reason" text,
	"attempt" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 3 NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"claim_id" text,
	"claimed_at" timestamp with time zone,
	"run_id" text,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"result" jsonb,
	"error" text,
	"requested_by" text NOT NULL,
	"dedupe_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "operator_commands_attempt_check" CHECK ("operator_commands"."attempt" >= 0 and "operator_commands"."max_attempts" > 0),
	CONSTRAINT "operator_commands_waiting_reason_check" CHECK (("operator_commands"."status" = 'waiting') = ("operator_commands"."waiting_reason" is not null))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "operator_commands_dedupe_key_unique" ON "operator_commands" USING btree ("dedupe_key") WHERE "operator_commands"."dedupe_key" is not null;--> statement-breakpoint
CREATE INDEX "operator_commands_drain_idx" ON "operator_commands" USING btree ("status","next_attempt_at");
--> statement-breakpoint
-- Same ownership rule as every other table carrying `updated_at`: the
-- database sets it, never the application.
CREATE TRIGGER "operator_commands_set_updated_at"
	BEFORE UPDATE ON "operator_commands"
	FOR EACH ROW EXECUTE FUNCTION "set_updated_at"();

CREATE TABLE "maintenance_state" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"owner_token" text,
	"cycle_started_at" timestamp with time zone,
	"heartbeat_at" timestamp with time zone,
	"last_succeeded_at" timestamp with time zone,
	"last_failed_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "maintenance_state_singleton_check" CHECK ("maintenance_state"."id" = 1)
);
--> statement-breakpoint
INSERT INTO "maintenance_state" ("id") VALUES (1) ON CONFLICT ("id") DO NOTHING;
--> statement-breakpoint
CREATE INDEX "workflow_events_workflow_created_idx" ON "workflow_events" USING btree ("workflow_name","created_at");

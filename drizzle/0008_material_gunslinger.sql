ALTER TABLE "enrollments" ADD COLUMN "inbound_hold_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "enrollments" ADD COLUMN "inbound_hold_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "enrollments" ADD COLUMN "inbound_hold_previous_state" "enrollment_state";--> statement-breakpoint
ALTER TABLE "enrollments" ADD COLUMN "inbound_hold_previous_next_action_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "enrollments" ADD COLUMN "inbound_hold_previous_next_action_token" text;--> statement-breakpoint
ALTER TABLE "enrollments" ADD COLUMN "workflow_claim_id" text;--> statement-breakpoint
ALTER TABLE "enrollments" ADD COLUMN "workflow_claimed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "inbound_records" ADD COLUMN "outreach_id" text;--> statement-breakpoint
CREATE INDEX "enrollments_workflow_claimed_at_idx" ON "enrollments" USING btree ("workflow_claimed_at");--> statement-breakpoint
ALTER TABLE "enrollments" ADD CONSTRAINT "enrollments_inbound_hold_count_check" CHECK ("enrollments"."inbound_hold_count" >= 0);
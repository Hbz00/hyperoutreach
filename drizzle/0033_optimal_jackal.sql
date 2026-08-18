ALTER TYPE "public"."email_resolution_reason" ADD VALUE 'ladder_exhausted';--> statement-breakpoint
ALTER TYPE "public"."email_resolution_reason" ADD VALUE 'ladder_limit_reached';--> statement-breakpoint
ALTER TYPE "public"."email_resolution_reason" ADD VALUE 'address_suppressed';--> statement-breakpoint
DROP INDEX "messages_enrollment_step_outbound_unique";--> statement-breakpoint
ALTER TABLE "email_candidates" ADD COLUMN "ladder_rank" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "email_candidates" ADD COLUMN "first_attempted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "email_candidates" ADD COLUMN "dead_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "email_candidates" ADD COLUMN "dead_message_id" uuid;--> statement-breakpoint
ALTER TABLE "email_candidates" ADD COLUMN "advanced_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "address_dead_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "operator_sending_settings" ADD COLUMN "address_ladder_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "operator_sending_settings" ADD COLUMN "address_ladder_max_rungs" integer DEFAULT 3 NOT NULL;--> statement-breakpoint
ALTER TABLE "operator_sending_settings" ADD COLUMN "address_ladder_max_advances_per_account_per_day" integer DEFAULT 2 NOT NULL;--> statement-breakpoint
ALTER TABLE "operator_sending_settings" ADD COLUMN "address_ladder_failure_rate_percent" integer DEFAULT 30 NOT NULL;--> statement-breakpoint
ALTER TABLE "operator_sending_settings" ADD COLUMN "address_ladder_failure_rate_minimum_sends" integer DEFAULT 20 NOT NULL;--> statement-breakpoint
ALTER TABLE "operator_sending_settings" ADD COLUMN "address_ladder_demotion_minimum_people" integer DEFAULT 2 NOT NULL;--> statement-breakpoint
ALTER TABLE "operator_sending_settings" ADD COLUMN "address_ladder_demotion_failure_share_percent" integer DEFAULT 50 NOT NULL;--> statement-breakpoint
ALTER TABLE "email_candidates" ADD CONSTRAINT "email_candidates_dead_message_fk" FOREIGN KEY ("dead_message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "email_candidates_pattern_dead_idx" ON "email_candidates" USING btree ("pattern","dead_at");--> statement-breakpoint
CREATE INDEX "messages_address_dead_at_idx" ON "messages" USING btree ("address_dead_at");--> statement-breakpoint
CREATE UNIQUE INDEX "messages_enrollment_step_outbound_unique" ON "messages" USING btree ("enrollment_id","step_index") WHERE "messages"."direction" = 'outbound' and "messages"."address_dead_at" is null;--> statement-breakpoint
ALTER TABLE "email_candidates" ADD CONSTRAINT "email_candidates_ladder_rank_check" CHECK ("email_candidates"."ladder_rank" >= 1);--> statement-breakpoint
ALTER TABLE "email_candidates" ADD CONSTRAINT "email_candidates_dead_message_check" CHECK ("email_candidates"."dead_message_id" is null or "email_candidates"."dead_at" is not null);--> statement-breakpoint
ALTER TABLE "operator_sending_settings" ADD CONSTRAINT "operator_sending_settings_ladder_check" CHECK ("operator_sending_settings"."address_ladder_max_rungs" >= 1
        and "operator_sending_settings"."address_ladder_max_advances_per_account_per_day" >= 0
        and "operator_sending_settings"."address_ladder_failure_rate_percent" between 1 and 100
        and "operator_sending_settings"."address_ladder_failure_rate_minimum_sends" >= 1
        and "operator_sending_settings"."address_ladder_demotion_minimum_people" >= 2
        and "operator_sending_settings"."address_ladder_demotion_failure_share_percent" between 1 and 100);
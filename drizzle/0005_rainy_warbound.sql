CREATE TYPE "public"."bounce_kind" AS ENUM('hard', 'soft');--> statement-breakpoint
ALTER TYPE "public"."enrollment_state" ADD VALUE 'waiting' BEFORE 'paused';--> statement-breakpoint
ALTER TYPE "public"."enrollment_state" ADD VALUE 'manual_review' BEFORE 'paused';--> statement-breakpoint
CREATE TABLE "operator_sending_settings" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"emergency_pause" boolean DEFAULT false NOT NULL,
	"timezone" text DEFAULT 'Europe/Paris' NOT NULL,
	"working_days" jsonb DEFAULT '[1,2,3,4,5]'::jsonb NOT NULL,
	"working_start_minute" integer DEFAULT 540 NOT NULL,
	"working_end_minute" integer DEFAULT 1080 NOT NULL,
	"mailbox_daily_cap" integer DEFAULT 25 NOT NULL,
	"campaign_daily_cap" integer DEFAULT 100 NOT NULL,
	"mailbox_minimum_delay_seconds" integer DEFAULT 60 NOT NULL,
	"contact_minimum_delay_minutes" integer DEFAULT 1440 NOT NULL,
	"cross_campaign_cooldown_days" integer DEFAULT 30 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "operator_sending_settings_singleton_check" CHECK ("operator_sending_settings"."id" = 1),
	CONSTRAINT "operator_sending_settings_working_hours_check" CHECK ("operator_sending_settings"."working_start_minute" >= 0 and "operator_sending_settings"."working_start_minute" < "operator_sending_settings"."working_end_minute" and "operator_sending_settings"."working_end_minute" <= 1440),
	CONSTRAINT "operator_sending_settings_limits_check" CHECK ("operator_sending_settings"."mailbox_daily_cap" > 0 and "operator_sending_settings"."campaign_daily_cap" > 0 and "operator_sending_settings"."mailbox_minimum_delay_seconds" >= 0 and "operator_sending_settings"."contact_minimum_delay_minutes" >= 0 and "operator_sending_settings"."cross_campaign_cooldown_days" >= 0)
);
--> statement-breakpoint
INSERT INTO "operator_sending_settings" ("id") VALUES (1) ON CONFLICT ("id") DO NOTHING;--> statement-breakpoint
ALTER TABLE "enrollments" ADD COLUMN "next_action_token" text;--> statement-breakpoint
ALTER TABLE "enrollments" ADD COLUMN "soft_bounce_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "inbound_records" ADD COLUMN "in_reply_to" text;--> statement-breakpoint
ALTER TABLE "inbound_records" ADD COLUMN "references" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "replies" ADD COLUMN "classification_reason" text;--> statement-breakpoint
UPDATE "replies" SET "classification_reason" = 'Legacy classification';--> statement-breakpoint
ALTER TABLE "replies" ALTER COLUMN "classification_reason" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "replies" ADD COLUMN "classifier" text;--> statement-breakpoint
UPDATE "replies" SET "classifier" = 'legacy';--> statement-breakpoint
ALTER TABLE "replies" ALTER COLUMN "classifier" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "replies" ADD COLUMN "bounce_kind" "bounce_kind";--> statement-breakpoint
ALTER TABLE "replies" ADD COLUMN "sender" text;--> statement-breakpoint
UPDATE "replies" SET "sender" = 'unknown@legacy.invalid';--> statement-breakpoint
ALTER TABLE "replies" ALTER COLUMN "sender" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "replies" ADD COLUMN "subject" text;--> statement-breakpoint
UPDATE "replies" SET "subject" = '(legacy inbound)';--> statement-breakpoint
ALTER TABLE "replies" ALTER COLUMN "subject" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "replies" ADD COLUMN "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "enrollments_next_action_token_unique" ON "enrollments" USING btree ("next_action_token") WHERE "enrollments"."next_action_token" is not null;--> statement-breakpoint
CREATE INDEX "inbound_records_in_reply_to_idx" ON "inbound_records" USING btree ("in_reply_to");--> statement-breakpoint
ALTER TABLE "enrollments" ADD CONSTRAINT "enrollments_soft_bounce_count_check" CHECK ("enrollments"."soft_bounce_count" >= 0);

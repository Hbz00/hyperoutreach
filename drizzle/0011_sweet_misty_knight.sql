CREATE TYPE "public"."email_resolution_status" AS ENUM('unresolved', 'resolved', 'manual_review', 'provider_error');--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "email_resolution_status" "email_resolution_status" DEFAULT 'unresolved' NOT NULL;--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "email_resolution_attempted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "email_resolution_error" text;--> statement-breakpoint
CREATE INDEX "contacts_email_resolution_status_idx" ON "contacts" USING btree ("email_resolution_status");
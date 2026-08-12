ALTER TYPE "public"."email_resolution_reason" ADD VALUE 'stale_employment';--> statement-breakpoint
ALTER TYPE "public"."email_resolution_reason" ADD VALUE 'resolution_in_progress';--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "employment_version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "email_resolution_claim_id" text;--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "email_resolution_claimed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "email_resolution_claim_account_id" uuid;--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "email_resolution_claim_employment_version" integer;--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "email_resolution_claim_domain" text;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "contact_account_id" uuid;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "employment_version" integer;--> statement-breakpoint
UPDATE "messages" AS message
SET "contact_account_id" = contact."account_id",
    "employment_version" = contact."employment_version"
FROM "enrollments" AS enrollment
JOIN "contacts" AS contact ON contact."id" = enrollment."contact_id"
WHERE message."enrollment_id" = enrollment."id"
  AND message."direction" = 'outbound';--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_contact_account_id_accounts_id_fk" FOREIGN KEY ("contact_account_id") REFERENCES "public"."accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "contacts_email_resolution_claimed_at_idx" ON "contacts" USING btree ("email_resolution_claimed_at");

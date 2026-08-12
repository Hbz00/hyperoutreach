ALTER TABLE "messages" ADD COLUMN "send_attempt_token" text;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "send_claimed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "send_attempted_at" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX "messages_send_attempt_token_unique" ON "messages" USING btree ("send_attempt_token") WHERE "messages"."send_attempt_token" is not null;--> statement-breakpoint
ALTER TABLE "campaign_versions" DISABLE TRIGGER "campaign_versions_immutable_when_used";--> statement-breakpoint
UPDATE "campaign_versions" AS version
SET "published_at" = NULL
WHERE version."used_at" IS NULL
	AND version."published_at" = version."created_at"
	AND NOT EXISTS (
		SELECT 1 FROM "enrollments"
		WHERE "campaign_version_id" = version."id"
	);--> statement-breakpoint
ALTER TABLE "campaign_versions" ENABLE TRIGGER "campaign_versions_immutable_when_used";--> statement-breakpoint
CREATE OR REPLACE FUNCTION "prevent_enrollment_identity_mutation"() RETURNS trigger AS $$
BEGIN
	IF NEW."campaign_id" IS DISTINCT FROM OLD."campaign_id"
		OR NEW."campaign_version_id" IS DISTINCT FROM OLD."campaign_version_id"
		OR NEW."contact_id" IS DISTINCT FROM OLD."contact_id"
		OR NEW."mailbox_id" IS DISTINCT FROM OLD."mailbox_id" THEN
		RAISE EXCEPTION 'enrollment campaign, version, contact, and mailbox identity are immutable'
			USING ERRCODE = '23514';
	END IF;
	RETURN NEW;
END;
$$ LANGUAGE plpgsql;

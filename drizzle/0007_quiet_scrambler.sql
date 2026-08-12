DROP INDEX IF EXISTS "messages_provider_draft_id_unique";--> statement-breakpoint
DROP INDEX IF EXISTS "messages_provider_message_id_unique";--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN IF NOT EXISTS "mailbox_id" uuid;--> statement-breakpoint
UPDATE "messages" AS message
SET "mailbox_id" = enrollment."mailbox_id"
FROM "enrollments" AS enrollment
WHERE enrollment."id" = message."enrollment_id"
	AND message."mailbox_id" IS DISTINCT FROM enrollment."mailbox_id";--> statement-breakpoint
DO $$
BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint
		WHERE conname = 'messages_mailbox_id_mailbox_connections_id_fk'
	) THEN
		ALTER TABLE "messages" ADD CONSTRAINT "messages_mailbox_id_mailbox_connections_id_fk"
			FOREIGN KEY ("mailbox_id") REFERENCES "public"."mailbox_connections"("id")
			ON DELETE restrict ON UPDATE no action;
	END IF;
END $$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION "enforce_message_mailbox_scope"() RETURNS trigger AS $$
DECLARE
	expected_mailbox_id uuid;
BEGIN
	SELECT "mailbox_id" INTO expected_mailbox_id
	FROM "enrollments" WHERE "id" = NEW."enrollment_id";
	IF NOT FOUND THEN
		RAISE EXCEPTION 'message enrollment is missing' USING ERRCODE = '23503';
	END IF;
	IF NEW."mailbox_id" IS NULL AND expected_mailbox_id IS NOT NULL THEN
		NEW."mailbox_id" = expected_mailbox_id;
	ELSIF NEW."mailbox_id" IS DISTINCT FROM expected_mailbox_id THEN
		RAISE EXCEPTION 'message mailbox must match enrollment mailbox'
			USING ERRCODE = '23514';
	END IF;
	RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
DROP TRIGGER IF EXISTS "messages_mailbox_scope_aligned" ON "messages";--> statement-breakpoint
CREATE TRIGGER "messages_mailbox_scope_aligned"
	BEFORE INSERT OR UPDATE OF "enrollment_id", "mailbox_id" ON "messages"
	FOR EACH ROW EXECUTE FUNCTION "enforce_message_mailbox_scope"();--> statement-breakpoint
DROP INDEX IF EXISTS "messages_mailbox_provider_draft_unique";--> statement-breakpoint
DROP INDEX IF EXISTS "messages_local_mock_provider_draft_unique";--> statement-breakpoint
DROP INDEX IF EXISTS "messages_mailbox_provider_message_unique";--> statement-breakpoint
DROP INDEX IF EXISTS "messages_local_mock_provider_message_unique";--> statement-breakpoint
CREATE UNIQUE INDEX "messages_mailbox_provider_draft_unique" ON "messages" USING btree ("mailbox_id","provider_draft_id") WHERE "messages"."mailbox_id" is not null and "messages"."provider_draft_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "messages_local_mock_provider_draft_unique" ON "messages" USING btree ("provider_draft_id") WHERE "messages"."mailbox_id" is null and "messages"."provider_draft_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "messages_mailbox_provider_message_unique" ON "messages" USING btree ("mailbox_id","provider_message_id") WHERE "messages"."mailbox_id" is not null and "messages"."provider_message_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "messages_local_mock_provider_message_unique" ON "messages" USING btree ("provider_message_id") WHERE "messages"."mailbox_id" is null and "messages"."provider_message_id" is not null;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "messages_mailbox_id_idx" ON "messages" USING btree ("mailbox_id");--> statement-breakpoint
INSERT INTO "operator_sending_settings" ("id") VALUES (1) ON CONFLICT ("id") DO NOTHING;

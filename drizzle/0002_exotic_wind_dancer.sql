ALTER TABLE "evidence_sources" DROP CONSTRAINT "evidence_sources_owner_check";--> statement-breakpoint
DROP INDEX "accounts_normalized_name_unique";--> statement-breakpoint
DROP INDEX "contacts_account_name_unique";--> statement-breakpoint
DROP INDEX "evidence_sources_owner_url_unique";--> statement-breakpoint
UPDATE "evidence_sources"
SET "account_id" = NULL
WHERE "account_id" IS NOT NULL AND "contact_id" IS NOT NULL;--> statement-breakpoint
DELETE FROM "evidence_sources" AS duplicate
USING "evidence_sources" AS retained
WHERE duplicate."contact_id" = retained."contact_id"
	AND duplicate."url" = retained."url"
	AND (
		duplicate."created_at" > retained."created_at"
		OR (
			duplicate."created_at" = retained."created_at"
			AND duplicate."id" > retained."id"
		)
	);--> statement-breakpoint
DELETE FROM "evidence_sources" AS duplicate
USING "evidence_sources" AS retained
WHERE duplicate."account_id" = retained."account_id"
	AND duplicate."contact_id" IS NULL
	AND retained."contact_id" IS NULL
	AND duplicate."url" = retained."url"
	AND (
		duplicate."created_at" > retained."created_at"
		OR (
			duplicate."created_at" = retained."created_at"
			AND duplicate."id" > retained."id"
		)
	);--> statement-breakpoint
CREATE UNIQUE INDEX "accounts_domainless_name_unique" ON "accounts" USING btree ("normalized_name") WHERE "accounts"."domain" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "contacts_account_name_fallback_unique" ON "contacts" USING btree ("account_id","normalized_full_name") WHERE "contacts"."linkedin_url" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "evidence_sources_account_url_unique" ON "evidence_sources" USING btree ("account_id","url") WHERE "evidence_sources"."account_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "evidence_sources_contact_url_unique" ON "evidence_sources" USING btree ("contact_id","url") WHERE "evidence_sources"."contact_id" is not null;--> statement-breakpoint
ALTER TABLE "evidence_sources" ADD CONSTRAINT "evidence_sources_owner_check" CHECK (num_nonnulls("evidence_sources"."account_id", "evidence_sources"."contact_id") = 1);--> statement-breakpoint
CREATE FUNCTION "set_updated_at"() RETURNS trigger AS $$
BEGIN
	NEW."updated_at" = clock_timestamp();
	RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER "accounts_set_updated_at"
	BEFORE UPDATE ON "accounts"
	FOR EACH ROW EXECUTE FUNCTION "set_updated_at"();--> statement-breakpoint
CREATE TRIGGER "campaigns_set_updated_at"
	BEFORE UPDATE ON "campaigns"
	FOR EACH ROW EXECUTE FUNCTION "set_updated_at"();--> statement-breakpoint
CREATE TRIGGER "contacts_set_updated_at"
	BEFORE UPDATE ON "contacts"
	FOR EACH ROW EXECUTE FUNCTION "set_updated_at"();--> statement-breakpoint
CREATE TRIGGER "email_candidates_set_updated_at"
	BEFORE UPDATE ON "email_candidates"
	FOR EACH ROW EXECUTE FUNCTION "set_updated_at"();--> statement-breakpoint
CREATE TRIGGER "enrollments_set_updated_at"
	BEFORE UPDATE ON "enrollments"
	FOR EACH ROW EXECUTE FUNCTION "set_updated_at"();--> statement-breakpoint
CREATE TRIGGER "mailbox_connections_set_updated_at"
	BEFORE UPDATE ON "mailbox_connections"
	FOR EACH ROW EXECUTE FUNCTION "set_updated_at"();--> statement-breakpoint
CREATE TRIGGER "messages_set_updated_at"
	BEFORE UPDATE ON "messages"
	FOR EACH ROW EXECUTE FUNCTION "set_updated_at"();

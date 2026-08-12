ALTER TABLE "campaign_versions" ADD COLUMN "used_at" timestamp with time zone;--> statement-breakpoint
CREATE OR REPLACE FUNCTION "prevent_used_campaign_version_mutation"() RETURNS trigger AS $$
BEGIN
	IF OLD."used_at" IS NOT NULL THEN
		RAISE EXCEPTION 'campaign versions used by enrollments are immutable'
			USING ERRCODE = '23514';
	END IF;
	RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE OR REPLACE FUNCTION "prevent_used_sequence_step_mutation"() RETURNS trigger AS $$
BEGIN
	IF TG_OP = 'INSERT' THEN
		IF EXISTS (
			SELECT 1 FROM "campaign_versions"
			WHERE "id" = NEW."campaign_version_id" AND "used_at" IS NOT NULL
		) THEN
			RAISE EXCEPTION 'sequence steps used by enrollments are immutable'
				USING ERRCODE = '23514';
		END IF;
	ELSIF TG_OP = 'DELETE' THEN
		IF EXISTS (
			SELECT 1 FROM "campaign_versions"
			WHERE "id" = OLD."campaign_version_id" AND "used_at" IS NOT NULL
		) THEN
			RAISE EXCEPTION 'sequence steps used by enrollments are immutable'
				USING ERRCODE = '23514';
		END IF;
	ELSE
		IF EXISTS (
			SELECT 1 FROM "campaign_versions"
			WHERE "id" IN (OLD."campaign_version_id", NEW."campaign_version_id")
				AND "used_at" IS NOT NULL
		) THEN
			RAISE EXCEPTION 'sequence steps used by enrollments are immutable'
				USING ERRCODE = '23514';
		END IF;
	END IF;
	RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
UPDATE "campaign_versions" AS version
SET "used_at" = usage."first_used_at"
FROM (
	SELECT "campaign_version_id", min("created_at") AS "first_used_at"
	FROM "enrollments"
	GROUP BY "campaign_version_id"
) AS usage
WHERE version."id" = usage."campaign_version_id"
	AND version."used_at" IS NULL;--> statement-breakpoint
CREATE FUNCTION "mark_campaign_version_used"() RETURNS trigger AS $$
BEGIN
	UPDATE "campaign_versions"
	SET "used_at" = NEW."created_at"
	WHERE "id" = NEW."campaign_version_id" AND "used_at" IS NULL;
	RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER "enrollments_mark_campaign_version_used"
	AFTER INSERT ON "enrollments"
	FOR EACH ROW EXECUTE FUNCTION "mark_campaign_version_used"();--> statement-breakpoint
CREATE FUNCTION "prevent_enrollment_identity_mutation"() RETURNS trigger AS $$
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
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER "enrollments_identity_immutable"
	BEFORE UPDATE ON "enrollments"
	FOR EACH ROW EXECUTE FUNCTION "prevent_enrollment_identity_mutation"();

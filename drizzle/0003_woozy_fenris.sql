ALTER TABLE "campaign_versions" ADD COLUMN "published_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "campaign_versions" DISABLE TRIGGER "campaign_versions_immutable_when_used";--> statement-breakpoint
UPDATE "campaign_versions"
SET "published_at" = "used_at"
WHERE "used_at" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "campaign_versions" ENABLE TRIGGER "campaign_versions_immutable_when_used";--> statement-breakpoint
CREATE OR REPLACE FUNCTION "prevent_used_campaign_version_mutation"() RETURNS trigger AS $$
BEGIN
	IF TG_OP = 'DELETE' THEN
		IF OLD."published_at" IS NOT NULL OR OLD."used_at" IS NOT NULL THEN
			RAISE EXCEPTION 'published or used campaign versions are immutable'
				USING ERRCODE = '23514';
		END IF;
		RETURN OLD;
	END IF;

	IF OLD."published_at" IS NOT NULL OR OLD."used_at" IS NOT NULL THEN
		IF OLD."used_at" IS NULL
			AND NEW."used_at" IS NOT NULL
			AND NEW."id" IS NOT DISTINCT FROM OLD."id"
			AND NEW."campaign_id" IS NOT DISTINCT FROM OLD."campaign_id"
			AND NEW."version" IS NOT DISTINCT FROM OLD."version"
			AND NEW."configuration" IS NOT DISTINCT FROM OLD."configuration"
			AND NEW."published_at" IS NOT DISTINCT FROM OLD."published_at"
			AND NEW."created_at" IS NOT DISTINCT FROM OLD."created_at" THEN
			RETURN NEW;
		END IF;
		RAISE EXCEPTION 'published or used campaign versions are immutable'
			USING ERRCODE = '23514';
	END IF;
	RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE OR REPLACE FUNCTION "prevent_used_sequence_step_mutation"() RETURNS trigger AS $$
BEGIN
	IF TG_OP = 'INSERT' THEN
		IF EXISTS (
			SELECT 1 FROM "campaign_versions"
			WHERE "id" = NEW."campaign_version_id"
				AND ("published_at" IS NOT NULL OR "used_at" IS NOT NULL)
		) THEN
			RAISE EXCEPTION 'published or used sequence steps are immutable'
				USING ERRCODE = '23514';
		END IF;
	ELSIF TG_OP = 'DELETE' THEN
		IF EXISTS (
			SELECT 1 FROM "campaign_versions"
			WHERE "id" = OLD."campaign_version_id"
				AND ("published_at" IS NOT NULL OR "used_at" IS NOT NULL)
		) THEN
			RAISE EXCEPTION 'published or used sequence steps are immutable'
				USING ERRCODE = '23514';
		END IF;
	ELSE
		IF EXISTS (
			SELECT 1 FROM "campaign_versions"
			WHERE "id" IN (OLD."campaign_version_id", NEW."campaign_version_id")
				AND ("published_at" IS NOT NULL OR "used_at" IS NOT NULL)
		) THEN
			RAISE EXCEPTION 'published or used sequence steps are immutable'
				USING ERRCODE = '23514';
		END IF;
	END IF;
	RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$ LANGUAGE plpgsql;

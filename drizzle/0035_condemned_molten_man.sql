CREATE TABLE "convention_demotions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"domain" text NOT NULL,
	"pattern" text NOT NULL,
	"demoted_at" timestamp with time zone NOT NULL,
	"people_proven_dead" integer NOT NULL,
	"people_attempted" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "convention_demotions_domain_pattern_unique" ON "convention_demotions" USING btree ("domain","pattern");--> statement-breakpoint
CREATE INDEX "convention_demotions_domain_idx" ON "convention_demotions" USING btree ("domain");
--> statement-breakpoint
-- Same ownership rule as every other table carrying `updated_at`: the
-- database sets it, never the application.
CREATE TRIGGER "convention_demotions_set_updated_at"
	BEFORE UPDATE ON "convention_demotions"
	FOR EACH ROW EXECUTE FUNCTION "set_updated_at"();

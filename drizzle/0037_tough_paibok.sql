ALTER TABLE "convention_demotions" ADD COLUMN "lifted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "convention_demotions" ADD COLUMN "lifted_by" text;--> statement-breakpoint
ALTER TABLE "convention_demotions" ADD COLUMN "lift_reason" text;--> statement-breakpoint
ALTER TABLE "convention_demotions" ADD CONSTRAINT "convention_demotions_lift_check" CHECK (("convention_demotions"."lifted_at" is null) = ("convention_demotions"."lifted_by" is null)
        and ("convention_demotions"."lifted_at" is null) = ("convention_demotions"."lift_reason" is null));
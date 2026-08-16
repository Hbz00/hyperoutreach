ALTER TABLE "messages" ADD COLUMN "send_requested_at" timestamp with time zone;--> statement-breakpoint
-- Rows already in flight when this shipped had a send requested before the
-- column existed. Recovery bounds itself on this clock, so leaving them null
-- would hand every in-flight message straight back to the operator. The best
-- available approximation is when their provider draft appeared, and failing
-- that when the row last moved.
UPDATE "messages" SET "send_requested_at" = COALESCE("drafted_at", "updated_at")
	WHERE "status" IN ('drafted', 'draft_creating', 'sending');

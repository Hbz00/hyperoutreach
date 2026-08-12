ALTER TABLE "inbound_records" ADD COLUMN "classification_claim_id" text;--> statement-breakpoint
ALTER TABLE "inbound_records" ADD COLUMN "classification_claimed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "inbound_records" ADD COLUMN "last_attempt_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "inbound_records_reconciliation_idx" ON "inbound_records" USING btree ("status","last_attempt_at","processed_at");--> statement-breakpoint
CREATE INDEX "inbound_records_classification_claimed_at_idx" ON "inbound_records" USING btree ("classification_claimed_at");
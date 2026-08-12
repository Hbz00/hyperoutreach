ALTER TABLE "graph_notification_receipts" ADD COLUMN "claim_id" text;--> statement-breakpoint
ALTER TABLE "graph_notification_receipts" ADD COLUMN "claimed_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "graph_notification_receipts_pending_idx" ON "graph_notification_receipts" USING btree ("processed_at","claimed_at");
DROP INDEX "graph_notification_receipts_pending_idx";--> statement-breakpoint
ALTER TABLE "graph_notification_receipts" ADD COLUMN "attempt_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "graph_notification_receipts" ADD COLUMN "next_attempt_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "graph_notification_receipts_pending_idx" ON "graph_notification_receipts" USING btree ("processed_at","next_attempt_at","claimed_at");
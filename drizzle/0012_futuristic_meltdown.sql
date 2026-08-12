ALTER TABLE "accounts" ADD COLUMN "research_claim_id" text;--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "research_claimed_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "accounts_research_claimed_at_idx" ON "accounts" USING btree ("research_claimed_at");
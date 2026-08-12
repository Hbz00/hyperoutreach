CREATE TABLE "graph_notification_receipts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"mailbox_id" uuid NOT NULL,
	"deduplication_key" text NOT NULL,
	"subscription_id" text NOT NULL,
	"resource_id" text NOT NULL,
	"change_type" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	"error" text
);
--> statement-breakpoint
CREATE TABLE "oauth_authorization_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" "mailbox_provider" NOT NULL,
	"state_hash" text NOT NULL,
	"encrypted_code_verifier" text NOT NULL,
	"redirect_uri" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "mailbox_connections" ADD COLUMN "access_token_ciphertext" text;--> statement-breakpoint
ALTER TABLE "mailbox_connections" ADD COLUMN "token_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "mailbox_connections" ADD COLUMN "granted_scopes" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "mailbox_connections" ADD COLUMN "subscription_client_state_hash" text;--> statement-breakpoint
ALTER TABLE "mailbox_connections" ADD COLUMN "subscription_resource" text;--> statement-breakpoint
ALTER TABLE "graph_notification_receipts" ADD CONSTRAINT "graph_notification_receipts_mailbox_id_mailbox_connections_id_fk" FOREIGN KEY ("mailbox_id") REFERENCES "public"."mailbox_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "graph_notification_receipts_dedup_unique" ON "graph_notification_receipts" USING btree ("deduplication_key");--> statement-breakpoint
CREATE INDEX "graph_notification_receipts_mailbox_received_idx" ON "graph_notification_receipts" USING btree ("mailbox_id","received_at");--> statement-breakpoint
CREATE UNIQUE INDEX "oauth_authorization_requests_state_hash_unique" ON "oauth_authorization_requests" USING btree ("state_hash");--> statement-breakpoint
CREATE INDEX "oauth_authorization_requests_expiry_idx" ON "oauth_authorization_requests" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "mailbox_connections_token_expiry_idx" ON "mailbox_connections" USING btree ("token_expires_at");--> statement-breakpoint
CREATE INDEX "mailbox_connections_subscription_expiry_idx" ON "mailbox_connections" USING btree ("subscription_expires_at");
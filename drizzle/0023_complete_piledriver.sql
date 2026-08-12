WITH ranked AS (
  SELECT "id", row_number() OVER (
    PARTITION BY "provider", "provider_user_id"
    ORDER BY "updated_at" DESC, "id"
  ) AS duplicate_rank
  FROM "mailbox_connections"
  WHERE "provider_user_id" IS NOT NULL
)
UPDATE "mailbox_connections" AS mailbox
SET
  "provider_user_id" = NULL,
  "status" = 'disconnected',
  "encrypted_refresh_token" = NULL,
  "access_token_ciphertext" = NULL,
  "token_expires_at" = NULL,
  "delta_link" = NULL,
  "subscription_id" = NULL,
  "subscription_expires_at" = NULL,
  "subscription_client_state_hash" = NULL,
  "subscription_resource" = NULL
FROM ranked
WHERE mailbox."id" = ranked."id" AND ranked.duplicate_rank > 1;
--> statement-breakpoint
CREATE UNIQUE INDEX "mailbox_connections_provider_user_unique" ON "mailbox_connections" USING btree ("provider","provider_user_id") WHERE "mailbox_connections"."provider_user_id" is not null;

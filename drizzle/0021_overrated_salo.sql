-- Pending authorization flows cannot be securely bound retroactively. They are
-- short-lived and safe to invalidate during this security migration.
DELETE FROM "oauth_authorization_requests";
ALTER TABLE "oauth_authorization_requests" ADD COLUMN "operator_binding_hash" text NOT NULL;
UPDATE "mailbox_connections"
SET "last_synced_at" = now() - interval '5 minutes'
WHERE "provider" = 'microsoft_graph' AND "last_synced_at" IS NULL;

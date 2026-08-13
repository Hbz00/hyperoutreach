ALTER TYPE "public"."mailbox_provider" ADD VALUE 'smtp_imap';--> statement-breakpoint
ALTER TABLE "mailbox_connections" RENAME COLUMN "delta_link" TO "sync_cursor";--> statement-breakpoint
ALTER TABLE "mailbox_connections" ADD COLUMN "encrypted_password" text;
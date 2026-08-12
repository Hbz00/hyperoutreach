CREATE TYPE "public"."account_research_status" AS ENUM('pending', 'in_progress', 'complete', 'failed');--> statement-breakpoint
CREATE TYPE "public"."agent_run_status" AS ENUM('started', 'succeeded', 'failed');--> statement-breakpoint
CREATE TYPE "public"."campaign_status" AS ENUM('draft', 'active', 'paused', 'completed', 'archived');--> statement-breakpoint
CREATE TYPE "public"."campaign_type" AS ENUM('customer_discovery', 'commercial_outreach', 'other');--> statement-breakpoint
CREATE TYPE "public"."contact_status" AS ENUM('discovered', 'researched', 'email_resolved', 'ready_for_review', 'approved', 'active_sequence', 'replied', 'bounced', 'opted_out', 'completed', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."email_candidate_status" AS ENUM('candidate', 'accepted', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."enrollment_state" AS ENUM('ready_for_review', 'approved', 'active', 'paused', 'replied', 'bounced', 'opted_out', 'completed', 'stopped', 'failed');--> statement-breakpoint
CREATE TYPE "public"."inbound_record_status" AS ENUM('received', 'processing', 'processed', 'failed', 'ignored');--> statement-breakpoint
CREATE TYPE "public"."mailbox_provider" AS ENUM('mock', 'microsoft_graph');--> statement-breakpoint
CREATE TYPE "public"."mailbox_status" AS ENUM('pending', 'available', 'degraded', 'disconnected', 'revoked');--> statement-breakpoint
CREATE TYPE "public"."message_direction" AS ENUM('outbound', 'inbound');--> statement-breakpoint
CREATE TYPE "public"."message_status" AS ENUM('proposed', 'approved', 'draft_creating', 'drafted', 'sending', 'sent', 'delivery_uncertain', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."reply_classification" AS ENUM('positive', 'negative', 'question', 'referral', 'out_of_office', 'unsubscribe', 'bounce', 'automated', 'unknown');--> statement-breakpoint
CREATE TYPE "public"."stop_reason" AS ENUM('positive_reply', 'negative_reply', 'question', 'referral', 'unsubscribe', 'hard_bounce', 'manual_stop', 'sequence_complete', 'recipient_suppressed', 'company_suppressed', 'campaign_inactive', 'mailbox_unavailable');--> statement-breakpoint
CREATE TYPE "public"."suppression_reason" AS ENUM('unsubscribe', 'hard_bounce', 'manual', 'legal');--> statement-breakpoint
CREATE TYPE "public"."suppression_scope" AS ENUM('email', 'domain');--> statement-breakpoint
CREATE TYPE "public"."workflow_event_status" AS ENUM('scheduled', 'started', 'succeeded', 'failed', 'cancelled', 'skipped');--> statement-breakpoint
CREATE TABLE "accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"normalized_name" text NOT NULL,
	"domain" text,
	"website" text,
	"industry" text,
	"employee_range" text,
	"country" text,
	"research_status" "account_research_status" DEFAULT 'pending' NOT NULL,
	"research_snapshot" jsonb,
	"researched_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent" text NOT NULL,
	"model" text NOT NULL,
	"prompt_version" text NOT NULL,
	"schema_version" text NOT NULL,
	"input" jsonb NOT NULL,
	"output" jsonb,
	"sources" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"token_usage" jsonb,
	"cost_usd" numeric(12, 6),
	"status" "agent_run_status" DEFAULT 'started' NOT NULL,
	"error" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "campaign_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"campaign_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"configuration" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "campaign_versions_version_check" CHECK ("campaign_versions"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "campaigns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"type" "campaign_type" NOT NULL,
	"status" "campaign_status" DEFAULT 'draft' NOT NULL,
	"target_description" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "contacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"first_name" text NOT NULL,
	"last_name" text NOT NULL,
	"full_name" text NOT NULL,
	"normalized_full_name" text NOT NULL,
	"job_title" text,
	"linkedin_url" text,
	"status" "contact_status" DEFAULT 'discovered' NOT NULL,
	"professional_relevance" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "email_candidates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"contact_id" uuid NOT NULL,
	"email" text NOT NULL,
	"normalized_email" text NOT NULL,
	"domain" text NOT NULL,
	"pattern" text,
	"confidence" numeric(4, 3) NOT NULL,
	"source" text NOT NULL,
	"status" "email_candidate_status" DEFAULT 'candidate' NOT NULL,
	"mx_valid" boolean,
	"evidence" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"verified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "email_candidates_confidence_check" CHECK ("email_candidates"."confidence" >= 0 and "email_candidates"."confidence" <= 1)
);
--> statement-breakpoint
CREATE TABLE "enrollments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"campaign_id" uuid NOT NULL,
	"campaign_version_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"mailbox_id" uuid,
	"state" "enrollment_state" DEFAULT 'ready_for_review' NOT NULL,
	"current_step" integer DEFAULT 0 NOT NULL,
	"next_action_at" timestamp with time zone,
	"last_message_at" timestamp with time zone,
	"last_reply_classification" "reply_classification",
	"stop_reason" "stop_reason",
	"stopped_at" timestamp with time zone,
	"approved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "enrollments_current_step_check" CHECK ("enrollments"."current_step" >= 0)
);
--> statement-breakpoint
CREATE TABLE "evidence_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid,
	"contact_id" uuid,
	"url" text NOT NULL,
	"title" text,
	"source_type" text NOT NULL,
	"retrieved_at" timestamp with time zone DEFAULT now() NOT NULL,
	"supports" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"confidence" numeric(4, 3),
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "evidence_sources_owner_check" CHECK ("evidence_sources"."account_id" is not null or "evidence_sources"."contact_id" is not null),
	CONSTRAINT "evidence_sources_confidence_check" CHECK ("evidence_sources"."confidence" is null or ("evidence_sources"."confidence" >= 0 and "evidence_sources"."confidence" <= 1))
);
--> statement-breakpoint
CREATE TABLE "inbound_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"mailbox_id" uuid NOT NULL,
	"provider_message_id" text NOT NULL,
	"provider_notification_id" text,
	"internet_message_id" text,
	"conversation_id" text,
	"event_type" text NOT NULL,
	"payload_hash" text NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	"status" "inbound_record_status" DEFAULT 'received' NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mailbox_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" "mailbox_provider" NOT NULL,
	"email" text NOT NULL,
	"normalized_email" text NOT NULL,
	"encrypted_refresh_token" text,
	"tenant_id" text,
	"provider_user_id" text,
	"status" "mailbox_status" DEFAULT 'pending' NOT NULL,
	"delta_link" text,
	"subscription_id" text,
	"subscription_expires_at" timestamp with time zone,
	"last_synced_at" timestamp with time zone,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"enrollment_id" uuid NOT NULL,
	"mailbox_id" uuid,
	"step_index" integer,
	"direction" "message_direction" NOT NULL,
	"outreach_id" text,
	"subject" text NOT NULL,
	"body" text NOT NULL,
	"sender" text,
	"recipient" text NOT NULL,
	"provider_draft_id" text,
	"provider_message_id" text,
	"internet_message_id" text,
	"conversation_id" text,
	"status" "message_status" NOT NULL,
	"headers" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"scheduled_at" timestamp with time zone,
	"approved_at" timestamp with time zone,
	"drafted_at" timestamp with time zone,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "messages_outbound_identity_check" CHECK ("messages"."direction" <> 'outbound' or ("messages"."step_index" is not null and "messages"."outreach_id" is not null)),
	CONSTRAINT "messages_attempt_count_check" CHECK ("messages"."attempt_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "replies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"inbound_record_id" uuid NOT NULL,
	"message_id" uuid,
	"enrollment_id" uuid,
	"agent_run_id" uuid,
	"body" text NOT NULL,
	"classification" "reply_classification" NOT NULL,
	"confidence" numeric(4, 3) NOT NULL,
	"terminates_sequence" boolean NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "replies_confidence_check" CHECK ("replies"."confidence" >= 0 and "replies"."confidence" <= 1)
);
--> statement-breakpoint
CREATE TABLE "sequence_steps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"campaign_version_id" uuid NOT NULL,
	"step_index" integer NOT NULL,
	"delay_minutes" integer NOT NULL,
	"subject_template" text NOT NULL,
	"body_template" text NOT NULL,
	"personalization_schema" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sequence_steps_index_check" CHECK ("sequence_steps"."step_index" >= 0),
	CONSTRAINT "sequence_steps_delay_check" CHECK ("sequence_steps"."delay_minutes" >= 0)
);
--> statement-breakpoint
CREATE TABLE "state_transitions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"from_state" text,
	"to_state" text NOT NULL,
	"reason" text,
	"actor" text DEFAULT 'system' NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "suppression_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"scope" "suppression_scope" NOT NULL,
	"normalized_value" text NOT NULL,
	"reason" "suppression_reason" NOT NULL,
	"source_reply_id" uuid,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "suppression_entries_value_check" CHECK (length(trim("suppression_entries"."normalized_value")) > 0 and "suppression_entries"."normalized_value" = lower("suppression_entries"."normalized_value"))
);
--> statement-breakpoint
CREATE TABLE "workflow_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"event" text NOT NULL,
	"workflow_name" text NOT NULL,
	"run_id" text,
	"idempotency_key" text,
	"status" "workflow_event_status" NOT NULL,
	"attempt" integer DEFAULT 1 NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"error" text,
	"scheduled_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workflow_events_attempt_check" CHECK ("workflow_events"."attempt" > 0)
);
--> statement-breakpoint
ALTER TABLE "campaign_versions" ADD CONSTRAINT "campaign_versions_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "campaign_versions_id_campaign_unique" ON "campaign_versions" USING btree ("id","campaign_id");--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_candidates" ADD CONSTRAINT "email_candidates_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enrollments" ADD CONSTRAINT "enrollments_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enrollments" ADD CONSTRAINT "enrollments_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enrollments" ADD CONSTRAINT "enrollments_mailbox_id_mailbox_connections_id_fk" FOREIGN KEY ("mailbox_id") REFERENCES "public"."mailbox_connections"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enrollments" ADD CONSTRAINT "enrollments_version_campaign_fk" FOREIGN KEY ("campaign_version_id","campaign_id") REFERENCES "public"."campaign_versions"("id","campaign_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence_sources" ADD CONSTRAINT "evidence_sources_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence_sources" ADD CONSTRAINT "evidence_sources_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbound_records" ADD CONSTRAINT "inbound_records_mailbox_id_mailbox_connections_id_fk" FOREIGN KEY ("mailbox_id") REFERENCES "public"."mailbox_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_enrollment_id_enrollments_id_fk" FOREIGN KEY ("enrollment_id") REFERENCES "public"."enrollments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_mailbox_id_mailbox_connections_id_fk" FOREIGN KEY ("mailbox_id") REFERENCES "public"."mailbox_connections"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "replies" ADD CONSTRAINT "replies_inbound_record_id_inbound_records_id_fk" FOREIGN KEY ("inbound_record_id") REFERENCES "public"."inbound_records"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "replies" ADD CONSTRAINT "replies_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "replies" ADD CONSTRAINT "replies_enrollment_id_enrollments_id_fk" FOREIGN KEY ("enrollment_id") REFERENCES "public"."enrollments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "replies" ADD CONSTRAINT "replies_agent_run_id_agent_runs_id_fk" FOREIGN KEY ("agent_run_id") REFERENCES "public"."agent_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sequence_steps" ADD CONSTRAINT "sequence_steps_campaign_version_id_campaign_versions_id_fk" FOREIGN KEY ("campaign_version_id") REFERENCES "public"."campaign_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "suppression_entries" ADD CONSTRAINT "suppression_entries_source_reply_id_replies_id_fk" FOREIGN KEY ("source_reply_id") REFERENCES "public"."replies"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "accounts_normalized_name_unique" ON "accounts" USING btree ("normalized_name");--> statement-breakpoint
CREATE UNIQUE INDEX "accounts_domain_unique" ON "accounts" USING btree ("domain") WHERE "accounts"."domain" is not null;--> statement-breakpoint
CREATE INDEX "accounts_research_status_idx" ON "accounts" USING btree ("research_status");--> statement-breakpoint
CREATE INDEX "agent_runs_agent_created_idx" ON "agent_runs" USING btree ("agent","created_at");--> statement-breakpoint
CREATE INDEX "agent_runs_status_idx" ON "agent_runs" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "campaign_versions_campaign_version_unique" ON "campaign_versions" USING btree ("campaign_id","version");--> statement-breakpoint
CREATE INDEX "campaigns_status_idx" ON "campaigns" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "contacts_account_name_unique" ON "contacts" USING btree ("account_id","normalized_full_name");--> statement-breakpoint
CREATE UNIQUE INDEX "contacts_linkedin_url_unique" ON "contacts" USING btree ("linkedin_url") WHERE "contacts"."linkedin_url" is not null;--> statement-breakpoint
CREATE INDEX "contacts_account_id_idx" ON "contacts" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "contacts_status_idx" ON "contacts" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "email_candidates_normalized_email_unique" ON "email_candidates" USING btree ("normalized_email");--> statement-breakpoint
CREATE INDEX "email_candidates_contact_id_idx" ON "email_candidates" USING btree ("contact_id");--> statement-breakpoint
CREATE INDEX "email_candidates_domain_idx" ON "email_candidates" USING btree ("domain");--> statement-breakpoint
CREATE UNIQUE INDEX "enrollments_campaign_contact_unique" ON "enrollments" USING btree ("campaign_id","contact_id");--> statement-breakpoint
CREATE INDEX "enrollments_due_idx" ON "enrollments" USING btree ("state","next_action_at");--> statement-breakpoint
CREATE INDEX "enrollments_contact_id_idx" ON "enrollments" USING btree ("contact_id");--> statement-breakpoint
CREATE INDEX "enrollments_mailbox_id_idx" ON "enrollments" USING btree ("mailbox_id");--> statement-breakpoint
CREATE UNIQUE INDEX "evidence_sources_owner_url_unique" ON "evidence_sources" USING btree ("account_id","contact_id","url");--> statement-breakpoint
CREATE INDEX "evidence_sources_account_id_idx" ON "evidence_sources" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "evidence_sources_contact_id_idx" ON "evidence_sources" USING btree ("contact_id");--> statement-breakpoint
CREATE UNIQUE INDEX "inbound_records_mailbox_provider_message_unique" ON "inbound_records" USING btree ("mailbox_id","provider_message_id");--> statement-breakpoint
CREATE UNIQUE INDEX "inbound_records_notification_unique" ON "inbound_records" USING btree ("mailbox_id","provider_notification_id") WHERE "inbound_records"."provider_notification_id" is not null;--> statement-breakpoint
CREATE INDEX "inbound_records_status_idx" ON "inbound_records" USING btree ("status");--> statement-breakpoint
CREATE INDEX "inbound_records_conversation_id_idx" ON "inbound_records" USING btree ("conversation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "mailbox_connections_provider_email_unique" ON "mailbox_connections" USING btree ("provider","normalized_email");--> statement-breakpoint
CREATE UNIQUE INDEX "mailbox_connections_subscription_unique" ON "mailbox_connections" USING btree ("subscription_id") WHERE "mailbox_connections"."subscription_id" is not null;--> statement-breakpoint
CREATE INDEX "mailbox_connections_status_idx" ON "mailbox_connections" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "messages_outreach_id_unique" ON "messages" USING btree ("outreach_id") WHERE "messages"."outreach_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "messages_mailbox_provider_draft_unique" ON "messages" USING btree ("mailbox_id","provider_draft_id") WHERE "messages"."mailbox_id" is not null and "messages"."provider_draft_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "messages_local_mock_provider_draft_unique" ON "messages" USING btree ("provider_draft_id") WHERE "messages"."mailbox_id" is null and "messages"."provider_draft_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "messages_mailbox_provider_message_unique" ON "messages" USING btree ("mailbox_id","provider_message_id") WHERE "messages"."mailbox_id" is not null and "messages"."provider_message_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "messages_local_mock_provider_message_unique" ON "messages" USING btree ("provider_message_id") WHERE "messages"."mailbox_id" is null and "messages"."provider_message_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "messages_enrollment_step_outbound_unique" ON "messages" USING btree ("enrollment_id","step_index") WHERE "messages"."direction" = 'outbound';--> statement-breakpoint
CREATE INDEX "messages_enrollment_id_idx" ON "messages" USING btree ("enrollment_id");--> statement-breakpoint
CREATE INDEX "messages_mailbox_id_idx" ON "messages" USING btree ("mailbox_id");--> statement-breakpoint
CREATE INDEX "messages_status_idx" ON "messages" USING btree ("status");--> statement-breakpoint
CREATE INDEX "messages_conversation_id_idx" ON "messages" USING btree ("conversation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "replies_inbound_record_unique" ON "replies" USING btree ("inbound_record_id");--> statement-breakpoint
CREATE INDEX "replies_enrollment_id_idx" ON "replies" USING btree ("enrollment_id");--> statement-breakpoint
CREATE INDEX "replies_classification_idx" ON "replies" USING btree ("classification");--> statement-breakpoint
CREATE UNIQUE INDEX "sequence_steps_version_index_unique" ON "sequence_steps" USING btree ("campaign_version_id","step_index");--> statement-breakpoint
CREATE INDEX "state_transitions_entity_created_idx" ON "state_transitions" USING btree ("entity_type","entity_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "suppression_entries_scope_value_unique" ON "suppression_entries" USING btree ("scope","normalized_value");--> statement-breakpoint
CREATE INDEX "suppression_entries_value_idx" ON "suppression_entries" USING btree ("normalized_value");--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_events_idempotency_key_unique" ON "workflow_events" USING btree ("idempotency_key") WHERE "workflow_events"."idempotency_key" is not null;--> statement-breakpoint
CREATE INDEX "workflow_events_entity_idx" ON "workflow_events" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "workflow_events_status_idx" ON "workflow_events" USING btree ("status");--> statement-breakpoint
CREATE INDEX "workflow_events_run_id_idx" ON "workflow_events" USING btree ("run_id");--> statement-breakpoint
CREATE FUNCTION "prevent_used_campaign_version_mutation"() RETURNS trigger AS $$
BEGIN
	IF EXISTS (
		SELECT 1 FROM "enrollments"
		WHERE "campaign_version_id" = OLD."id"
	) THEN
		RAISE EXCEPTION 'campaign versions used by enrollments are immutable'
			USING ERRCODE = '23514';
	END IF;
	RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER "campaign_versions_immutable_when_used"
	BEFORE UPDATE OR DELETE ON "campaign_versions"
	FOR EACH ROW EXECUTE FUNCTION "prevent_used_campaign_version_mutation"();--> statement-breakpoint
CREATE FUNCTION "prevent_used_sequence_step_mutation"() RETURNS trigger AS $$
DECLARE
	target_version_id uuid;
BEGIN
	target_version_id := CASE WHEN TG_OP = 'INSERT' THEN NEW."campaign_version_id" ELSE OLD."campaign_version_id" END;
	IF EXISTS (
		SELECT 1 FROM "enrollments"
		WHERE "campaign_version_id" = target_version_id
	) THEN
		RAISE EXCEPTION 'sequence steps used by enrollments are immutable'
			USING ERRCODE = '23514';
	END IF;
	RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER "sequence_steps_immutable_when_used"
	BEFORE INSERT OR UPDATE OR DELETE ON "sequence_steps"
	FOR EACH ROW EXECUTE FUNCTION "prevent_used_sequence_step_mutation"();

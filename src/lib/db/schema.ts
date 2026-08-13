import { sql } from "drizzle-orm";
import {
  boolean,
  integer,
  check,
  foreignKey,
  index,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
};

export const accountResearchStatus = pgEnum("account_research_status", [
  "pending",
  "in_progress",
  "complete",
  "failed",
]);
export const contactStatus = pgEnum("contact_status", [
  "discovered",
  "researched",
  "email_resolved",
  "ready_for_review",
  "approved",
  "active_sequence",
  "replied",
  "bounced",
  "opted_out",
  "completed",
  "rejected",
]);
export const emailCandidateStatus = pgEnum("email_candidate_status", [
  "candidate",
  "accepted",
  "rejected",
]);
export const emailResolutionStatus = pgEnum("email_resolution_status", [
  "unresolved",
  "resolved",
  "manual_review",
  "provider_error",
]);
export const emailResolutionReason = pgEnum("email_resolution_reason", [
  "missing_domain",
  "domain_not_evidenced",
  "insufficient_public_evidence",
  "low_confidence",
  "enrichment_no_result",
  "provider_transient_error",
  "mx_missing",
  "mx_lookup_failure",
  "candidate_conflict",
  "employment_changed",
  "stale_employment",
  "resolution_in_progress",
]);
export const campaignType = pgEnum("campaign_type", [
  "customer_discovery",
  "commercial_outreach",
  "other",
]);
export const campaignStatus = pgEnum("campaign_status", [
  "draft",
  "active",
  "paused",
  "completed",
  "archived",
]);
export const mailboxProvider = pgEnum("mailbox_provider", [
  "mock",
  "microsoft_graph",
  "smtp_imap",
]);
export const mailboxStatus = pgEnum("mailbox_status", [
  "pending",
  "available",
  "degraded",
  "disconnected",
  "revoked",
]);
export const enrollmentState = pgEnum("enrollment_state", [
  "ready_for_review",
  "approved",
  "active",
  "waiting",
  "manual_review",
  "paused",
  "replied",
  "bounced",
  "opted_out",
  "completed",
  "stopped",
  "failed",
]);
export const stopReason = pgEnum("stop_reason", [
  "positive_reply",
  "negative_reply",
  "question",
  "referral",
  "unsubscribe",
  "hard_bounce",
  "manual_stop",
  "sequence_complete",
  "recipient_suppressed",
  "company_suppressed",
  "campaign_inactive",
  "mailbox_unavailable",
  "employment_changed",
]);
export const bounceKind = pgEnum("bounce_kind", ["hard", "soft"]);
export const messageDirection = pgEnum("message_direction", [
  "outbound",
  "inbound",
]);
export const messageStatus = pgEnum("message_status", [
  "proposed",
  "approved",
  "draft_creating",
  "drafted",
  "sending",
  "sent",
  "delivery_uncertain",
  "failed",
  "cancelled",
]);
export const replyClassification = pgEnum("reply_classification", [
  "positive",
  "negative",
  "question",
  "referral",
  "out_of_office",
  "unsubscribe",
  "bounce",
  "automated",
  "unknown",
]);
export const suppressionScope = pgEnum("suppression_scope", [
  "email",
  "domain",
]);
export const suppressionReason = pgEnum("suppression_reason", [
  "unsubscribe",
  "hard_bounce",
  "manual",
  "legal",
]);
export const workflowEventStatus = pgEnum("workflow_event_status", [
  "scheduled",
  "started",
  "succeeded",
  "failed",
  "cancelled",
  "skipped",
]);
export const agentRunStatus = pgEnum("agent_run_status", [
  "started",
  "succeeded",
  "failed",
]);
export const inboundRecordStatus = pgEnum("inbound_record_status", [
  "received",
  "processing",
  "processed",
  "failed",
  "ignored",
]);

export const MICROSOFT_REQUIRED_SCOPES = [
  "Mail.ReadWrite",
  "Mail.Send",
] as const;

export const accounts = pgTable(
  "accounts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    name: text("name").notNull(),
    normalizedName: text("normalized_name").notNull(),
    domain: text("domain"),
    website: text("website"),
    industry: text("industry"),
    employeeRange: text("employee_range"),
    country: text("country"),
    researchStatus: accountResearchStatus("research_status")
      .default("pending")
      .notNull(),
    researchSnapshot:
      jsonb("research_snapshot").$type<Record<string, unknown>>(),
    researchedAt: timestamp("researched_at", { withTimezone: true }),
    researchClaimId: text("research_claim_id"),
    researchClaimedAt: timestamp("research_claimed_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("accounts_domainless_name_unique")
      .on(table.normalizedName)
      .where(sql`${table.domain} is null`),
    uniqueIndex("accounts_domain_unique")
      .on(table.domain)
      .where(sql`${table.domain} is not null`),
    index("accounts_research_status_idx").on(table.researchStatus),
    index("accounts_research_claimed_at_idx").on(table.researchClaimedAt),
  ],
);

export const contacts = pgTable(
  "contacts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "restrict" }),
    firstName: text("first_name").notNull(),
    lastName: text("last_name").notNull(),
    fullName: text("full_name").notNull(),
    normalizedFullName: text("normalized_full_name").notNull(),
    jobTitle: text("job_title"),
    linkedinUrl: text("linkedin_url"),
    status: contactStatus("status").default("discovered").notNull(),
    professionalRelevance: jsonb("professional_relevance").$type<
      Record<string, unknown>
    >(),
    emailResolutionStatus: emailResolutionStatus("email_resolution_status")
      .default("unresolved")
      .notNull(),
    emailResolutionAttemptedAt: timestamp("email_resolution_attempted_at", {
      withTimezone: true,
    }),
    emailResolutionError: text("email_resolution_error"),
    emailResolutionReason: emailResolutionReason("email_resolution_reason"),
    employmentVersion: integer("employment_version").default(1).notNull(),
    emailResolutionClaimId: text("email_resolution_claim_id"),
    emailResolutionClaimedAt: timestamp("email_resolution_claimed_at", {
      withTimezone: true,
    }),
    emailResolutionClaimAccountId: uuid("email_resolution_claim_account_id"),
    emailResolutionClaimEmploymentVersion: integer(
      "email_resolution_claim_employment_version",
    ),
    emailResolutionClaimDomain: text("email_resolution_claim_domain"),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("contacts_account_name_fallback_unique")
      .on(table.accountId, table.normalizedFullName)
      .where(sql`${table.linkedinUrl} is null`),
    uniqueIndex("contacts_linkedin_url_unique")
      .on(table.linkedinUrl)
      .where(sql`${table.linkedinUrl} is not null`),
    index("contacts_account_id_idx").on(table.accountId),
    index("contacts_status_idx").on(table.status),
    index("contacts_email_resolution_status_idx").on(
      table.emailResolutionStatus,
    ),
    index("contacts_email_resolution_claimed_at_idx").on(
      table.emailResolutionClaimedAt,
    ),
  ],
);

export const evidenceSources = pgTable(
  "evidence_sources",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    accountId: uuid("account_id").references(() => accounts.id, {
      onDelete: "cascade",
    }),
    contactId: uuid("contact_id").references(() => contacts.id, {
      onDelete: "cascade",
    }),
    url: text("url").notNull(),
    title: text("title"),
    sourceType: text("source_type").notNull(),
    retrievedAt: timestamp("retrieved_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    supports: jsonb("supports")
      .$type<string[]>()
      .default(sql`'[]'::jsonb`)
      .notNull(),
    confidence: numeric("confidence", { precision: 4, scale: 3 }),
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .default(sql`'{}'::jsonb`)
      .notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    check(
      "evidence_sources_owner_check",
      sql`num_nonnulls(${table.accountId}, ${table.contactId}) = 1`,
    ),
    check(
      "evidence_sources_confidence_check",
      sql`${table.confidence} is null or (${table.confidence} >= 0 and ${table.confidence} <= 1)`,
    ),
    uniqueIndex("evidence_sources_account_url_unique")
      .on(table.accountId, table.url)
      .where(sql`${table.accountId} is not null`),
    uniqueIndex("evidence_sources_contact_url_unique")
      .on(table.contactId, table.url)
      .where(sql`${table.contactId} is not null`),
    index("evidence_sources_account_id_idx").on(table.accountId),
    index("evidence_sources_contact_id_idx").on(table.contactId),
  ],
);

export const emailCandidates = pgTable(
  "email_candidates",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    contactId: uuid("contact_id")
      .notNull()
      .references(() => contacts.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    normalizedEmail: text("normalized_email").notNull(),
    domain: text("domain").notNull(),
    pattern: text("pattern"),
    confidence: numeric("confidence", { precision: 4, scale: 3 }).notNull(),
    source: text("source").notNull(),
    status: emailCandidateStatus("status").default("candidate").notNull(),
    mxValid: boolean("mx_valid"),
    evidence: jsonb("evidence")
      .$type<Record<string, unknown>>()
      .default(sql`'{}'::jsonb`)
      .notNull(),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("email_candidates_normalized_email_unique").on(
      table.normalizedEmail,
    ),
    uniqueIndex("email_candidates_one_accepted_per_contact_unique")
      .on(table.contactId)
      .where(sql`${table.status} = 'accepted'`),
    check(
      "email_candidates_confidence_check",
      sql`${table.confidence} >= 0 and ${table.confidence} <= 1`,
    ),
    index("email_candidates_contact_id_idx").on(table.contactId),
    index("email_candidates_domain_idx").on(table.domain),
  ],
);

export const campaigns = pgTable(
  "campaigns",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    name: text("name").notNull(),
    type: campaignType("type").notNull(),
    status: campaignStatus("status").default("draft").notNull(),
    targetDescription: text("target_description").notNull(),
    ...timestamps,
  },
  (table) => [index("campaigns_status_idx").on(table.status)],
);

export const campaignVersions = pgTable(
  "campaign_versions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    campaignId: uuid("campaign_id")
      .notNull()
      .references(() => campaigns.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    configuration: jsonb("configuration")
      .$type<Record<string, unknown>>()
      .default(sql`'{}'::jsonb`)
      .notNull(),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    usedAt: timestamp("used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("campaign_versions_campaign_version_unique").on(
      table.campaignId,
      table.version,
    ),
    uniqueIndex("campaign_versions_id_campaign_unique").on(
      table.id,
      table.campaignId,
    ),
    check("campaign_versions_version_check", sql`${table.version} > 0`),
  ],
);

export const sequenceSteps = pgTable(
  "sequence_steps",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    campaignVersionId: uuid("campaign_version_id")
      .notNull()
      .references(() => campaignVersions.id, { onDelete: "cascade" }),
    stepIndex: integer("step_index").notNull(),
    delayMinutes: integer("delay_minutes").notNull(),
    subjectTemplate: text("subject_template").notNull(),
    bodyTemplate: text("body_template").notNull(),
    personalizationSchema: jsonb("personalization_schema")
      .$type<Record<string, unknown>>()
      .default(sql`'{}'::jsonb`)
      .notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("sequence_steps_version_index_unique").on(
      table.campaignVersionId,
      table.stepIndex,
    ),
    check("sequence_steps_index_check", sql`${table.stepIndex} >= 0`),
    check("sequence_steps_delay_check", sql`${table.delayMinutes} >= 0`),
  ],
);

export const mailboxConnections = pgTable(
  "mailbox_connections",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    provider: mailboxProvider("provider").notNull(),
    email: text("email").notNull(),
    normalizedEmail: text("normalized_email").notNull(),
    encryptedRefreshToken: text("encrypted_refresh_token"),
    accessTokenCiphertext: text("access_token_ciphertext"),
    tokenExpiresAt: timestamp("token_expires_at", { withTimezone: true }),
    grantedScopes: jsonb("granted_scopes")
      .$type<string[]>()
      .default(sql`'[]'::jsonb`)
      .notNull(),
    tenantId: text("tenant_id"),
    providerUserId: text("provider_user_id"),
    status: mailboxStatus("status").default("pending").notNull(),
    syncCursor: text("sync_cursor"),
    encryptedPassword: text("encrypted_password"),
    subscriptionId: text("subscription_id"),
    subscriptionExpiresAt: timestamp("subscription_expires_at", {
      withTimezone: true,
    }),
    subscriptionClientStateHash: text("subscription_client_state_hash"),
    subscriptionResource: text("subscription_resource"),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
    settings: jsonb("settings")
      .$type<Record<string, unknown>>()
      .default(sql`'{}'::jsonb`)
      .notNull(),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("mailbox_connections_provider_email_unique").on(
      table.provider,
      table.normalizedEmail,
    ),
    uniqueIndex("mailbox_connections_provider_user_unique")
      .on(table.provider, table.providerUserId)
      .where(sql`${table.providerUserId} is not null`),
    uniqueIndex("mailbox_connections_subscription_unique")
      .on(table.subscriptionId)
      .where(sql`${table.subscriptionId} is not null`),
    index("mailbox_connections_status_idx").on(table.status),
    index("mailbox_connections_token_expiry_idx").on(table.tokenExpiresAt),
    index("mailbox_connections_subscription_expiry_idx").on(
      table.subscriptionExpiresAt,
    ),
  ],
);

export const oauthAuthorizationRequests = pgTable(
  "oauth_authorization_requests",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    provider: mailboxProvider("provider").notNull(),
    stateHash: text("state_hash").notNull(),
    encryptedCodeVerifier: text("encrypted_code_verifier").notNull(),
    operatorBindingHash: text("operator_binding_hash").notNull(),
    redirectUri: text("redirect_uri").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("oauth_authorization_requests_state_hash_unique").on(
      table.stateHash,
    ),
    index("oauth_authorization_requests_expiry_idx").on(table.expiresAt),
  ],
);

export const graphNotificationReceipts = pgTable(
  "graph_notification_receipts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    mailboxId: uuid("mailbox_id")
      .notNull()
      .references(() => mailboxConnections.id, { onDelete: "cascade" }),
    deduplicationKey: text("deduplication_key").notNull(),
    subscriptionId: text("subscription_id").notNull(),
    resourceId: text("resource_id").notNull(),
    changeType: text("change_type").notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    processedAt: timestamp("processed_at", { withTimezone: true }),
    claimId: text("claim_id"),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    attemptCount: integer("attempt_count").default(0).notNull(),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
    requiresReview: boolean("requires_review").default(false).notNull(),
    reviewResolvedAt: timestamp("review_resolved_at", { withTimezone: true }),
    error: text("error"),
  },
  (table) => [
    uniqueIndex("graph_notification_receipts_dedup_unique").on(
      table.deduplicationKey,
    ),
    index("graph_notification_receipts_mailbox_received_idx").on(
      table.mailboxId,
      table.receivedAt,
    ),
    index("graph_notification_receipts_pending_idx").on(
      table.processedAt,
      table.nextAttemptAt,
      table.claimedAt,
    ),
  ],
);

export const operatorSendingSettings = pgTable(
  "operator_sending_settings",
  {
    id: integer("id").primaryKey().default(1),
    emergencyPause: boolean("emergency_pause").default(false).notNull(),
    timezone: text("timezone").default("Europe/Paris").notNull(),
    workingDays: jsonb("working_days")
      .$type<number[]>()
      .default(sql`'[1,2,3,4,5]'::jsonb`)
      .notNull(),
    workingStartMinute: integer("working_start_minute").default(540).notNull(),
    workingEndMinute: integer("working_end_minute").default(1080).notNull(),
    mailboxDailyCap: integer("mailbox_daily_cap").default(25).notNull(),
    campaignDailyCap: integer("campaign_daily_cap").default(100).notNull(),
    mailboxMinimumDelaySeconds: integer("mailbox_minimum_delay_seconds")
      .default(60)
      .notNull(),
    contactMinimumDelayMinutes: integer("contact_minimum_delay_minutes")
      .default(1_440)
      .notNull(),
    crossCampaignCooldownDays: integer("cross_campaign_cooldown_days")
      .default(30)
      .notNull(),
    ...timestamps,
  },
  (table) => [
    check("operator_sending_settings_singleton_check", sql`${table.id} = 1`),
    check(
      "operator_sending_settings_working_hours_check",
      sql`${table.workingStartMinute} >= 0 and ${table.workingStartMinute} < ${table.workingEndMinute} and ${table.workingEndMinute} <= 1440`,
    ),
    check(
      "operator_sending_settings_limits_check",
      sql`${table.mailboxDailyCap} > 0 and ${table.campaignDailyCap} > 0 and ${table.mailboxMinimumDelaySeconds} >= 0 and ${table.contactMinimumDelayMinutes} >= 0 and ${table.crossCampaignCooldownDays} >= 0`,
    ),
  ],
);

export const enrollments = pgTable(
  "enrollments",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    campaignId: uuid("campaign_id")
      .notNull()
      .references(() => campaigns.id, { onDelete: "restrict" }),
    campaignVersionId: uuid("campaign_version_id").notNull(),
    contactId: uuid("contact_id")
      .notNull()
      .references(() => contacts.id, { onDelete: "restrict" }),
    mailboxId: uuid("mailbox_id").references(() => mailboxConnections.id, {
      onDelete: "restrict",
    }),
    state: enrollmentState("state").default("ready_for_review").notNull(),
    currentStep: integer("current_step").default(0).notNull(),
    nextActionAt: timestamp("next_action_at", { withTimezone: true }),
    nextActionToken: text("next_action_token"),
    lastMessageAt: timestamp("last_message_at", { withTimezone: true }),
    lastReplyClassification: replyClassification("last_reply_classification"),
    stopReason: stopReason("stop_reason"),
    stoppedAt: timestamp("stopped_at", { withTimezone: true }),
    softBounceCount: integer("soft_bounce_count").default(0).notNull(),
    inboundHoldCount: integer("inbound_hold_count").default(0).notNull(),
    inboundHoldAt: timestamp("inbound_hold_at", { withTimezone: true }),
    inboundHoldPreviousState: enrollmentState("inbound_hold_previous_state"),
    inboundHoldPreviousNextActionAt: timestamp(
      "inbound_hold_previous_next_action_at",
      { withTimezone: true },
    ),
    inboundHoldPreviousNextActionToken: text(
      "inbound_hold_previous_next_action_token",
    ),
    workflowClaimId: text("workflow_claim_id"),
    workflowClaimedAt: timestamp("workflow_claimed_at", {
      withTimezone: true,
    }),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("enrollments_campaign_contact_unique").on(
      table.campaignId,
      table.contactId,
    ),
    foreignKey({
      name: "enrollments_version_campaign_fk",
      columns: [table.campaignVersionId, table.campaignId],
      foreignColumns: [campaignVersions.id, campaignVersions.campaignId],
    }).onDelete("restrict"),
    check("enrollments_current_step_check", sql`${table.currentStep} >= 0`),
    check(
      "enrollments_soft_bounce_count_check",
      sql`${table.softBounceCount} >= 0`,
    ),
    check(
      "enrollments_inbound_hold_count_check",
      sql`${table.inboundHoldCount} >= 0`,
    ),
    uniqueIndex("enrollments_next_action_token_unique")
      .on(table.nextActionToken)
      .where(sql`${table.nextActionToken} is not null`),
    index("enrollments_due_idx").on(table.state, table.nextActionAt),
    index("enrollments_contact_id_idx").on(table.contactId),
    index("enrollments_mailbox_id_idx").on(table.mailboxId),
    index("enrollments_workflow_claimed_at_idx").on(table.workflowClaimedAt),
  ],
);

export const messages = pgTable(
  "messages",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    enrollmentId: uuid("enrollment_id")
      .notNull()
      .references(() => enrollments.id, { onDelete: "restrict" }),
    mailboxId: uuid("mailbox_id").references(() => mailboxConnections.id, {
      onDelete: "restrict",
    }),
    stepIndex: integer("step_index"),
    direction: messageDirection("direction").notNull(),
    outreachId: text("outreach_id"),
    subject: text("subject").notNull(),
    body: text("body").notNull(),
    sender: text("sender"),
    recipient: text("recipient").notNull(),
    contactAccountId: uuid("contact_account_id").references(() => accounts.id, {
      onDelete: "restrict",
    }),
    employmentVersion: integer("employment_version"),
    providerDraftId: text("provider_draft_id"),
    providerMessageId: text("provider_message_id"),
    internetMessageId: text("internet_message_id"),
    conversationId: text("conversation_id"),
    status: messageStatus("status").notNull(),
    headers: jsonb("headers")
      .$type<Record<string, string>>()
      .default(sql`'{}'::jsonb`)
      .notNull(),
    attemptCount: integer("attempt_count").default(0).notNull(),
    sendAttemptToken: text("send_attempt_token"),
    sendClaimedAt: timestamp("send_claimed_at", { withTimezone: true }),
    sendAttemptedAt: timestamp("send_attempted_at", { withTimezone: true }),
    lastError: text("last_error"),
    scheduledAt: timestamp("scheduled_at", { withTimezone: true }),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    draftedAt: timestamp("drafted_at", { withTimezone: true }),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("messages_outreach_id_unique")
      .on(table.outreachId)
      .where(sql`${table.outreachId} is not null`),
    uniqueIndex("messages_mailbox_provider_draft_unique")
      .on(table.mailboxId, table.providerDraftId)
      .where(
        sql`${table.mailboxId} is not null and ${table.providerDraftId} is not null`,
      ),
    uniqueIndex("messages_local_mock_provider_draft_unique")
      .on(table.providerDraftId)
      .where(
        sql`${table.mailboxId} is null and ${table.providerDraftId} is not null`,
      ),
    uniqueIndex("messages_mailbox_provider_message_unique")
      .on(table.mailboxId, table.providerMessageId)
      .where(
        sql`${table.mailboxId} is not null and ${table.providerMessageId} is not null`,
      ),
    uniqueIndex("messages_local_mock_provider_message_unique")
      .on(table.providerMessageId)
      .where(
        sql`${table.mailboxId} is null and ${table.providerMessageId} is not null`,
      ),
    uniqueIndex("messages_send_attempt_token_unique")
      .on(table.sendAttemptToken)
      .where(sql`${table.sendAttemptToken} is not null`),
    uniqueIndex("messages_enrollment_step_outbound_unique")
      .on(table.enrollmentId, table.stepIndex)
      .where(sql`${table.direction} = 'outbound'`),
    check(
      "messages_outbound_identity_check",
      sql`${table.direction} <> 'outbound' or (${table.stepIndex} is not null and ${table.outreachId} is not null)`,
    ),
    check(
      "messages_outbound_employment_binding_check",
      sql`${table.direction} <> 'outbound' or (${table.contactAccountId} is not null and ${table.employmentVersion} is not null and ${table.employmentVersion} > 0)`,
    ),
    check("messages_attempt_count_check", sql`${table.attemptCount} >= 0`),
    index("messages_enrollment_id_idx").on(table.enrollmentId),
    index("messages_mailbox_id_idx").on(table.mailboxId),
    index("messages_status_idx").on(table.status),
    index("messages_conversation_id_idx").on(table.conversationId),
    index("messages_internet_message_id_idx").on(table.internetMessageId),
    index("messages_sent_history_idx").on(
      table.direction,
      table.status,
      table.sentAt,
    ),
    index("messages_send_attempted_at_idx").on(table.sendAttemptedAt),
  ],
);

export const inboundRecords = pgTable(
  "inbound_records",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    mailboxId: uuid("mailbox_id")
      .notNull()
      .references(() => mailboxConnections.id, { onDelete: "cascade" }),
    providerMessageId: text("provider_message_id").notNull(),
    providerNotificationId: text("provider_notification_id"),
    outreachId: text("outreach_id"),
    internetMessageId: text("internet_message_id"),
    conversationId: text("conversation_id"),
    inReplyTo: text("in_reply_to"),
    references: jsonb("references")
      .$type<string[]>()
      .default(sql`'[]'::jsonb`)
      .notNull(),
    eventType: text("event_type").notNull(),
    payloadHash: text("payload_hash").notNull(),
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .default(sql`'{}'::jsonb`)
      .notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    processedAt: timestamp("processed_at", { withTimezone: true }),
    status: inboundRecordStatus("status").default("received").notNull(),
    error: text("error"),
    classificationClaimId: text("classification_claim_id"),
    classificationClaimedAt: timestamp("classification_claimed_at", {
      withTimezone: true,
    }),
    lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("inbound_records_mailbox_provider_message_unique").on(
      table.mailboxId,
      table.providerMessageId,
    ),
    uniqueIndex("inbound_records_notification_unique")
      .on(table.mailboxId, table.providerNotificationId)
      .where(sql`${table.providerNotificationId} is not null`),
    index("inbound_records_status_idx").on(table.status),
    index("inbound_records_reconciliation_idx").on(
      table.status,
      table.lastAttemptAt,
      table.processedAt,
    ),
    index("inbound_records_classification_claimed_at_idx").on(
      table.classificationClaimedAt,
    ),
    index("inbound_records_outreach_id_idx").on(table.outreachId),
    index("inbound_records_conversation_id_idx").on(table.conversationId),
    index("inbound_records_in_reply_to_idx").on(table.inReplyTo),
  ],
);

export const agentRuns = pgTable(
  "agent_runs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    agent: text("agent").notNull(),
    responseId: text("response_id"),
    model: text("model").notNull(),
    promptVersion: text("prompt_version").notNull(),
    schemaVersion: text("schema_version").notNull(),
    input: jsonb("input").$type<Record<string, unknown>>().notNull(),
    output: jsonb("output").$type<Record<string, unknown>>(),
    sources: jsonb("sources")
      .$type<Array<Record<string, unknown>>>()
      .default(sql`'[]'::jsonb`)
      .notNull(),
    tokenUsage: jsonb("token_usage").$type<Record<string, number>>(),
    toolUsage: jsonb("tool_usage").$type<Record<string, number>>(),
    costUsd: numeric("cost_usd", { precision: 12, scale: 6 }),
    costAvailability: text("cost_availability").$type<
      "available" | "unavailable"
    >(),
    status: agentRunStatus("status").default("started").notNull(),
    error: text("error"),
    startedAt: timestamp("started_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    check(
      "agent_runs_cost_availability_check",
      sql`${table.costAvailability} is null or ${table.costAvailability} in ('available', 'unavailable')`,
    ),
    index("agent_runs_agent_created_idx").on(table.agent, table.createdAt),
    index("agent_runs_status_idx").on(table.status),
  ],
);

export const replies = pgTable(
  "replies",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    inboundRecordId: uuid("inbound_record_id")
      .notNull()
      .references(() => inboundRecords.id, { onDelete: "restrict" }),
    messageId: uuid("message_id").references(() => messages.id, {
      onDelete: "restrict",
    }),
    enrollmentId: uuid("enrollment_id").references(() => enrollments.id, {
      onDelete: "restrict",
    }),
    agentRunId: uuid("agent_run_id").references(() => agentRuns.id, {
      onDelete: "set null",
    }),
    body: text("body").notNull(),
    classification: replyClassification("classification").notNull(),
    confidence: numeric("confidence", { precision: 4, scale: 3 }).notNull(),
    classificationReason: text("classification_reason").notNull(),
    classifier: text("classifier").notNull(),
    bounceKind: bounceKind("bounce_kind"),
    sender: text("sender").notNull(),
    subject: text("subject").notNull(),
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .default(sql`'{}'::jsonb`)
      .notNull(),
    terminatesSequence: boolean("terminates_sequence").notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("replies_inbound_record_unique").on(table.inboundRecordId),
    check(
      "replies_confidence_check",
      sql`${table.confidence} >= 0 and ${table.confidence} <= 1`,
    ),
    index("replies_enrollment_id_idx").on(table.enrollmentId),
    index("replies_classification_idx").on(table.classification),
  ],
);

export const suppressionEntries = pgTable(
  "suppression_entries",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    scope: suppressionScope("scope").notNull(),
    normalizedValue: text("normalized_value").notNull(),
    reason: suppressionReason("reason").notNull(),
    sourceReplyId: uuid("source_reply_id").references(() => replies.id, {
      onDelete: "set null",
    }),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("suppression_entries_scope_value_unique").on(
      table.scope,
      table.normalizedValue,
    ),
    check(
      "suppression_entries_value_check",
      sql`length(trim(${table.normalizedValue})) > 0 and ${table.normalizedValue} = lower(${table.normalizedValue})`,
    ),
    index("suppression_entries_value_idx").on(table.normalizedValue),
  ],
);

export const workflowEvents = pgTable(
  "workflow_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    entityType: text("entity_type").notNull(),
    entityId: uuid("entity_id").notNull(),
    event: text("event").notNull(),
    workflowName: text("workflow_name").notNull(),
    runId: text("run_id"),
    idempotencyKey: text("idempotency_key"),
    status: workflowEventStatus("status").notNull(),
    attempt: integer("attempt").default(1).notNull(),
    payload: jsonb("payload")
      .$type<Record<string, unknown>>()
      .default(sql`'{}'::jsonb`)
      .notNull(),
    error: text("error"),
    scheduledAt: timestamp("scheduled_at", { withTimezone: true }),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("workflow_events_idempotency_key_unique")
      .on(table.idempotencyKey)
      .where(sql`${table.idempotencyKey} is not null`),
    check("workflow_events_attempt_check", sql`${table.attempt} > 0`),
    index("workflow_events_entity_idx").on(table.entityType, table.entityId),
    index("workflow_events_status_idx").on(table.status),
    index("workflow_events_run_id_idx").on(table.runId),
  ],
);

export const stateTransitions = pgTable(
  "state_transitions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    entityType: text("entity_type").notNull(),
    entityId: uuid("entity_id").notNull(),
    fromState: text("from_state"),
    toState: text("to_state").notNull(),
    reason: text("reason"),
    actor: text("actor").default("system").notNull(),
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .default(sql`'{}'::jsonb`)
      .notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("state_transitions_entity_created_idx").on(
      table.entityType,
      table.entityId,
      table.createdAt,
    ),
  ],
);

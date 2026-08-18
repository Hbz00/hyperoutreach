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
  /**
   * Every evidenced address for this person has been tried and proven dead.
   *
   * Distinct from `insufficient_public_evidence`, which means nobody ever found
   * an address to try, and from `ladder_limit_reached`, which means one is still
   * standing. The operator asked for an outcome that reads as "no further
   * address to try" rather than as a generic failure, and this is it.
   */
  "ladder_exhausted",
  /**
   * An untried address remains, but a ladder bound stopped the attempt.
   *
   * Every bound this names is one the operator sets and can raise, so the
   * enrollment is parked rather than ended: raising the bound and resolving the
   * company again is a working way back, and a reason that reads as actionable
   * must not sit on a prospect who is actually finished.
   */
  "ladder_limit_reached",
  /**
   * An earlier message to this person was never reported undelivered, so no
   * further address is tried.
   *
   * Kept apart from `ladder_limit_reached` because nothing the operator changes
   * alters it: this is the rule that a person who may be holding a message is
   * never re-addressed, and inviting them to raise a bound would be a wrong
   * instruction rather than an unhelpful one.
   */
  "ladder_earlier_send_unconfirmed",
  /**
   * Every evidenced address for this person is suppressed.
   *
   * Reachable because a suppression is permanent and keyed on the address alone:
   * a colleague's failed guess can own the address this person's convention
   * produces. Naming it is what turns a silent refusal at send time into
   * something the operator can act on.
   */
  "address_suppressed",
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
    /**
     * This address's position in the contact's ordered ladder, from 1.
     *
     * Persisted rather than recomputed from `confidence` on every read, for two
     * reasons. It is the record of the order the evidence produced at the moment
     * it was read, which is what an audit trail is for; and a demotion reorders
     * rungs without touching a single confidence, so confidence alone stops
     * being able to express the order.
     */
    ladderRank: integer("ladder_rank").default(1).notNull(),
    /**
     * When a send to this address was first durably attempted.
     *
     * The denominator of every rate the delivery-outcome loop computes — never
     * "delivered", which is a fact this product cannot establish. It is also what
     * the per-contact rung ceiling counts, because the ceiling bounds addresses
     * spent, not advances taken.
     */
    firstAttemptedAt: timestamp("first_attempted_at", { withTimezone: true }),
    /**
     * When this address was proven not to exist.
     *
     * Only a hard delivery failure writes it. Silence never does, in either
     * direction: a send that produced no failure says nothing about whether the
     * address was right, so it leaves this null forever.
     */
    deadAt: timestamp("dead_at", { withTimezone: true }),
    /** The message whose failure proved it. */
    deadMessageId: uuid("dead_message_id"),
    /**
     * When the ladder advanced to this rung, as opposed to resolution picking it
     * first. Null on rung one and on a rung reached by re-ranking rather than by
     * a death, so the per-company daily advance bound counts advances and
     * nothing else.
     */
    advancedAt: timestamp("advanced_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("email_candidates_normalized_email_unique").on(
      table.normalizedEmail,
    ),
    uniqueIndex("email_candidates_one_accepted_per_contact_unique")
      .on(table.contactId)
      .where(sql`${table.status} = 'accepted'`),
    foreignKey({
      name: "email_candidates_dead_message_fk",
      columns: [table.deadMessageId],
      foreignColumns: [messages.id],
    }).onDelete("set null"),
    check(
      "email_candidates_confidence_check",
      sql`${table.confidence} >= 0 and ${table.confidence} <= 1`,
    ),
    check("email_candidates_ladder_rank_check", sql`${table.ladderRank} >= 1`),
    check(
      "email_candidates_dead_message_check",
      sql`${table.deadMessageId} is null or ${table.deadAt} is not null`,
    ),
    index("email_candidates_contact_id_idx").on(table.contactId),
    index("email_candidates_domain_idx").on(table.domain),
    // The delivery record of one convention, which is read per company on every
    // resolution to decide whether that convention has been demoted.
    index("email_candidates_pattern_dead_idx").on(table.pattern, table.deadAt),
  ],
);

/**
 * A convention this domain's own delivery record has discredited, latched.
 *
 * Demotion was a live ratio over every attempt ever made, and a live ratio can
 * fall: two deaths out of four attempts demotes, and four more attempts that
 * reported nothing brought it back under the threshold and un-demoted it. That
 * is silence acting as confirmation, which is the one thing this product's
 * delivery loop must never allow — it can prove an address dead and it can
 * never prove one alive.
 *
 * So the moment the threshold is met the verdict is written here, with the
 * counts that produced it, and it stays. Reading a domain's demoted conventions
 * is this table unioned with the live ratio: the latch can only add.
 *
 * A demotion reorders and never removes, so the cost of a latch that ages badly
 * is that one convention sits at the back of the ladder at one domain. The cost
 * of dilution is a convention delivery discredited being offered first again.
 */
export const conventionDemotions = pgTable(
  "convention_demotions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    /** The mail domain, never the account: an account can move, a domain cannot. */
    domain: text("domain").notNull(),
    pattern: text("pattern").notNull(),
    demotedAt: timestamp("demoted_at", { withTimezone: true }).notNull(),
    /** The evidence as it stood when the verdict was reached. */
    peopleProvenDead: integer("people_proven_dead").notNull(),
    peopleAttempted: integer("people_attempted").notNull(),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("convention_demotions_domain_pattern_unique").on(
      table.domain,
      table.pattern,
    ),
    index("convention_demotions_domain_idx").on(table.domain),
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
    /**
     * Whether a proven-dead address may advance to the next evidenced one.
     *
     * On by default, because turning it off costs a reachable prospect and
     * turning it on costs nothing by itself: every send an advance leads to is
     * still one the operator approved.
     */
    addressLadderEnabled: boolean("address_ladder_enabled")
      .default(true)
      .notNull(),
    /** How many addresses one contact may cost, counted as addresses attempted. */
    addressLadderMaxRungs: integer("address_ladder_max_rungs")
      .default(3)
      .notNull(),
    /**
     * How many advances one company may produce in a day.
     *
     * The bound nothing else provides — the mailbox cap and pacing delay already
     * bound the sends — and the one that makes the demotion loop useful: at two a
     * day, a wrong convention reaches the two-distinct-people demotion threshold
     * before a third colleague is offered it.
     */
    addressLadderMaxAdvancesPerAccountPerDay: integer(
      "address_ladder_max_advances_per_account_per_day",
    )
      .default(2)
      .notNull(),
    /**
     * The share of attempted sends producing an explicit delivery failure at
     * which the ladder stops advancing at all, and the sample below which that
     * share is not a measurement. One failure out of one send is 100% and means
     * nothing.
     */
    addressLadderFailureRatePercent: integer(
      "address_ladder_failure_rate_percent",
    )
      .default(30)
      .notNull(),
    addressLadderFailureRateMinimumSends: integer(
      "address_ladder_failure_rate_minimum_sends",
    )
      .default(20)
      .notNull(),
    /**
     * What it takes to demote a convention at one company: this many distinct
     * people proven dead on it, and that many being at least this share of the
     * attempts it has had there.
     *
     * The share is the confound guard. A hard bounce cannot tell a wrong address
     * shape from a person who has left, so at a company whose contact data is
     * stale a *correct* convention fails a few times out of many — and a rule
     * counting failures alone would demote true conventions hardest exactly where
     * discovery is weakest.
     */
    addressLadderDemotionMinimumPeople: integer(
      "address_ladder_demotion_minimum_people",
    )
      .default(2)
      .notNull(),
    addressLadderDemotionFailureSharePercent: integer(
      "address_ladder_demotion_failure_share_percent",
    )
      .default(50)
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
    check(
      "operator_sending_settings_ladder_check",
      sql`${table.addressLadderMaxRungs} >= 1
        and ${table.addressLadderMaxAdvancesPerAccountPerDay} >= 0
        and ${table.addressLadderFailureRatePercent} between 1 and 100
        and ${table.addressLadderFailureRateMinimumSends} >= 1
        and ${table.addressLadderDemotionMinimumPeople} >= 2
        and ${table.addressLadderDemotionFailureSharePercent} between 1 and 100`,
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
    /**
     * When somebody asked for this message to go out. Stamped inside the send
     * claim, and only when the pre-claim status is `approved` — the one status
     * a request can start from, and the one recovery never claims from. A
     * request stamps it; a resumption does not.
     *
     * The scheduled-send lane also claims from `approved`, and also stamps.
     * That is right, not a leak: the operator asked, the system only waited
     * for the instant their own policy allows, and the completion window
     * should bound that delivery exactly as it bounds a direct click. What
     * stays impossible is a stamp with no human gesture behind it — the lane
     * selects on `scheduledAt`, which nothing but a click writes.
     *
     * Recovery reads this column to bound how long it may keep completing a
     * request, so it must never be confused with `draftedAt` (when a provider
     * draft first existed, never refreshed) or with `scheduledAt` (a request
     * pending a future instant).
     */
    sendRequestedAt: timestamp("send_requested_at", { withTimezone: true }),
    sendAttemptedAt: timestamp("send_attempted_at", { withTimezone: true }),
    lastError: text("last_error"),
    /**
     * When the scheduled-send lane may next try this message.
     *
     * Written only by an operator's Send click that the policy refused for a
     * reason time alone will lift, and moved forward as the lane re-checks. It
     * is the discriminator that keeps the lane safe: a message that is merely
     * approved carries null here and no worker path can select it.
     *
     * Not `sendRequestedAt`, which records that a send is in flight now, and
     * not a substitute for it: the two answer different questions and item 0
     * depends on the difference.
     */
    scheduledAt: timestamp("scheduled_at", { withTimezone: true }),
    /**
     * When the intent gives up, fixed at the click and never moved.
     *
     * Separate from `scheduledAt` because one column cannot both be pushed
     * forward on every re-check and remain the anchor the lifetime is measured
     * from. Derived from the first instant the calendar actually opens, not
     * from the click: a Friday-evening click opens on Monday, so a lifetime
     * counted from the click would expire over the weekend without ever having
     * been triable.
     */
    sendIntentExpiresAt: timestamp("send_intent_expires_at", {
      withTimezone: true,
    }),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    draftedAt: timestamp("drafted_at", { withTimezone: true }),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    /**
     * When this message's recipient address was proven not to exist.
     *
     * Written only by a hard delivery failure — an explicit hard bounce, or a
     * definite SMTP recipient refusal — and it is the marker that separates the
     * two facts a bounce used to conflate: the address is dead, the person is
     * not. Three things read it:
     *
     * - the step-uniqueness index below, which counts only live messages, so a
     *   step whose address was proven dead can be re-addressed exactly once;
     * - the send policy's `STEP_ALREADY_SENT` check, because a step sent to an
     *   address that turned out not to exist was not delivered;
     * - the follow-up path's "which address did the previous step use", which
     *   must never answer with a suppressed one.
     *
     * `status` cannot carry this. A message that was accepted by the provider
     * and bounced later stays `sent`, which is true and is exactly why it needs
     * a second column.
     */
    addressDeadAt: timestamp("address_dead_at", { withTimezone: true }),
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
    /**
     * One live outbound message per enrollment step.
     *
     * The duplicate-send guarantee, narrowed by exactly one fact rather than
     * relaxed: a message whose address was *proven not to exist* no longer holds
     * its step, because nothing was delivered to hold it with. Every other
     * message still does, including one whose delivery is merely uncertain —
     * that one may have arrived, and the whole point of this index is that such
     * a step is never written twice.
     */
    uniqueIndex("messages_enrollment_step_outbound_unique")
      .on(table.enrollmentId, table.stepIndex)
      .where(
        sql`${table.direction} = 'outbound' and ${table.addressDeadAt} is null`,
      ),
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
    index("messages_address_dead_at_idx").on(table.addressDeadAt),
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
    /**
     * The lane's reasoning effort, as configured when the turn started.
     *
     * Both lanes run the same model, so the model alone cannot tell a
     * ten-minute web-capable research turn from a two-minute fast one — which
     * is exactly what you need to know when a run fails on its deadline.
     *
     * Nullable because the mock agents have no lane and rows written before
     * this column existed have no answer. Never backfilled: the effort of a
     * past run is not recoverable, and guessing it would be worse than the
     * blank.
     */
    effort: text("effort"),
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
    // "Did anything come back on this send?" is asked once per outbound message
    // in the breaker's window, and answering it is what separates silence from
    // a mailbox that exists.
    index("replies_message_id_idx").on(table.messageId),
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
    index("workflow_events_workflow_created_idx").on(
      table.workflowName,
      table.createdAt,
    ),
  ],
);

export const maintenanceState = pgTable(
  "maintenance_state",
  {
    id: integer("id").default(1).primaryKey(),
    ownerToken: text("owner_token"),
    cycleStartedAt: timestamp("cycle_started_at", { withTimezone: true }),
    heartbeatAt: timestamp("heartbeat_at", { withTimezone: true }),
    lastSucceededAt: timestamp("last_succeeded_at", { withTimezone: true }),
    lastFailedAt: timestamp("last_failed_at", { withTimezone: true }),
    lastError: text("last_error"),
    ...timestamps,
  },
  (table) => [check("maintenance_state_singleton_check", sql`${table.id} = 1`)],
);

/**
 * There is no separate `failed`. A failure with attempts left is `queued`
 * again with a later `next_attempt_at`; a failure with none left is
 * `abandoned` and carries its reason. A second terminal-failure state would
 * be indistinguishable from the first, to the operator and to the code.
 */
export const operatorCommandStatus = pgEnum("operator_command_status", [
  "queued",
  "waiting",
  "running",
  "succeeded",
  "abandoned",
]);

/**
 * Work an operator asked for, executed by the maintenance cycle rather than
 * inside their request.
 *
 * Its own table rather than `workflow_events`: that log's unique idempotency
 * key makes a second attempt a conflict rather than a retry, and the one
 * mechanism in this tree that genuinely retries on a schedule —
 * `reconcilePendingInboundRecords` — polls dedicated columns exactly like
 * these. `workflow_events` still records every attempt; this table decides
 * when there is one.
 */
export const operatorCommands = pgTable(
  "operator_commands",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    /** The operator-facing command name, for display. */
    command: text("command").notNull(),
    /** The workflow task that does the work. */
    task: text("task").notNull(),
    payload: jsonb("payload")
      .$type<Record<string, unknown>>()
      .default(sql`'{}'::jsonb`)
      .notNull(),
    status: operatorCommandStatus("status").default("queued").notNull(),
    /** Why the work cannot start yet. Null unless `status` is `waiting`. */
    waitingReason: text("waiting_reason"),
    attempt: integer("attempt").default(0).notNull(),
    /**
     * Four, so that the third backoff step is reachable.
     *
     * The retry ladder is 1, 5 then 15 minutes. At three attempts the run
     * ended after the second wait and the 15-minute step was dead code — a
     * command died six minutes into any outage. The outage this transport
     * actually has is the operator's ChatGPT desktop app being closed,
     * updated, or asleep with the laptop, which lasts longer than six
     * minutes. Four attempts spans twenty-one, at the cost of a genuinely
     * broken command taking that long to declare itself lost.
     */
    maxAttempts: integer("max_attempts").default(4).notNull(),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
    claimId: text("claim_id"),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    /** Links a run to its `workflow_events` audit trail. */
    runId: text("run_id"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    result: jsonb("result").$type<Record<string, unknown>>(),
    error: text("error"),
    requestedBy: text("requested_by").notNull(),
    dedupeKey: text("dedupe_key"),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("operator_commands_dedupe_key_unique")
      .on(table.dedupeKey)
      .where(sql`${table.dedupeKey} is not null`),
    index("operator_commands_drain_idx").on(table.status, table.nextAttemptAt),
    check(
      "operator_commands_attempt_check",
      sql`${table.attempt} >= 0 and ${table.maxAttempts} > 0`,
    ),
    check(
      "operator_commands_waiting_reason_check",
      sql`(${table.status} = 'waiting') = (${table.waitingReason} is not null)`,
    ),
  ],
);

/**
 * What an agent wrote into one message, with the confidence it claimed and the
 * sources it cited.
 *
 * Its own table rather than columns on `messages`: a step declares up to two
 * fields, each with its own confidence and its own evidence, and the review
 * card has to be able to show the operator which sentence came from where.
 * `agent_run_id` follows the `replies` precedent — every generated sentence
 * points back at the run that produced it.
 */
export const messagePersonalizationFields = pgTable(
  "message_personalization_fields",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    messageId: uuid("message_id")
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    value: text("value").notNull(),
    confidence: numeric("confidence", { precision: 4, scale: 3 }).notNull(),
    sourceUrls: jsonb("source_urls")
      .$type<string[]>()
      .default(sql`'[]'::jsonb`)
      .notNull(),
    agentRunId: uuid("agent_run_id").references(() => agentRuns.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("message_personalization_fields_message_name_unique").on(
      table.messageId,
      table.name,
    ),
    check(
      "message_personalization_fields_confidence_check",
      sql`${table.confidence} >= 0 and ${table.confidence} <= 1`,
    ),
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

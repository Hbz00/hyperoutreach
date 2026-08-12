export const SEND_POLICY_BLOCK_CODES = [
  "CAMPAIGN_INACTIVE",
  "ENROLLMENT_INACTIVE",
  "REPLY_PENDING",
  "MESSAGE_NOT_APPROVED",
  "STALE_SEQUENCE_STEP",
  "TERMINAL_REPLY",
  "UNSUBSCRIBED",
  "HARD_BOUNCE",
  "MANUAL_STOP",
  "RECIPIENT_SUPPRESSED",
  "COMPANY_SUPPRESSED",
  "MAILBOX_UNAVAILABLE",
  "MAILBOX_PROVIDER_MISMATCH",
  "STEP_ALREADY_SENT",
  "EMERGENCY_PAUSED",
  "OUTSIDE_WORKING_HOURS",
  "MAILBOX_DAILY_CAP_REACHED",
  "CAMPAIGN_DAILY_CAP_REACHED",
  "MAILBOX_MINIMUM_DELAY",
  "CONTACT_MINIMUM_DELAY",
  "RECENT_CONTACT_COOLDOWN",
  "PROFESSIONAL_RELEVANCE_REQUIRED",
] as const;

export type SendPolicyBlockCode = (typeof SEND_POLICY_BLOCK_CODES)[number];

export type SendPolicyInput = {
  campaignStatus: "draft" | "active" | "paused" | "completed" | "archived";
  enrollmentState:
    | "ready_for_review"
    | "approved"
    | "active"
    | "waiting"
    | "manual_review"
    | "paused"
    | "replied"
    | "bounced"
    | "opted_out"
    | "completed"
    | "stopped"
    | "failed";
  messageStatus:
    | "proposed"
    | "approved"
    | "draft_creating"
    | "drafted"
    | "sending"
    | "sent"
    | "delivery_uncertain"
    | "failed"
    | "cancelled";
  recipientSuppressed: boolean;
  accountDomainSuppressed?: boolean;
  mailboxRequired: boolean;
  mailboxStatus:
    "pending" | "available" | "degraded" | "disconnected" | "revoked" | null;
  providerMatches?: boolean;
  stepAlreadySent: boolean;
  expectedStepMatches?: boolean;
  terminalReply?: boolean;
  unsubscribed?: boolean;
  hardBounced?: boolean;
  manuallyStopped?: boolean;
  emergencyPaused?: boolean;
  withinWorkingHours?: boolean;
  mailboxDailySent?: number;
  mailboxDailyCap?: number;
  campaignDailySent?: number;
  campaignDailyCap?: number;
  mailboxMinimumDelaySatisfied?: boolean;
  contactMinimumDelaySatisfied?: boolean;
  recentContactCooldownSatisfied?: boolean;
  professionalRelevanceRequired?: boolean;
  professionallyRelevant?: boolean;
  replyPending?: boolean;
};

export type SendPolicyResult =
  { ok: true } | { ok: false; code: SendPolicyBlockCode };

export function evaluateSendPolicy(input: SendPolicyInput): SendPolicyResult {
  if (input.campaignStatus !== "active") {
    return { ok: false, code: "CAMPAIGN_INACTIVE" };
  }
  if (
    input.messageStatus !== "approved" &&
    input.messageStatus !== "drafted" &&
    input.messageStatus !== "sending" &&
    input.messageStatus !== "delivery_uncertain"
  ) {
    return { ok: false, code: "MESSAGE_NOT_APPROVED" };
  }
  if (
    input.enrollmentState !== "approved" &&
    input.enrollmentState !== "active"
  ) {
    if (input.unsubscribed) return { ok: false, code: "UNSUBSCRIBED" };
    if (input.hardBounced) return { ok: false, code: "HARD_BOUNCE" };
    if (input.terminalReply) return { ok: false, code: "TERMINAL_REPLY" };
    return { ok: false, code: "ENROLLMENT_INACTIVE" };
  }
  if (input.manuallyStopped) return { ok: false, code: "MANUAL_STOP" };
  if (input.replyPending) return { ok: false, code: "REPLY_PENDING" };
  if (input.unsubscribed) return { ok: false, code: "UNSUBSCRIBED" };
  if (input.hardBounced) return { ok: false, code: "HARD_BOUNCE" };
  if (input.terminalReply) return { ok: false, code: "TERMINAL_REPLY" };
  if (input.expectedStepMatches === false) {
    return { ok: false, code: "STALE_SEQUENCE_STEP" };
  }
  if (input.recipientSuppressed) {
    return { ok: false, code: "RECIPIENT_SUPPRESSED" };
  }
  if (input.accountDomainSuppressed) {
    return { ok: false, code: "COMPANY_SUPPRESSED" };
  }
  if (input.providerMatches === false) {
    return { ok: false, code: "MAILBOX_PROVIDER_MISMATCH" };
  }
  if (input.mailboxRequired && input.mailboxStatus !== "available") {
    return { ok: false, code: "MAILBOX_UNAVAILABLE" };
  }
  if (input.stepAlreadySent) return { ok: false, code: "STEP_ALREADY_SENT" };
  if (input.emergencyPaused) return { ok: false, code: "EMERGENCY_PAUSED" };
  if (input.withinWorkingHours === false) {
    return { ok: false, code: "OUTSIDE_WORKING_HOURS" };
  }
  if (
    input.mailboxDailyCap !== undefined &&
    (input.mailboxDailySent ?? 0) >= input.mailboxDailyCap
  ) {
    return { ok: false, code: "MAILBOX_DAILY_CAP_REACHED" };
  }
  if (
    input.campaignDailyCap !== undefined &&
    (input.campaignDailySent ?? 0) >= input.campaignDailyCap
  ) {
    return { ok: false, code: "CAMPAIGN_DAILY_CAP_REACHED" };
  }
  if (input.mailboxMinimumDelaySatisfied === false) {
    return { ok: false, code: "MAILBOX_MINIMUM_DELAY" };
  }
  if (input.contactMinimumDelaySatisfied === false) {
    return { ok: false, code: "CONTACT_MINIMUM_DELAY" };
  }
  if (input.recentContactCooldownSatisfied === false) {
    return { ok: false, code: "RECENT_CONTACT_COOLDOWN" };
  }
  if (input.professionalRelevanceRequired && !input.professionallyRelevant) {
    return { ok: false, code: "PROFESSIONAL_RELEVANCE_REQUIRED" };
  }
  return { ok: true };
}

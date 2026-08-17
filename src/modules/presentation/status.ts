/**
 * Human labels and severity tones for the persisted lifecycle enums.
 *
 * Every page renders persisted state, and the raw enum values are exact but
 * opaque: `delivery_uncertain` and `sent` read identically to a first-time
 * operator when both wear the same green badge. Each entry pairs the plain
 * words with a tone class so good, in-flight, and broken states are visually
 * distinct everywhere. The raw value stays available (badge `title`) because
 * exactness is still the currency of this product's audit trail.
 */
export type StatusTone = "ok" | "busy" | "warn" | "danger" | "neutral";

export type StatusPresentation = {
  label: string;
  tone: StatusTone;
};

export type StatusKind =
  | "message"
  | "enrollment"
  | "contact"
  | "research"
  | "emailResolution"
  | "emailCandidate"
  | "mailbox"
  | "campaign"
  | "command";

const PRESENTATIONS: Record<StatusKind, Record<string, StatusPresentation>> = {
  message: {
    proposed: { label: "Needs review", tone: "warn" },
    approved: { label: "Approved", tone: "ok" },
    draft_creating: { label: "Preparing draft", tone: "busy" },
    drafted: { label: "Draft ready", tone: "busy" },
    sending: { label: "Sending", tone: "busy" },
    sent: { label: "Sent", tone: "ok" },
    delivery_uncertain: { label: "Delivery uncertain", tone: "warn" },
    failed: { label: "Failed", tone: "danger" },
    cancelled: { label: "Cancelled", tone: "neutral" },
  },
  enrollment: {
    ready_for_review: { label: "Ready for review", tone: "warn" },
    approved: { label: "Approved", tone: "ok" },
    active: { label: "Active", tone: "ok" },
    waiting: { label: "Waiting for next step", tone: "busy" },
    manual_review: { label: "Needs manual review", tone: "warn" },
    paused: { label: "Paused", tone: "neutral" },
    replied: { label: "Replied", tone: "ok" },
    bounced: { label: "Bounced", tone: "danger" },
    opted_out: { label: "Opted out", tone: "danger" },
    completed: { label: "Completed", tone: "neutral" },
    stopped: { label: "Stopped", tone: "neutral" },
    failed: { label: "Failed", tone: "danger" },
  },
  contact: {
    discovered: { label: "Discovered", tone: "neutral" },
    researched: { label: "Researched", tone: "neutral" },
    email_resolved: { label: "Email resolved", tone: "ok" },
    ready_for_review: { label: "Ready for review", tone: "warn" },
    approved: { label: "Approved", tone: "ok" },
    active_sequence: { label: "In sequence", tone: "ok" },
    replied: { label: "Replied", tone: "ok" },
    bounced: { label: "Bounced", tone: "danger" },
    opted_out: { label: "Opted out", tone: "danger" },
    completed: { label: "Completed", tone: "neutral" },
    rejected: { label: "Rejected", tone: "warn" },
  },
  research: {
    pending: { label: "Not researched", tone: "neutral" },
    in_progress: { label: "Research running", tone: "busy" },
    complete: { label: "Researched", tone: "ok" },
    failed: { label: "Research failed", tone: "danger" },
  },
  emailResolution: {
    unresolved: { label: "Email unresolved", tone: "warn" },
    resolved: { label: "Email resolved", tone: "ok" },
    manual_review: { label: "Needs manual review", tone: "warn" },
    provider_error: { label: "Provider error", tone: "danger" },
  },
  emailCandidate: {
    candidate: { label: "Candidate", tone: "neutral" },
    accepted: { label: "Accepted", tone: "ok" },
    rejected: { label: "Rejected", tone: "neutral" },
  },
  mailbox: {
    pending: { label: "Connecting", tone: "busy" },
    available: { label: "Available", tone: "ok" },
    degraded: { label: "Degraded", tone: "warn" },
    disconnected: { label: "Disconnected", tone: "neutral" },
    revoked: { label: "Access revoked", tone: "danger" },
  },
  campaign: {
    draft: { label: "Draft", tone: "neutral" },
    active: { label: "Active", tone: "ok" },
    paused: { label: "Paused", tone: "warn" },
    completed: { label: "Completed", tone: "neutral" },
    archived: { label: "Archived", tone: "neutral" },
  },
  command: {
    queued: { label: "Queued", tone: "busy" },
    waiting: { label: "Waiting to retry", tone: "warn" },
    running: { label: "Running", tone: "busy" },
    succeeded: { label: "Done", tone: "ok" },
    abandoned: { label: "Gave up", tone: "danger" },
  },
};

/**
 * An unknown value renders as itself in a neutral badge rather than hiding:
 * a new enum member must never disappear from the operator's view because
 * this map lagged behind the schema.
 */
export function describeStatus(
  kind: StatusKind,
  value: string,
): StatusPresentation {
  return PRESENTATIONS[kind][value] ?? { label: value, tone: "neutral" };
}

const STOP_REASONS: Record<string, string> = {
  positive_reply: "positive reply",
  negative_reply: "negative reply",
  question: "question",
  referral: "referral",
  unsubscribe: "unsubscribe",
  hard_bounce: "hard bounce",
  manual_stop: "stopped manually",
  sequence_complete: "sequence complete",
  recipient_suppressed: "recipient suppressed",
  company_suppressed: "company suppressed",
  campaign_inactive: "campaign inactive",
  mailbox_unavailable: "mailbox unavailable",
  employment_changed: "changed employer",
};

export function describeStopReason(value: string): string {
  return STOP_REASONS[value] ?? value;
}

const RESOLUTION_REASONS: Record<string, string> = {
  missing_domain: "the company has no domain yet",
  domain_not_evidenced: "no evidence ties the domain to this company",
  insufficient_public_evidence: "not enough public address examples",
  low_confidence: "no candidate reached the confidence threshold",
  enrichment_no_result: "enrichment found nothing",
  provider_transient_error: "a provider failed — retry later",
  mx_missing: "the domain does not accept mail (no MX)",
  mx_lookup_failure: "the MX lookup failed",
  candidate_conflict: "candidates conflict with each other",
  employment_changed: "the contact changed employer",
  stale_employment: "the employment data is stale",
  resolution_in_progress: "resolution is still running",
};

export function describeResolutionReason(value: string): string {
  return RESOLUTION_REASONS[value] ?? value;
}

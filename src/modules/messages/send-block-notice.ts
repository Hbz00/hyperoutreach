import type { SendPolicyBlockCode } from "@/modules/messages/send-policy";

/**
 * One sentence per refusal, in the operator's language, with the code kept in
 * parentheses so an audit line and a screen say the same thing. Both the
 * redirect notice and `messages.last_error` read from here: a refusal the
 * operator cannot see is the failure mode this text exists to close, and two
 * wordings for one cause would reopen it.
 */
export const SEND_BLOCK_NOTICES: Record<SendPolicyBlockCode, string> = {
  CAMPAIGN_INACTIVE: "The campaign is not active",
  ENROLLMENT_INACTIVE: "This prospect is no longer in an active sequence",
  REPLY_PENDING: "A reply is waiting to be classified",
  MESSAGE_NOT_APPROVED: "The message has not been approved",
  STALE_SEQUENCE_STEP: "The sequence has moved past this step",
  TERMINAL_REPLY: "The prospect already replied",
  UNSUBSCRIBED: "The prospect unsubscribed",
  HARD_BOUNCE: "This address hard-bounced",
  MANUAL_STOP: "The sequence was stopped by hand",
  RECIPIENT_SUPPRESSED: "This address is on the suppression list",
  COMPANY_SUPPRESSED: "This company is on the suppression list",
  MAILBOX_UNAVAILABLE: "The mailbox is not available",
  MAILBOX_PROVIDER_MISMATCH: "The mailbox no longer matches its provider",
  STEP_ALREADY_SENT: "This step has already been sent",
  EMERGENCY_PAUSED: "Emergency pause is on",
  OUTSIDE_WORKING_HOURS: "Outside the sending window",
  MAILBOX_DAILY_CAP_REACHED: "This mailbox reached its daily cap",
  CAMPAIGN_DAILY_CAP_REACHED: "This campaign reached its daily cap",
  MAILBOX_MINIMUM_DELAY: "Too soon after the last send from this mailbox",
  CONTACT_MINIMUM_DELAY: "Too soon after the last message to this prospect",
  RECENT_CONTACT_COOLDOWN: "This prospect was contacted by another campaign",
  PROFESSIONAL_RELEVANCE_REQUIRED:
    "The campaign requires evidence of professional relevance",
};

export function sendBlockNotice(code: SendPolicyBlockCode): string {
  return `${SEND_BLOCK_NOTICES[code]} (${code})`;
}

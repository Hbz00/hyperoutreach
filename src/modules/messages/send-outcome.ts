import {
  SEND_BLOCK_NOTICES,
  sendBlockNotice,
} from "@/modules/messages/send-block-notice";
import type { SendMessageResult } from "@/modules/messages/send-service";

/**
 * Outcomes that are not policy verdicts. A send can also fail on its way to
 * the provider, and the operator is owed the same sentence for those.
 */
const NON_POLICY_NOTICES: Record<string, string> = {
  INVALID_INPUT: "The request was malformed",
  NOT_FOUND: "The message no longer exists",
  IN_PROGRESS: "Another send of this message is already running",
  DELIVERY_UNCERTAIN:
    "The provider accepted the message without confirming it; delivery will be reconciled",
  PERMANENT_REJECTION: "The provider rejected the message permanently",
  PROVIDER_ERROR: "The mail provider failed",
  DATABASE_ERROR: "The message could not be updated",
};

/**
 * Turns what a send actually did into the one sentence the operator reads.
 *
 * The route used to answer "Send execution completed" whatever happened, so a
 * refusal — outside the sending window, under the per-mailbox delay, a
 * suppressed recipient — looked exactly like a delivery. With the shipped
 * sixty-second delay between two sends from one mailbox, approving five
 * messages and clicking Send five times silently did nothing four times out
 * of five.
 */
export function sendOutcomeNotice(
  result: SendMessageResult | undefined,
): string {
  // No recorded outcome is not a success: the dispatcher deduplicates a
  // repeated key, and a hosted executor reports nothing back at all.
  if (!result) return "Send execution started";
  if (result.ok) {
    return result.disposition === "already_sent"
      ? "Message was already sent"
      : "Message sent";
  }
  const explanation =
    result.code in SEND_BLOCK_NOTICES
      ? sendBlockNotice(result.code as keyof typeof SEND_BLOCK_NOTICES)
      : `${NON_POLICY_NOTICES[result.code] ?? "The send did not complete"} (${result.code})`;
  return `Not sent — ${explanation}`;
}

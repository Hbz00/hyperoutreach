import type { ReplyCategory } from "@/modules/replies/reply-classifier";

/**
 * What a delivery report actually said.
 *
 * Three states, because RFC 3464 reports two different things and the parser
 * used to collapse them: `delayed` is "not yet, still retrying", `soft` is "I
 * retried and gave up on a temporary condition", `hard` is "this address does
 * not exist". Only the last says anything about the address, which is why only
 * the last suppresses.
 *
 * `delayed` is modelled as a bounce kind rather than an `automated` reply on
 * purpose: it is an event in a delivery's lifecycle, and the sequence it
 * belongs to must resume rather than be held for a human.
 */
export type BounceKind = "hard" | "soft" | "delayed" | null;

export type ReplyOutcome = {
  /**
   * Put the schedule this reply's own arrival snapshotted back.
   *
   * Every matched inbound message holds its enrollment before it is
   * classified — state to `manual_review`, schedule snapshotted and cleared —
   * so "do not stop the sequence" cannot be expressed by leaving the schedule
   * alone. It has to be restored, and independently of `holdNonTerminalReplies`,
   * which decides something else entirely.
   */
  restoreSchedule?: boolean;
  state: "replied" | "bounced" | "opted_out" | "manual_review" | null;
  stopReason:
    | "positive_reply"
    | "negative_reply"
    | "question"
    | "referral"
    | "unsubscribe"
    | "hard_bounce"
    | null;
  terminal: boolean;
  clearSchedule: boolean;
  suppressRecipient: boolean;
};

export function mapReplyOutcome(
  category: ReplyCategory,
  bounceKind: BounceKind,
  holdNonTerminal: boolean,
): ReplyOutcome {
  const terminal = {
    positive: ["replied", "positive_reply"],
    negative: ["replied", "negative_reply"],
    question: ["replied", "question"],
    referral: ["replied", "referral"],
    unsubscribe: ["opted_out", "unsubscribe"],
  } as const;
  if (category in terminal) {
    const [state, stopReason] = terminal[category as keyof typeof terminal];
    return {
      state,
      stopReason,
      terminal: true,
      clearSchedule: true,
      suppressRecipient: category === "unsubscribe",
    };
  }
  if (category === "bounce") {
    if (bounceKind === "delayed") {
      return {
        state: null,
        stopReason: null,
        terminal: false,
        clearSchedule: false,
        restoreSchedule: true,
        suppressRecipient: false,
      };
    }
    if (bounceKind === "hard") {
      return {
        state: "bounced",
        stopReason: "hard_bounce",
        terminal: true,
        clearSchedule: true,
        suppressRecipient: true,
      };
    }
    // Said explicitly rather than left absent, because it sits three lines from
    // the branch that restores and the contrast is the entire feature: the
    // server gave up, so the message did not arrive and a human is owed a look.
    return {
      state: "manual_review",
      stopReason: null,
      terminal: false,
      clearSchedule: true,
      restoreSchedule: false,
      suppressRecipient: false,
    };
  }
  return {
    state: holdNonTerminal ? "manual_review" : null,
    stopReason: null,
    terminal: false,
    clearSchedule: holdNonTerminal,
    suppressRecipient: false,
  };
}

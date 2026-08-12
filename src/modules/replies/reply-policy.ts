import type { ReplyCategory } from "@/modules/replies/reply-classifier";

export type BounceKind = "hard" | "soft" | null;

export type ReplyOutcome = {
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
    if (bounceKind === "hard") {
      return {
        state: "bounced",
        stopReason: "hard_bounce",
        terminal: true,
        clearSchedule: true,
        suppressRecipient: true,
      };
    }
    return {
      state: "manual_review",
      stopReason: null,
      terminal: false,
      clearSchedule: true,
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

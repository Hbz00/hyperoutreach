import { describe, expect, it } from "vitest";

import {
  DeterministicReplyClassifier,
  validateReplyClassification,
} from "@/modules/replies/reply-classifier";
import { mapReplyOutcome } from "@/modules/replies/reply-policy";

describe("reply classification boundary", () => {
  it.each([
    ["Please unsubscribe me", "unsubscribe"],
    ["Automatic reply: out of office", "out_of_office"],
    ["Yes, let's schedule a call", "positive"],
    ["No thank you", "negative"],
    ["No thanks, not interested", "negative"],
    ["Could you share pricing?", "question"],
    ["Please contact Marie instead", "referral"],
    // Every shape below is one a real mail system produces when the transport
    // could not parse the report itself — the only case that ever reaches a
    // classifier, since a structured DSN sets `bounceKind` and skips it. All
    // four were put to the production classifier, which answered `bounce` with
    // 0.99 confidence; a local stand-in that answered otherwise would make
    // every test written against it prove the wrong thing.
    ["Delivery status notification", "bounce"],
    ["Undelivered Mail Returned to Sender: user unknown", "bounce"],
    [
      "Your message couldn't be delivered — RESOLVER.ADR.RecipientNotFound",
      "bounce",
    ],
    ["Address not found. 550 5.1.1 the account does not exist", "bounce"],
    ["452 4.2.2 Mailbox full, the server will retry", "bounce"],
    // Automated and not a failure: the category that used to swallow all of
    // the above.
    ["This is an automated message; do not reply", "automated"],
    ["Noted", "unknown"],
  ])("classifies deterministic local text", async (body, category) => {
    const result = await new DeterministicReplyClassifier().classify({
      subject: "Re: hello",
      body,
      sender: "person@example.com",
    });
    expect(result.category).toBe(category);
    expect(result.confidence).toBeGreaterThanOrEqual(0);
    expect(result.confidence).toBeLessThanOrEqual(1);
  });

  it("rejects an invalid provider classification", () => {
    expect(() =>
      validateReplyClassification({
        category: "maybe",
        confidence: 2,
        reason: "invalid",
      }),
    ).toThrow();
  });
});

describe("reply terminal mapping", () => {
  it.each([
    ["positive", "replied", "positive_reply", true],
    ["negative", "replied", "negative_reply", true],
    ["question", "replied", "question", true],
    ["referral", "replied", "referral", true],
    ["unsubscribe", "opted_out", "unsubscribe", true],
  ] as const)(
    "maps %s to a terminal enrollment",
    (category, state, reason, terminal) => {
      expect(mapReplyOutcome(category, null, true)).toMatchObject({
        state,
        stopReason: reason,
        terminal,
        clearSchedule: true,
      });
    },
  );

  it("distinguishes hard and soft bounce", () => {
    expect(mapReplyOutcome("bounce", "hard", true)).toMatchObject({
      state: "bounced",
      stopReason: "hard_bounce",
      suppressRecipient: true,
      terminal: true,
    });
    expect(mapReplyOutcome("bounce", "soft", true)).toMatchObject({
      state: "manual_review",
      stopReason: null,
      suppressRecipient: false,
      terminal: false,
    });
  });

  it("holds non-terminal automated replies when configured", () => {
    expect(mapReplyOutcome("out_of_office", null, true)).toMatchObject({
      state: "manual_review",
      clearSchedule: true,
      terminal: false,
    });
    expect(mapReplyOutcome("unknown", null, false)).toMatchObject({
      state: null,
      clearSchedule: false,
      terminal: false,
    });
  });
});

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
    ["Delivery status notification", "automated"],
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

import { describe, expect, it } from "vitest";

import { evaluateSendPolicy } from "@/modules/messages/send-policy";

const eligible = {
  campaignStatus: "active" as const,
  enrollmentState: "approved" as const,
  messageStatus: "approved" as const,
  recipientSuppressed: false,
  mailboxRequired: true,
  mailboxStatus: "available" as const,
  stepAlreadySent: false,
  expectedStepMatches: true,
  terminalReply: false,
  unsubscribed: false,
  hardBounced: false,
  manuallyStopped: false,
  accountDomainSuppressed: false,
  providerMatches: true,
  emergencyPaused: false,
  withinWorkingHours: true,
  mailboxDailySent: 0,
  mailboxDailyCap: 25,
  campaignDailySent: 0,
  campaignDailyCap: 100,
  mailboxMinimumDelaySatisfied: true,
  contactMinimumDelaySatisfied: true,
  recentContactCooldownSatisfied: true,
  professionalRelevanceRequired: true,
  professionallyRelevant: true,
};

describe("deterministic send policy", () => {
  it("allows an approved current message", () => {
    expect(evaluateSendPolicy(eligible)).toEqual({ ok: true });
  });

  it.each([
    [{ ...eligible, campaignStatus: "paused" as const }, "CAMPAIGN_INACTIVE"],
    [
      { ...eligible, enrollmentState: "stopped" as const },
      "ENROLLMENT_INACTIVE",
    ],
    [
      { ...eligible, messageStatus: "cancelled" as const },
      "MESSAGE_NOT_APPROVED",
    ],
    [{ ...eligible, recipientSuppressed: true }, "RECIPIENT_SUPPRESSED"],
    [
      { ...eligible, mailboxStatus: "disconnected" as const },
      "MAILBOX_UNAVAILABLE",
    ],
    [{ ...eligible, stepAlreadySent: true }, "STEP_ALREADY_SENT"],
    [{ ...eligible, expectedStepMatches: false }, "STALE_SEQUENCE_STEP"],
    [{ ...eligible, terminalReply: true }, "TERMINAL_REPLY"],
    [{ ...eligible, unsubscribed: true }, "UNSUBSCRIBED"],
    [{ ...eligible, hardBounced: true }, "HARD_BOUNCE"],
    [{ ...eligible, manuallyStopped: true }, "MANUAL_STOP"],
    [{ ...eligible, accountDomainSuppressed: true }, "COMPANY_SUPPRESSED"],
    [{ ...eligible, providerMatches: false }, "MAILBOX_PROVIDER_MISMATCH"],
    [{ ...eligible, emergencyPaused: true }, "EMERGENCY_PAUSED"],
    [{ ...eligible, withinWorkingHours: false }, "OUTSIDE_WORKING_HOURS"],
    [{ ...eligible, mailboxDailySent: 25 }, "MAILBOX_DAILY_CAP_REACHED"],
    [{ ...eligible, campaignDailySent: 100 }, "CAMPAIGN_DAILY_CAP_REACHED"],
    [
      { ...eligible, mailboxMinimumDelaySatisfied: false },
      "MAILBOX_MINIMUM_DELAY",
    ],
    [
      { ...eligible, contactMinimumDelaySatisfied: false },
      "CONTACT_MINIMUM_DELAY",
    ],
    [
      { ...eligible, recentContactCooldownSatisfied: false },
      "RECENT_CONTACT_COOLDOWN",
    ],
    [
      { ...eligible, professionallyRelevant: false },
      "PROFESSIONAL_RELEVANCE_REQUIRED",
    ],
  ])("returns a typed block result", (input, code) => {
    expect(evaluateSendPolicy(input)).toEqual({ ok: false, code });
  });

  it("allows an enrollment with no mailbox requirement", () => {
    expect(
      evaluateSendPolicy({
        ...eligible,
        mailboxRequired: false,
        mailboxStatus: null,
      }),
    ).toEqual({ ok: true });
  });
});

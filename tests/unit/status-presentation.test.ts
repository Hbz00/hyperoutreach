import { describe, expect, it } from "vitest";

import {
  accountResearchStatus,
  campaignStatus,
  contactStatus,
  emailCandidateStatus,
  emailResolutionStatus,
  enrollmentState,
  mailboxStatus,
  messageStatus,
  operatorCommandStatus,
  stopReason,
} from "@/lib/db/schema";
import { LADDER_PARKING_REASONS } from "@/modules/email-resolution/ladder";
import {
  describeStatus,
  describeStopReason,
  describeLadderHold,
  type StatusKind,
} from "@/modules/presentation/status";

const KIND_ENUMS: Record<StatusKind, readonly string[]> = {
  message: messageStatus.enumValues,
  enrollment: enrollmentState.enumValues,
  contact: contactStatus.enumValues,
  research: accountResearchStatus.enumValues,
  emailResolution: emailResolutionStatus.enumValues,
  emailCandidate: emailCandidateStatus.enumValues,
  mailbox: mailboxStatus.enumValues,
  campaign: campaignStatus.enumValues,
  command: operatorCommandStatus.enumValues,
};

describe("status presentation", () => {
  it("covers every persisted enum value with a human label", () => {
    for (const [kind, values] of Object.entries(KIND_ENUMS)) {
      for (const value of values) {
        const presentation = describeStatus(kind as StatusKind, value);
        // A raw enum leaking through means the map lagged behind the schema.
        expect(
          presentation.label,
          `${kind}.${value} has no human label`,
        ).not.toBe(value);
        expect(presentation.label.length).toBeGreaterThan(0);
      }
    }
  });

  it("separates good, in-flight, and broken outcomes by tone", () => {
    expect(describeStatus("message", "sent").tone).toBe("ok");
    expect(describeStatus("message", "delivery_uncertain").tone).toBe("warn");
    expect(describeStatus("message", "failed").tone).toBe("danger");
    expect(describeStatus("message", "sending").tone).toBe("busy");
    expect(describeStatus("enrollment", "opted_out").tone).toBe("danger");
    expect(describeStatus("research", "in_progress").tone).toBe("busy");
    expect(describeStatus("mailbox", "revoked").tone).toBe("danger");
  });

  it("renders an unknown value as itself in a neutral badge instead of hiding it", () => {
    expect(describeStatus("message", "some_new_state")).toEqual({
      label: "some_new_state",
      tone: "neutral",
    });
  });

  it("covers every stop reason with plain words", () => {
    for (const value of stopReason.enumValues) {
      expect(describeStopReason(value).length).toBeGreaterThan(0);
      expect(describeStopReason(value)).not.toContain("_");
    }
    expect(describeStopReason("unknown_future_reason")).toBe(
      "unknown_future_reason",
    );
  });
  /**
   * The three bounds a prospect can be parked by each name their own setting.
   *
   * They collapse into one `ladder_limit_reached` sentence on the contact,
   * which is true and is only half an instruction: raising the wrong one of
   * three settings changes nothing. Anything else the ladder refuses on is not
   * a bound, and must return nothing rather than invent a setting to raise.
   */
  it("names the setting behind every bound that parks a prospect", () => {
    // Driven by the list the ladder itself parks on, not by a copy of it. A
    // fourth bound added there arrives here with no sentence and fails, which
    // is the only way a hand-written list of three would not have gone stale.
    expect(LADDER_PARKING_REASONS.length).toBeGreaterThan(0);
    for (const reason of LADDER_PARKING_REASONS) {
      const sentence = describeLadderHold(reason);
      expect(sentence, `${reason} has no sentence`).not.toBeNull();
      expect(sentence).toContain("Settings");
      expect(sentence).not.toContain("_");
    }
    for (const terminal of [
      "no_remaining_rung",
      "all_remaining_suppressed",
      "undelivered_send_outstanding",
      "employment_changed",
      "enrollment_ended",
      "feature_disabled",
      "address_dead_on_another_message",
    ]) {
      expect(describeLadderHold(terminal), terminal).toBeNull();
    }
  });
});

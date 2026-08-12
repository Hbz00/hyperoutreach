import { describe, expect, it } from "vitest";

import { evaluateReviewTransition } from "@/modules/messages/review-policy";

describe("message review transitions", () => {
  it("approves a proposed message without changing its content", () => {
    expect(
      evaluateReviewTransition(
        { status: "proposed", subject: "Subject", body: "Body" },
        { kind: "approve" },
      ),
    ).toEqual({
      ok: true,
      status: "approved",
      subject: "Subject",
      body: "Body",
    });
  });

  it("uses edited content as the exact approved content", () => {
    expect(
      evaluateReviewTransition(
        { status: "proposed", subject: "Old", body: "Old body" },
        { kind: "edit_and_approve", subject: "New", body: "New body" },
      ),
    ).toEqual({
      ok: true,
      status: "approved",
      subject: "New",
      body: "New body",
    });
  });

  it("rejects empty edited content", () => {
    expect(
      evaluateReviewTransition(
        { status: "proposed", subject: "Old", body: "Old body" },
        { kind: "edit_and_approve", subject: " ", body: "New body" },
      ),
    ).toEqual({ ok: false, code: "INVALID_CONTENT" });
  });

  it("rejects a proposal and prevents later approval", () => {
    const rejected = evaluateReviewTransition(
      { status: "proposed", subject: "Subject", body: "Body" },
      { kind: "reject", reason: "Not relevant" },
    );
    expect(rejected).toEqual({
      ok: true,
      status: "cancelled",
      subject: "Subject",
      body: "Body",
      reason: "Not relevant",
    });
    expect(
      evaluateReviewTransition(
        { status: "cancelled", subject: "Subject", body: "Body" },
        { kind: "approve" },
      ),
    ).toEqual({
      ok: false,
      code: "INVALID_TRANSITION",
      from: "cancelled",
      action: "approve",
    });
  });
});

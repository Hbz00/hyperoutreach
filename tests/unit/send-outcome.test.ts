import { describe, expect, it } from "vitest";

import { sendOutcomeNotice } from "@/modules/messages/send-outcome";

describe("send outcome notice", () => {
  it("says a message was sent", () => {
    expect(
      sendOutcomeNotice({
        ok: true,
        disposition: "sent",
        message: {} as never,
      }),
    ).toBe("Message sent");
  });

  it("distinguishes a message that was already sent", () => {
    expect(
      sendOutcomeNotice({
        ok: true,
        disposition: "already_sent",
        message: {} as never,
      }),
    ).toBe("Message was already sent");
  });

  it("names the refusal in the operator's language, code included", () => {
    const notice = sendOutcomeNotice({
      ok: false,
      code: "OUTSIDE_WORKING_HOURS",
    });
    expect(notice).toContain("Outside the sending window");
    expect(notice).toContain("OUTSIDE_WORKING_HOURS");
    expect(notice).toContain("Not sent");
  });

  it("names a refusal that is not a policy verdict", () => {
    expect(sendOutcomeNotice({ ok: false, code: "PROVIDER_ERROR" })).toContain(
      "PROVIDER_ERROR",
    );
  });

  // The dispatcher deduplicates a repeated key, and a hosted executor has no
  // output to report at all. Saying "sent" there would be a lie.
  it("does not claim anything when no outcome was recorded", () => {
    expect(sendOutcomeNotice(undefined)).toBe("Send execution started");
  });
});

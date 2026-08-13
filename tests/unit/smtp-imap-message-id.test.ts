import { describe, expect, it } from "vitest";

import {
  buildMime,
  extractMessageId,
  extractRecipient,
} from "@/lib/smtp-imap/mime";
import { outreachMessageId } from "@/lib/smtp-imap/message-id";

describe("deterministic message id", () => {
  it("returns the same value for the same outreach id", () => {
    const a = outreachMessageId("outreach-42", "polytechnique.edu");
    const b = outreachMessageId("outreach-42", "polytechnique.edu");
    expect(a).toBe(b);
    expect(a).toMatch(/^<.+@polytechnique\.edu>$/);
  });

  it("differs across outreach ids", () => {
    expect(outreachMessageId("a", "d.tld")).not.toBe(
      outreachMessageId("b", "d.tld"),
    );
  });

  it("embeds the identifier in the MIME headers", () => {
    const mime = buildMime(
      {
        sender: "corentin.sacazes@polytechnique.edu",
        recipient: "prospect@example.com",
        subject: "Sujet",
        body: "Corps",
        headers: { "X-Outreach-ID": "outreach-42" },
      },
      outreachMessageId("outreach-42", "polytechnique.edu"),
    );
    expect(mime).toContain("Message-ID: <");
    expect(mime).toContain("X-Outreach-ID: outreach-42");
  });

  it("refuses header injection through the subject", () => {
    expect(() =>
      buildMime(
        {
          sender: "a@b.tld",
          recipient: "c@d.tld",
          subject: "Sujet\r\nBcc: attaquant@example.com",
          body: "Corps",
          headers: {},
        },
        "<x@b.tld>",
      ),
    ).toThrow();
  });

  it("refuses a custom header outside the X- namespace, even with no CR/LF", () => {
    expect(() =>
      buildMime(
        {
          sender: "a@b.tld",
          recipient: "c@d.tld",
          subject: "Sujet",
          body: "Corps",
          headers: { Bcc: "attaquant@example.com" },
        },
        "<x@b.tld>",
      ),
    ).toThrow();
  });

  it("refuses a custom header that collides with Message-ID", () => {
    expect(() =>
      buildMime(
        {
          sender: "a@b.tld",
          recipient: "c@d.tld",
          subject: "Sujet",
          body: "Corps",
          headers: { "Message-ID": "<spoofed@attacker.tld>" },
        },
        "<x@b.tld>",
      ),
    ).toThrow();
  });

  it("still allows the legitimate X-Outreach-ID header", () => {
    const mime = buildMime(
      {
        sender: "a@b.tld",
        recipient: "c@d.tld",
        subject: "Sujet",
        body: "Corps",
        headers: { "X-Outreach-ID": "outreach-42" },
      },
      "<x@b.tld>",
    );
    expect(mime).toContain("X-Outreach-ID: outreach-42");
  });
});

describe("mime header extraction", () => {
  const mime = buildMime(
    {
      sender: "boite@d.tld",
      recipient: "prospect@example.com",
      subject: "Sujet",
      body: "Corps",
      headers: {},
    },
    "<outreach-42.hyperoutreach@d.tld>",
  );

  it("extractMessageId reads the Message-ID back out, brackets included", () => {
    expect(extractMessageId(mime)).toBe("<outreach-42.hyperoutreach@d.tld>");
  });

  it("extractMessageId returns null when there is no Message-ID header", () => {
    expect(
      extractMessageId("Subject: no headers here\r\n\r\nCorps"),
    ).toBeNull();
  });

  it("extractMessageId never matches a Message-ID-looking line inside the body", () => {
    const spoofed =
      "Subject: Sujet\r\n\r\nMessage-ID: <spoofed@attacker.tld>\r\nCorps du message";
    expect(extractMessageId(spoofed)).toBeNull();
  });

  it("extractRecipient reads the To header back out", () => {
    expect(extractRecipient(mime)).toBe("prospect@example.com");
  });

  it("extractRecipient returns null when there is no To header", () => {
    expect(
      extractRecipient("Subject: no headers here\r\n\r\nCorps"),
    ).toBeNull();
  });

  it("extractRecipient never matches a To-looking line inside the body", () => {
    const spoofed =
      "Subject: Sujet\r\n\r\nTo: attaquant@example.com\r\nCorps du message";
    expect(extractRecipient(spoofed)).toBeNull();
  });
});

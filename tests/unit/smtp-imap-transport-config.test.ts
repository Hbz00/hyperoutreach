import { describe, expect, it } from "vitest";

import {
  readTransport,
  transportConfigSchema,
  writeTransport,
} from "@/lib/smtp-imap/transport-config";

const valid = {
  username: "corentin.sacazes",
  imap: { host: "webmail.polytechnique.fr", port: 993, security: "tls" },
  smtp: { host: "webmail.polytechnique.fr", port: 587, security: "starttls" },
  folders: { drafts: "Drafts", sent: "Sent", inbox: "INBOX" },
};

describe("mailbox transport configuration", () => {
  it("accepts a Zimbra style configuration whose username is not an email", () => {
    const parsed = transportConfigSchema.parse(valid);
    expect(parsed.username).toBe("corentin.sacazes");
    expect(parsed.username).not.toContain("@");
  });

  it("rejects a plaintext IMAP port", () => {
    expect(() =>
      transportConfigSchema.parse({
        ...valid,
        imap: { host: "h", port: 143, security: "none" },
      }),
    ).toThrow();
  });

  it("returns null when the settings blob carries no transport", () => {
    expect(readTransport({})).toBeNull();
  });

  // `writeTransport` is the function that decides what survives a
  // reconnection -- the gesture the operator will make at least once, to
  // retype a password. `connectSmtpImapMailbox` calls it as
  // `writeTransport(existing.settings, transport)`: everything in `settings`
  // that is not the transport belongs to other features and must come
  // through untouched. A `{ transport }` written in its place would silently
  // erase all of it, and nothing would report the loss.
  it("replaces only the transport key and preserves every unrelated setting", () => {
    const transport = transportConfigSchema.parse(valid);
    const existing = {
      transport: { username: "stale", imap: "nonsense" },
      signature: "Cordialement,\nCorentin",
      dailyCap: 25,
      nested: { retained: true },
    };

    const written = writeTransport(existing, transport);

    expect(written.transport).toEqual(transport);
    expect(written.signature).toBe("Cordialement,\nCorentin");
    expect(written.dailyCap).toBe(25);
    expect(written.nested).toEqual({ retained: true });
    // Round-trips through the reader the provider bootstrap actually uses.
    expect(readTransport(written)).toEqual(transport);
  });

  it("does not mutate the settings object it was handed", () => {
    const transport = transportConfigSchema.parse(valid);
    const existing: Record<string, unknown> = { signature: "keep me" };

    const written = writeTransport(existing, transport);

    expect(existing).toEqual({ signature: "keep me" });
    expect(written).not.toBe(existing);
  });
});

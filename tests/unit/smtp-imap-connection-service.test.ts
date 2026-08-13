import { describe, expect, it, vi } from "vitest";

import type { AppDatabase } from "@/lib/db/types";

vi.mock("server-only", () => ({}));

const { connectSmtpImapMailbox, verifyTransport } =
  await import("@/modules/mailboxes/smtp-imap-connection-service");
const { ImapFolderResolutionError } =
  await import("@/lib/smtp-imap/imap-client");

const transport = {
  username: "corentin.sacazes",
  imap: { host: "h", port: 993, security: "tls" as const },
  smtp: { host: "h", port: 587, security: "starttls" as const },
  folders: { drafts: "Drafts", sent: "Sent", inbox: "INBOX" },
};

describe("connection verification", () => {
  it("reports a generic IMAP endpoint failure without blaming credentials", async () => {
    const smtpVerify = vi.fn();
    const result = await verifyTransport(transport, "secret", {
      imapVerify: vi.fn().mockRejectedValue(new Error("no")),
      smtpVerify,
    });
    expect(result).toEqual({ ok: false, code: "IMAP_CONNECTION_FAILED" });
    expect(smtpVerify).not.toHaveBeenCalled();
  });

  it("reports a generic SMTP endpoint failure without blaming credentials", async () => {
    const result = await verifyTransport(transport, "secret", {
      imapVerify: vi
        .fn()
        .mockResolvedValue({ drafts: "Drafts", sent: "Sent", inbox: "INBOX" }),
      smtpVerify: vi.fn().mockRejectedValue(new Error("no")),
    });
    expect(result).toEqual({ ok: false, code: "SMTP_CONNECTION_FAILED" });
  });

  it("returns the discovered folders on success", async () => {
    const result = await verifyTransport(transport, "secret", {
      imapVerify: vi.fn().mockResolvedValue({
        drafts: "Brouillons",
        sent: "Envoyes",
        inbox: "INBOX",
      }),
      smtpVerify: vi.fn().mockResolvedValue(undefined),
    });
    expect(result).toEqual({
      ok: true,
      folders: { drafts: "Brouillons", sent: "Envoyes", inbox: "INBOX" },
    });
  });

  // Fix round 1: a definite credentials refusal and a connection that
  // authenticated fine but couldn't identify Drafts/Sent (a French Zimbra
  // naming them "Brouillons"/"Envoyés") are different operator problems --
  // telling an operator "identifiants refusés" for the latter sends them to
  // re-check a password that was never wrong.
  it("distinguishes IMAP_FOLDERS_NOT_FOUND from IMAP_AUTH_FAILED", async () => {
    const smtpVerify = vi.fn();
    const result = await verifyTransport(transport, "secret", {
      imapVerify: vi
        .fn()
        .mockRejectedValue(
          new ImapFolderResolutionError("Unable to resolve the Drafts folder"),
        ),
      smtpVerify,
    });
    expect(result).toEqual({ ok: false, code: "IMAP_FOLDERS_NOT_FOUND" });
    expect(smtpVerify).not.toHaveBeenCalled();
  });

  it("classifies a generic IMAP network error as a connection failure", async () => {
    // Same assertion as the verbatim brief test above, restated here next to
    // its IMAP_FOLDERS_NOT_FOUND counterpart so the two-way split reads as
    // one deliberate contract rather than an accident of the brief's own
    // fixture.
    const result = await verifyTransport(transport, "secret", {
      imapVerify: vi.fn().mockRejectedValue(new Error("ECONNREFUSED")),
      smtpVerify: vi.fn(),
    });
    expect(result).toEqual({ ok: false, code: "IMAP_CONNECTION_FAILED" });
  });
});

describe("connectSmtpImapMailbox — configuration vs. database failure", () => {
  // Fix round 1: a misconfigured keyring (missing/malformed
  // TOKEN_ENCRYPTION_KEYS/TOKEN_ENCRYPTION_ACTIVE_KEY_ID) is an operator/
  // deployment problem, not a database failure -- and, structurally, is
  // detected before this function ever touches `db` at all. `db` here is a
  // Proxy that throws on any property access: if a future change moved the
  // keyring check to run after some `db` call, this test would fail loudly
  // (a thrown error inside the outer try/catch, surfacing as
  // DATABASE_ERROR instead of the expected CONFIGURATION_ERROR) rather than
  // silently passing.
  it("reports CONFIGURATION_ERROR, not DATABASE_ERROR, for a missing keyring -- without ever touching the database", async () => {
    const untouchedDb = new Proxy(
      {},
      {
        get(): never {
          throw new Error("db must not be touched on a configuration error");
        },
      },
    );

    const result = await connectSmtpImapMailbox(
      untouchedDb as unknown as AppDatabase,
      {
        email: "operator@example.com",
        password: "correct-password",
        username: "operator",
        imap: { host: "imap.example.com", port: 993, security: "tls" },
        smtp: { host: "smtp.example.com", port: 587, security: "starttls" },
      },
      {
        environment: {},
        imapVerify: async () => ({
          drafts: "Drafts",
          sent: "Sent",
          inbox: "INBOX",
        }),
        smtpVerify: async () => {},
      },
    );

    expect(result).toEqual({ ok: false, code: "CONFIGURATION_ERROR" });
  });
});

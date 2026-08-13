import { randomBytes, randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as schema from "@/lib/db/schema";
import { resolveDatabaseUrls } from "@/lib/db/test-database";
import {
  encryptSecret,
  type EncryptionKeyring,
} from "@/lib/microsoft/token-crypto";
import { createMailProviderForMailbox } from "@/modules/mailboxes/provider-factory";
import { SmtpImapMailProvider } from "@/modules/mailboxes/smtp-imap-mail-provider";

const { testUrl } = resolveDatabaseUrls(process.env);
const client = postgres(testUrl, { max: 4 });
const db = drizzle(client, { schema });

// Deliberately its own keyring, distinct from whatever `.env.local` sets --
// threaded explicitly via `environment` below so this test never depends on
// (or clobbers) real process env state, matching the design doc's lazy
// per-provider config resolution.
const keyring: EncryptionKeyring = {
  activeKeyId: "bootstrap-v1",
  keys: { "bootstrap-v1": randomBytes(32) },
};
const environment = {
  TOKEN_ENCRYPTION_ACTIVE_KEY_ID: keyring.activeKeyId,
  TOKEN_ENCRYPTION_KEYS: `bootstrap-v1:${keyring.keys["bootstrap-v1"]!.toString("base64")}`,
};

const validTransport = {
  transport: {
    username: "corentin.sacazes",
    imap: { host: "imap.example.com", port: 993, security: "tls" },
    smtp: { host: "smtp.example.com", port: 587, security: "starttls" },
    folders: { drafts: "Drafts", sent: "Sent", inbox: "INBOX" },
  },
};

async function insertMailbox(
  overrides: Partial<typeof schema.mailboxConnections.$inferInsert> = {},
) {
  const address = `bootstrap-${randomUUID()}@example.com`;
  const [mailbox] = await db
    .insert(schema.mailboxConnections)
    .values({
      provider: "smtp_imap",
      email: address,
      normalizedEmail: address,
      status: "available",
      encryptedPassword: encryptSecret("s3cret-imap-password", keyring),
      settings: validTransport,
      ...overrides,
    })
    .returning();
  if (!mailbox) throw new Error("mailbox fixture missing");
  return mailbox;
}

describe("smtp_imap provider bootstrap wiring", () => {
  beforeAll(async () => {
    await client.unsafe("drop schema if exists public cascade");
    await client.unsafe("drop schema if exists drizzle cascade");
    await client.unsafe("create schema public");
    await migrate(drizzle(client), { migrationsFolder: "drizzle" });
  });

  afterAll(async () => {
    await client.end();
  });

  it("builds a bound SmtpImapMailProvider from the mailbox row alone, with no Microsoft configuration", async () => {
    const mailbox = await insertMailbox();

    const provider = await createMailProviderForMailbox(db, mailbox.id, {
      microsoftConfig: undefined,
      environment,
    });

    expect(provider.kind).toBe("smtp_imap");
    // Bound to this exact mailbox id -- a mismatched mailboxId is refused
    // without ever touching the network, proving the lazy load actually
    // built a real `SmtpImapMailProvider` around this mailbox's own
    // id/email rather than a stray default: `"mailbox binding mismatch"` is
    // that class's own message, reachable from nowhere else.
    await expect(
      provider.sendDraft({
        draftId: "1:1",
        outreachId: "outreach-1",
        mailboxId: "some-other-mailbox",
      }),
    ).rejects.toThrow("mailbox binding mismatch");
    expect(SmtpImapMailProvider.name).toBe("SmtpImapMailProvider");
  });

  // The three cases below all used to throw *at construction*. They must
  // not: `service-factory.ts` builds providers in argument expressions
  // (`sendApprovedMessage(db, await providerForMessage(...), payload)`),
  // outside every `try`, so a construction-time throw aborts the whole task
  // run rather than failing the one message. `recover-stale-work` is the
  // sharp case -- it handles messages first, so one unbuildable mailbox (an
  // operator clicked "Disconnect" to fix a password, one message stayed
  // `approved`) starved research recovery, email resolution and follow-ups
  // of every tick. `microsoft_graph` never had this problem: its client is
  // lazy and its failures land inside the existing error handling. So the
  // assertion moved from "construction rejects" to "construction resolves,
  // *use* rejects" -- with the same message, in the same place the send path
  // already catches.

  it("does not throw at construction when the mailbox has no stored encrypted password -- it throws on use", async () => {
    const mailbox = await insertMailbox({ encryptedPassword: null });

    const provider = await createMailProviderForMailbox(db, mailbox.id, {
      environment,
    });
    expect(provider.kind).toBe("smtp_imap");

    await expect(
      provider.reconcile({
        outreachId: "outreach-1",
        draftId: null,
        mailboxId: mailbox.id,
      }),
    ).rejects.toThrow(/password/);
  });

  it("does not throw at construction when the mailbox has no valid transport configuration -- it throws on use", async () => {
    const mailbox = await insertMailbox({ settings: {} });

    const provider = await createMailProviderForMailbox(db, mailbox.id, {
      environment,
    });
    expect(provider.kind).toBe("smtp_imap");

    await expect(
      provider.reconcile({
        outreachId: "outreach-1",
        draftId: null,
        mailboxId: mailbox.id,
      }),
    ).rejects.toThrow(/transport/);
  });

  it("does not throw at construction when the token encryption keyring is unavailable -- it throws on use", async () => {
    const mailbox = await insertMailbox();

    const provider = await createMailProviderForMailbox(db, mailbox.id, {
      environment: {
        TOKEN_ENCRYPTION_KEYS: undefined,
        TOKEN_ENCRYPTION_ACTIVE_KEY_ID: undefined,
      },
    });
    expect(provider.kind).toBe("smtp_imap");

    await expect(
      provider.reconcile({
        outreachId: "outreach-1",
        draftId: null,
        mailboxId: mailbox.id,
      }),
    ).rejects.toThrow(/TOKEN_ENCRYPTION/);
  });

  // A rejected load must not be memoized: the send path retries through the
  // same provider object, and caching the rejection would turn a database
  // blip -- or a mailbox repaired between two attempts -- into a permanent
  // failure for the lifetime of that object.
  it("retries the load after a failure instead of caching the rejection", async () => {
    const mailbox = await insertMailbox({ encryptedPassword: null });
    const provider = await createMailProviderForMailbox(db, mailbox.id, {
      environment,
    });
    const use = () =>
      provider.reconcile({
        outreachId: "outreach-1",
        draftId: null,
        mailboxId: mailbox.id,
      });

    await expect(use()).rejects.toThrow(/no stored password/);

    // The row changes between the two attempts: the password is restored and
    // the transport is wiped instead. A cached rejection would still report
    // the *password* failure; a genuine re-read reports the transport one.
    // (Deliberately a second failure rather than a success -- a success here
    // would open a real IMAP socket to a host that does not exist.)
    await db
      .update(schema.mailboxConnections)
      .set({
        encryptedPassword: encryptSecret("repaired-password", keyring),
        settings: {},
      })
      .where(eq(schema.mailboxConnections.id, mailbox.id));

    await expect(use()).rejects.toThrow(/transport/);
  });
});

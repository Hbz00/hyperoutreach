import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as schema from "@/lib/db/schema";
import { resolveDatabaseUrls } from "@/lib/db/test-database";
import type { ImapFetchedMessage, ImapPort } from "@/lib/smtp-imap/imap-client";
import {
  createCountingIngest,
  createInboundCursorWriter,
  defaultInboundCursorEvents,
  reconcileInboundMailbox,
} from "@/modules/mailboxes/inbound-reconciliation";
import { SmtpImapInboundSource } from "@/modules/mailboxes/smtp-imap-inbound-source";
import { normalizeEmail } from "@/modules/prospects/normalization";
import { ingestInboundMessage } from "@/modules/replies/inbound-service";
import { DeterministicReplyClassifier } from "@/modules/replies/reply-classifier";

/**
 * C1 — the whole inbound chain, end to end, against a real database, with a
 * fake only where the network would be.
 *
 * The defect this pins down is invisible to any test of `projectMessage`
 * alone, because the check that fails lives *below* `inboundSchema`:
 * `ingestInboundMessage` runs `normalizeEmail(input.sender)` after zod has
 * already accepted the payload. `normalizeEmail` throws on a single-label
 * domain, so `From: <root@localhost>` — a Zimbra quota notice, a cron mail,
 * a `MAILER-DAEMON` bounce, all ordinary contents of a real inbox — becomes
 * `INVALID_INPUT` **with nothing written to the database**;
 * `reconcileInboundMailbox` turns that into a thrown round, `saveCursor` is
 * downstream of the throw, and the cursor never advances. The next poll
 * refetches the same range and dies identically. Forever: no reply is ever
 * seen again, and because `inbound_reconciliation` sits in the send gate
 * (`send-service.ts`), outbound stops too.
 *
 * So the load-bearing assertion here is not "the record landed" — it is
 * **`mailbox.syncCursor` moved**.
 */

const { testUrl } = resolveDatabaseUrls(process.env);
const client = postgres(testUrl, { max: 4 });
const db = drizzle(client, { schema });

const classifier = new DeterministicReplyClassifier();

function unexpected(name: string): () => never {
  return () => {
    throw new Error(`unexpected fake ImapPort call: ${name}`);
  };
}

/** Only `status`/`fetchRange` are reachable from an inbound round; every
 * other `ImapPort` member throws, so a future change that silently starts
 * calling one shows up as a failure rather than a mocked-away no-op. */
function fakeInbox(messages: ImapFetchedMessage[], uidValidity = 7): ImapPort {
  return {
    status: async () => ({ uidValidity, uidNext: 1_000 }),
    fetchRange: async function* () {
      yield messages;
    },
    // The `since`-bounded anchor for a fresh walk: everything this fake
    // holds is recent, so the walk starts at the lowest uid it has.
    findFirstUidSince: async () =>
      messages.reduce<number | null>(
        (min, message) =>
          min === null || message.uid < min ? message.uid : min,
        null,
      ),
    resolveFolders: unexpected("resolveFolders") as never,
    appendDraft: unexpected("appendDraft") as never,
    findByMessageId: unexpected("findByMessageId") as never,
    moveToSent: unexpected("moveToSent") as never,
    fetchDraftSource: unexpected("fetchDraftSource") as never,
  };
}

function rawMessage(headers: string[]): Buffer {
  return Buffer.from([...headers, "", "Bonjour,", ""].join("\r\n"), "utf-8");
}

async function insertMailbox() {
  const address = `inbound-${randomUUID()}@example.com`;
  const [mailbox] = await db
    .insert(schema.mailboxConnections)
    .values({
      provider: "smtp_imap",
      email: address,
      normalizedEmail: address,
      status: "available",
      lastSyncedAt: new Date(Date.now() - 5 * 60_000),
    })
    .returning();
  if (!mailbox) throw new Error("mailbox fixture missing");
  return mailbox;
}

/** The exact wiring `service-factory.ts`'s "reconcile-inbound-mailbox" task
 * builds, minus the health wrapper — real source, real ingest, real cursor
 * writer. */
async function runRound(
  mailboxId: string,
  imap: ImapPort,
  cursor: string | null,
) {
  const source = new SmtpImapInboundSource(
    imap,
    mailboxId,
    undefined,
    new Date(0),
  );
  const counted = createCountingIngest((message) =>
    ingestInboundMessage(db, classifier, message),
  );
  return reconcileInboundMailbox(
    { source, mailboxId },
    {
      loadCursor: async () => cursor,
      saveCursor: createInboundCursorWriter(db, {
        events: defaultInboundCursorEvents("smtp_imap"),
        startedAt: new Date(),
      }),
      ingest: counted.ingest,
    },
  );
}

describe("inbound chain: an unnormalizable sender must not freeze the mailbox", () => {
  beforeAll(async () => {
    await client.unsafe("drop schema if exists public cascade");
    await client.unsafe("drop schema if exists drizzle cascade");
    await client.unsafe("create schema public");
    await migrate(drizzle(client), { migrationsFolder: "drizzle" });
  });

  afterAll(async () => {
    await client.end();
  });

  it("ingests a From: <root@localhost> system notice and advances the cursor", async () => {
    // The premise, proved rather than assumed: it really is `normalizeEmail`
    // — not `inboundSchema`, whose `sender` rule is only
    // `.trim().min(1).max(500)` — that refuses this address.
    expect(() => normalizeEmail("root@localhost")).toThrow();

    const mailbox = await insertMailbox();
    const imap = fakeInbox([
      {
        uid: 42,
        envelope: {
          messageId: "<quota-warning@localhost>",
          subject: "Quota exceeded",
          from: "root@localhost",
          to: mailbox.email,
          date: new Date(),
        },
        internalDate: new Date(),
        body: rawMessage([
          "From: <root@localhost>",
          `To: ${mailbox.email}`,
          "Subject: Quota exceeded",
          "Message-ID: <quota-warning@localhost>",
        ]),
      } as ImapFetchedMessage,
    ]);

    const round = await runRound(mailbox.id, imap, null);

    expect(round.processed).toBe(1);
    expect(round.nextCursor).toBe("7:42");

    // THE assertion. Without the fix the round throws before this write, the
    // cursor stays null, and every later round replays the same failure.
    const [stored] = await db
      .select()
      .from(schema.mailboxConnections)
      .where(eq(schema.mailboxConnections.id, mailbox.id));
    expect(stored?.syncCursor).toBe("7:42");

    // The record is visible to an operator rather than silently dropped, and
    // it still carries what the message actually said.
    const [record] = await db
      .select()
      .from(schema.inboundRecords)
      .where(eq(schema.inboundRecords.mailboxId, mailbox.id));
    expect(record?.metadata.sender).toBe("unknown-sender@unparseable.invalid");
    expect(record?.metadata.unparseableSender).toBe("root@localhost");
  });

  // Même classe que C1, par la porte de l'*encodage* plutôt que de la
  // largeur. PostgreSQL refuse `U+0000` partout : `22P05 unsupported Unicode
  // escape sequence` sur l'insert `jsonb` de `inbound_records.metadata`,
  // `22021 invalid byte sequence for encoding "UTF8"` sur les colonnes
  // `text` de `replies`. `DATABASE_ERROR` → `throw` → curseur gelé. Ce test
  // le prouve contre le vrai Postgres, seul juge en la matière.
  it("ingests a message carrying a NUL byte and advances the cursor", async () => {
    const mailbox = await insertMailbox();
    const body = "Bonjour,\u0000 ce corps porte un octet nul.";
    const imap = fakeInbox([
      {
        uid: 77,
        envelope: {
          messageId: "<nul-byte@example.com>",
          subject: "Re:\u0000 outreach",
          from: "prospect@example.com",
          to: mailbox.email,
          date: new Date(),
        },
        internalDate: new Date(),
        body: Buffer.from(
          [
            "From: prospect@example.com",
            `To: ${mailbox.email}`,
            "Subject: Re:\u0000 outreach",
            "Message-ID: <nul-byte@example.com>",
            "",
            body,
            "",
          ].join("\r\n"),
          "utf-8",
        ),
      } as ImapFetchedMessage,
    ]);

    const round = await runRound(mailbox.id, imap, null);

    expect(round.processed).toBe(1);
    const [stored] = await db
      .select()
      .from(schema.mailboxConnections)
      .where(eq(schema.mailboxConnections.id, mailbox.id));
    expect(stored?.syncCursor).toBe("7:77");

    // Le message est bien lisible : l'octet a disparu, pas le contenu — et
    // il a traversé jusqu'aux colonnes `text` de `replies`, pas seulement le
    // `jsonb` de `inbound_records`.
    const [record] = await db
      .select()
      .from(schema.inboundRecords)
      .where(eq(schema.inboundRecords.mailboxId, mailbox.id));
    expect(record?.metadata.body).toContain("ce corps porte un octet nul");
    expect(JSON.stringify(record?.metadata)).not.toContain("\u0000");

    const [reply] = await db
      .select()
      .from(schema.replies)
      .where(eq(schema.replies.inboundRecordId, record!.id));
    expect(reply?.body).toContain("ce corps porte un octet nul");
    expect(reply?.body).not.toContain("\u0000");
    expect(reply?.subject).not.toContain("\u0000");
  });

  it("keeps advancing across a second round so the next poll is not a replay", async () => {
    const mailbox = await insertMailbox();
    const first = await runRound(
      mailbox.id,
      fakeInbox([
        {
          uid: 10,
          envelope: {
            messageId: "<cron@localhost>",
            subject: "Cron",
            from: "root@localhost",
            to: mailbox.email,
            date: new Date(),
          },
          internalDate: new Date(),
          body: rawMessage([
            "From: MAILER-DAEMON",
            `To: ${mailbox.email}`,
            "Subject: Cron",
            "Message-ID: <cron@localhost>",
          ]),
        } as ImapFetchedMessage,
      ]),
      null,
    );
    expect(first.nextCursor).toBe("7:10");

    // A genuine prospect reply arriving behind the poison pill: the whole
    // point of C1 is that this one is still seen.
    const second = await runRound(
      mailbox.id,
      fakeInbox([
        {
          uid: 11,
          envelope: {
            messageId: "<reply@example.com>",
            subject: "Re: outreach",
            from: "prospect@example.com",
            to: mailbox.email,
            date: new Date(),
          },
          internalDate: new Date(),
          body: rawMessage([
            "From: prospect@example.com",
            `To: ${mailbox.email}`,
            "Subject: Re: outreach",
            "Message-ID: <reply@example.com>",
          ]),
        } as ImapFetchedMessage,
      ]),
      first.nextCursor,
    );

    expect(second.processed).toBe(1);
    const [stored] = await db
      .select()
      .from(schema.mailboxConnections)
      .where(eq(schema.mailboxConnections.id, mailbox.id));
    expect(stored?.syncCursor).toBe("7:11");

    const [reply] = await db
      .select()
      .from(schema.inboundRecords)
      .where(
        and(
          eq(schema.inboundRecords.mailboxId, mailbox.id),
          eq(schema.inboundRecords.internetMessageId, "<reply@example.com>"),
        ),
      );
    expect(reply?.metadata.sender).toBe("prospect@example.com");
  });
});

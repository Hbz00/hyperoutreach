import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { ImapFlow } from "imapflow";
import nodemailer from "nodemailer";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as schema from "@/lib/db/schema";
import { resolveDatabaseUrls } from "@/lib/db/test-database";
import { ImapClient } from "@/lib/smtp-imap/imap-client";
import {
  createCountingIngest,
  createInboundCursorWriter,
  defaultInboundCursorEvents,
  reconcileInboundMailbox,
} from "@/modules/mailboxes/inbound-reconciliation";
import { SmtpImapInboundSource } from "@/modules/mailboxes/smtp-imap-inbound-source";
import { ingestInboundMessage } from "@/modules/replies/inbound-service";
import { DeterministicReplyClassifier } from "@/modules/replies/reply-classifier";

/**
 * Does stopping the local stack lose inbound mail?
 *
 * The maintenance worker is a ticker: it holds no state and only asks the
 * application to run a cycle. The claim under test is therefore about the
 * cycle, not the worker — that inbound reconciliation is catch-up rather than
 * a live listener, so any amount of downtime costs latency and nothing else.
 *
 * Two facts are proved here against a real IMAP server, real SMTP delivery and
 * a real database:
 *
 *  1. Mail delivered while no cycle is running is ingested by the next cycle.
 *     The second round reads its cursor back out of the database rather than
 *     receiving it from the first round, because surviving the process is the
 *     whole point.
 *
 *  2. A cycle killed mid-round (`SIGKILL`, which the supervisor's second-Ctrl+C
 *     escalation now sends) loses nothing: the cursor only advances after
 *     durable ingestion, so the next round replays the same range and the
 *     already-stored messages resurface as duplicates-by-key rather than being
 *     written twice.
 */

const GREENMAIL_HOST = "127.0.0.1";
// Host ports from docker-compose.yml's `greenmail` service, both implicit TLS.
const GREENMAIL_IMAPS_PORT = 3993;
const GREENMAIL_SMTPS_PORT = 3587;
const READINESS_TIMEOUT_MS = 1_500;

async function protocolsAreReady(auth: {
  user: string;
  pass: string;
}): Promise<boolean> {
  const imap = new ImapFlow({
    host: GREENMAIL_HOST,
    port: GREENMAIL_IMAPS_PORT,
    secure: true,
    auth,
    logger: false,
    tls: { rejectUnauthorized: false },
    connectionTimeout: READINESS_TIMEOUT_MS,
    greetingTimeout: READINESS_TIMEOUT_MS,
    socketTimeout: READINESS_TIMEOUT_MS,
  });
  const transporter = nodemailer.createTransport({
    host: GREENMAIL_HOST,
    port: GREENMAIL_SMTPS_PORT,
    secure: true,
    auth,
    tls: { rejectUnauthorized: false },
    connectionTimeout: READINESS_TIMEOUT_MS,
    greetingTimeout: READINESS_TIMEOUT_MS,
    socketTimeout: READINESS_TIMEOUT_MS,
  });
  try {
    await imap.connect();
    await imap.logout();
    await transporter.verify();
    return true;
  } catch {
    imap.close();
    return false;
  } finally {
    transporter.close();
  }
}

const readinessAuth = { user: "readiness@greenmail.local", pass: "readiness" };
let greenmailAvailable = false;
for (let attempt = 0; attempt < 5 && !greenmailAvailable; attempt += 1) {
  greenmailAvailable = await protocolsAreReady(readinessAuth);
  if (!greenmailAvailable)
    await new Promise((resolve) => setTimeout(resolve, 500));
}

// Same doctrine as `smtp-imap-round-trip.test.ts`: GreenMail ships a
// self-signed keystore and `ImapClient` hardcodes its TLS options, so the
// process-wide switch is the only seam — and it is only flipped on the very
// condition that decides whether this suite runs at all.
const originalTlsRejectUnauthorized = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
if (greenmailAvailable) {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
} else {
  process.stderr.write(
    "[inbound-downtime-recovery] GreenMail is not reachable on " +
      `${GREENMAIL_HOST}:${GREENMAIL_IMAPS_PORT}/${GREENMAIL_SMTPS_PORT} — skipping. ` +
      "Start it with `docker-compose up -d greenmail`.\n",
  );
}

const { testUrl } = resolveDatabaseUrls(process.env);
const client = postgres(testUrl, { max: 4 });
const db = drizzle(client, { schema });
const classifier = new DeterministicReplyClassifier();

describe.skipIf(!greenmailAvailable)(
  "inbound reconciliation survives a stopped stack",
  () => {
    const address = `downtime-${randomUUID()}@greenmail.local`;
    const credentials = { user: address, pass: "secret" };
    const transport = {
      username: address,
      imap: {
        host: GREENMAIL_HOST,
        port: GREENMAIL_IMAPS_PORT,
        security: "tls" as const,
      },
      smtp: {
        host: GREENMAIL_HOST,
        port: GREENMAIL_SMTPS_PORT,
        security: "tls" as const,
      },
      folders: { drafts: "Drafts", sent: "Sent", inbox: "INBOX" },
    };
    let mailboxId: string;

    /** Real SMTP delivery into the mailbox under test. */
    async function deliver(subject: string, body: string) {
      const transporter = nodemailer.createTransport({
        host: GREENMAIL_HOST,
        port: GREENMAIL_SMTPS_PORT,
        secure: true,
        auth: credentials,
        tls: { rejectUnauthorized: false },
      });
      try {
        await transporter.sendMail({
          from: "prospect@example.com",
          to: address,
          subject,
          text: body,
        });
      } finally {
        transporter.close();
      }
    }

    /** The cursor as it survives a process restart: read from the database,
     * never carried over in memory from the previous round. */
    async function persistedCursor(): Promise<string | null> {
      const [row] = await db
        .select({ syncCursor: schema.mailboxConnections.syncCursor })
        .from(schema.mailboxConnections)
        .where(eq(schema.mailboxConnections.id, mailboxId));
      return row?.syncCursor ?? null;
    }

    async function storedCount(): Promise<number> {
      const rows = await db
        .select({ id: schema.inboundRecords.id })
        .from(schema.inboundRecords)
        .where(eq(schema.inboundRecords.mailboxId, mailboxId));
      return rows.length;
    }

    /** The wiring `service-factory.ts` builds for the inbound stage, with a
     * real `ImapClient` in place of the fake used elsewhere. `ingest` is
     * injectable so a round can be cut short exactly like a killed process. */
    async function runCycle(
      cursor: string | null,
      ingest = (message: Parameters<typeof ingestInboundMessage>[2]) =>
        ingestInboundMessage(db, classifier, message),
    ) {
      const source = new SmtpImapInboundSource(
        new ImapClient(transport, credentials),
        mailboxId,
        undefined,
        new Date(0),
      );
      const counted = createCountingIngest(ingest);
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

    beforeAll(async () => {
      await client.unsafe("drop schema if exists public cascade");
      await client.unsafe("drop schema if exists drizzle cascade");
      await client.unsafe("create schema public");
      await migrate(drizzle(client), { migrationsFolder: "drizzle" });
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
      mailboxId = mailbox.id;
    });

    afterAll(async () => {
      await client.end();
      if (greenmailAvailable) {
        if (originalTlsRejectUnauthorized === undefined)
          delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
        else
          process.env.NODE_TLS_REJECT_UNAUTHORIZED =
            originalTlsRejectUnauthorized;
      }
    });

    it("ingests mail that arrived while no cycle was running", async () => {
      await deliver("before the stop", "Message delivered while running.");
      const first = await runCycle(await persistedCursor());
      expect(first.processed).toBe(1);
      const cursorAtShutdown = await persistedCursor();
      expect(cursorAtShutdown).not.toBeNull();

      // ---- the stack is down: no cycle runs, mail keeps arriving ----
      await deliver("during the stop #1", "Arrived with nothing running.");
      await deliver("during the stop #2", "Also arrived with nothing running.");

      // ---- restart: the cursor comes back from the database ----
      const resumed = await persistedCursor();
      expect(resumed).toBe(cursorAtShutdown);
      const second = await runCycle(resumed);

      // Both downtime messages ingested, and the pre-downtime one not again.
      expect(second.processed).toBe(2);
      expect(await storedCount()).toBe(3);
      expect(await persistedCursor()).not.toBe(cursorAtShutdown);
    });

    it("loses nothing when a cycle is killed mid-round", async () => {
      const cursorBeforeCrash = await persistedCursor();
      const storedBeforeCrash = await storedCount();
      await deliver("crash round #1", "First of the interrupted round.");
      await deliver("crash round #2", "Second of the interrupted round.");

      // A process killed mid-round: the first message is ingested durably,
      // then everything stops before the cursor is written.
      let seen = 0;
      await expect(
        runCycle(cursorBeforeCrash, async (message) => {
          seen += 1;
          if (seen > 1) throw new Error("killed mid-round");
          return ingestInboundMessage(db, classifier, message);
        }),
      ).rejects.toThrow();

      // The load-bearing assertion: the cursor did not move, so the next
      // round replays the same range instead of skipping past it.
      expect(await persistedCursor()).toBe(cursorBeforeCrash);

      // The message ingested before the kill is durable; only the cursor was
      // lost, which is what makes the replay both necessary and safe.
      expect(await storedCount()).toBe(storedBeforeCrash + 1);

      await runCycle(await persistedCursor());

      // No loss and no duplicate, asserted on message identity rather than on
      // the round's own counter: the replay re-runs an interrupted ingestion to
      // completion, so it legitimately reports work for a row it did not
      // insert. The unique key is what proves nothing was written twice.
      const keys = await db
        .select({
          providerNotificationId: schema.inboundRecords.providerNotificationId,
        })
        .from(schema.inboundRecords)
        .where(eq(schema.inboundRecords.mailboxId, mailboxId));
      expect(keys).toHaveLength(storedBeforeCrash + 2);
      expect(new Set(keys.map((row) => row.providerNotificationId)).size).toBe(
        storedBeforeCrash + 2,
      );
      expect(await persistedCursor()).not.toBe(cursorBeforeCrash);
    });
  },
);

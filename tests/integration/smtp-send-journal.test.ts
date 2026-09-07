import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as schema from "@/lib/db/schema";
import { resolveDatabaseUrls } from "@/lib/db/test-database";
import { WorkflowEventsSendJournal } from "@/modules/mailboxes/smtp-send-journal";

// `WorkflowEventsSendJournal` backs the one guarantee this whole feature
// exists for: a message is never submitted to SMTP twice. Its two
// load-bearing properties are claims about how Postgres/drizzle actually
// behave (`onConflictDoNothing().returning()` yields no row on a conflict;
// the *partial* unique index on `idempotency_key` is the arbiter Postgres
// picks with no explicit conflict target) — not claims a unit test doubling
// `AppDatabase` could establish. Requires a real Postgres via
// `resolveDatabaseUrls`, exactly like every other file in this directory.
const { testUrl } = resolveDatabaseUrls(process.env);
const client = postgres(testUrl, { max: 4 });
const db = drizzle(client, { schema });

function freshMessageKey(): string {
  return `<outreach-${crypto.randomUUID()}.hyperoutreach@d.tld>`;
}

describe("WorkflowEventsSendJournal", () => {
  beforeAll(async () => {
    await client.unsafe("drop schema if exists public cascade");
    await client.unsafe("drop schema if exists drizzle cascade");
    await client.unsafe("create schema public");
    await migrate(drizzle(client), { migrationsFolder: "drizzle" });
  });

  afterAll(async () => {
    await client.end();
  });

  it("recordAttempt returns true for the first call and false for a repeat on the same key", async () => {
    const journal = new WorkflowEventsSendJournal(db);
    const messageKey = freshMessageKey();

    await expect(journal.recordAttempt(messageKey)).resolves.toBe(true);
    await expect(journal.recordAttempt(messageKey)).resolves.toBe(false);
  });

  it("hasAcceptance turns true only after recordAcceptance", async () => {
    const journal = new WorkflowEventsSendJournal(db);
    const messageKey = freshMessageKey();

    await expect(journal.hasAcceptance(messageKey)).resolves.toBe(false);
    await journal.recordAcceptance(messageKey);
    await expect(journal.hasAcceptance(messageKey)).resolves.toBe(true);
  });

  it("lets exactly one of two concurrent recordAttempt calls on the same key win", async () => {
    // The property `sendDraft`'s TOCTOU hardening actually depends on:
    // two callers racing `recordAttempt` for the same outreach must not
    // both observe "I am the first attempt" — that would let both proceed
    // to `smtp.submit`, exactly the double send this journal exists to
    // prevent. This can only be proven against a real database.
    const journal = new WorkflowEventsSendJournal(db);
    const messageKey = freshMessageKey();

    const results = await Promise.all([
      journal.recordAttempt(messageKey),
      journal.recordAttempt(messageKey),
    ]);

    expect(results.filter(Boolean)).toHaveLength(1);
  });

  // Task 10 bis: a definite SMTP rejection (a 4xx/5xx response, as opposed
  // to a connection-level failure) must not leave the attempt mutex
  // committed forever the way any `smtp.submit` failure used to — see
  // `smtp-imap-mail-provider.ts`'s `SmtpRejectionDetails` doc. These
  // properties are specifically about `onConflictDoNothing`'s unique index
  // and the paired `DELETE` actually taking effect against a real Postgres
  // instance, not something a unit test doubling `AppDatabase` could prove.
  describe("recordRejection", () => {
    it("releases the attempt (releaseAttempt: true) so recordAttempt reports first-attempt again", async () => {
      const journal = new WorkflowEventsSendJournal(db);
      const messageKey = freshMessageKey();

      await expect(journal.recordAttempt(messageKey)).resolves.toBe(true);
      await journal.recordRejection(messageKey, {
        responseCode: 451,
        response: "451 4.7.1 Greylisted, try again later",
        releaseAttempt: true,
      });

      await expect(journal.hasAttempt(messageKey)).resolves.toBe(false);
      // The mutex was actually deleted, not merely marked — a second
      // `recordAttempt` must be able to insert a fresh row and win.
      await expect(journal.recordAttempt(messageKey)).resolves.toBe(true);
    });

    it.each([
      { kind: "single line", response: "550 5.1.1 No such user" },
      {
        kind: "multiline with final status beyond the diagnostic read limit",
        // Each line fits SMTP's 512-octet limit, and every line repeats the
        // same enhanced status (RFC 2034). Nodemailer preserves the prefixes.
        response: [
          ...Array.from({ length: 3 }, () => `550-5.1.1 ${"x".repeat(390)}`),
          "550 5.1.1 No such user",
        ].join("\n"),
      },
    ])(
      "retains the attempt and hard-bounce status for a permanent $kind rejection",
      async ({ response }) => {
        const journal = new WorkflowEventsSendJournal(db);
        const messageKey = freshMessageKey();

        await expect(journal.recordAttempt(messageKey)).resolves.toBe(true);
        await journal.recordRejection(messageKey, {
          responseCode: 550,
          response,
          smtpErrorCode: "EENVELOPE",
          releaseAttempt: false,
        });

        await expect(journal.hasAttempt(messageKey)).resolves.toBe(true);
        await expect(journal.recordAttempt(messageKey)).resolves.toBe(false);
        // Fresh journal reads must preserve the classification after a restart,
        // without retaining server prose in the persisted diagnostic.
        await expect(
          new WorkflowEventsSendJournal(db).getPermanentRejection(messageKey),
        ).resolves.toEqual({
          responseCode: 550,
          response: "SMTP 550 5.1.1",
          smtpErrorCode: "EENVELOPE",
          releaseAttempt: false,
        });
      },
    );

    it("persists a permanent audit row for the rejection even when it releases the attempt", async () => {
      const journal = new WorkflowEventsSendJournal(db);
      const messageKey = freshMessageKey();

      await journal.recordAttempt(messageKey);
      await journal.recordRejection(messageKey, {
        responseCode: 451,
        response: "451 4.7.1 Greylisted, try again later",
        releaseAttempt: true,
      });

      const rows = await db
        .select()
        .from(schema.workflowEvents)
        .where(eq(schema.workflowEvents.event, "smtp.rejected"));
      const match = rows.find(
        (row) =>
          (row.payload as Record<string, unknown>).messageKey === messageKey,
      );

      expect(match).toBeDefined();
      expect(match?.payload).toMatchObject({
        messageKey,
        responseCode: 451,
        response: "SMTP 451 4.7.1",
        released: true,
      });
      expect(match?.error).toBe("SMTP 451 4.7.1");
      expect(JSON.stringify(match)).not.toContain(
        "Greylisted, try again later",
      );
      // Never a mutex: the partial unique index only applies to non-null
      // keys, so this row deliberately carries none.
      expect(match?.idempotencyKey).toBeNull();
    });

    it("keeps a separate audit row per rejection, even for the same key across retries", async () => {
      // A greylisted message can legitimately be rejected more than once
      // before it finally goes through — each occurrence must be logged,
      // not deduplicated away.
      const journal = new WorkflowEventsSendJournal(db);
      const messageKey = freshMessageKey();

      await journal.recordAttempt(messageKey);
      await journal.recordRejection(messageKey, {
        responseCode: 451,
        response: "451 first greylist",
        releaseAttempt: true,
      });
      await journal.recordAttempt(messageKey);
      await journal.recordRejection(messageKey, {
        responseCode: 451,
        response: "451 second greylist",
        releaseAttempt: true,
      });

      const rows = await db
        .select()
        .from(schema.workflowEvents)
        .where(eq(schema.workflowEvents.event, "smtp.rejected"));
      const matches = rows.filter(
        (row) =>
          (row.payload as Record<string, unknown>).messageKey === messageKey,
      );

      expect(matches).toHaveLength(2);
      // Both attempts were actually released — the second recordAttempt
      // above only succeeded because the first rejection deleted the mutex.
      await expect(journal.hasAttempt(messageKey)).resolves.toBe(false);
    });
  });
});

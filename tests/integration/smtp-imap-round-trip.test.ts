import { randomBytes, randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { ImapFlow } from "imapflow";
import nodemailer from "nodemailer";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as schema from "@/lib/db/schema";
import { resolveDatabaseUrls } from "@/lib/db/test-database";
import {
  ImapClient,
  type MailboxCredentials,
} from "@/lib/smtp-imap/imap-client";
import { outreachMessageId } from "@/lib/smtp-imap/message-id";
import { buildMime } from "@/lib/smtp-imap/mime";
import {
  readTransport,
  type MailboxTransport,
} from "@/lib/smtp-imap/transport-config";
import "@/modules/mailboxes/inbound-source-bootstrap";
import { createOrGetAccount } from "@/modules/accounts/service";
import {
  createDraftCampaign,
  enrollContact,
  publishCampaignVersion,
} from "@/modules/campaigns/service";
import { createOrGetContact } from "@/modules/contacts/service";
import {
  defaultInboundNaming,
  reconcileInboundMailbox,
} from "@/modules/mailboxes/inbound-reconciliation";
import { resolveInboundProvider } from "@/modules/mailboxes/inbound-source-registry";
import { createMailProviderForMailbox } from "@/modules/mailboxes/provider-factory";
import { connectSmtpImapMailbox } from "@/modules/mailboxes/smtp-imap-connection-service";
import { generateOutreachProposal } from "@/modules/messages/generation-service";
import { reviewMessage } from "@/modules/messages/review-service";
import { sendApprovedMessage } from "@/modules/messages/send-service";
import { ingestInboundMessage } from "@/modules/replies/inbound-service";
import { DeterministicReplyClassifier } from "@/modules/replies/reply-classifier";
import { createWorkflowTaskServices } from "@/modules/workflows/service-factory";

/**
 * Task 14, brief step 3 + requirement (c): the only place in this codebase's
 * tests that opens a real socket to a real IMAP/SMTP server. Every other
 * `smtp_imap`/`ImapPort`/`SmtpPort` test — unit or integration — doubles the
 * transport; this file is the actual proof that the assumptions those
 * doubles encode are true against a real server (GreenMail,
 * `docker-compose.yml`), specifically:
 *
 *  - `UID FETCH`/`SEARCH` with `{uid: true}` really queries by UID, not
 *    sequence number. Proven with a *discriminating* setup, not merely a
 *    plausible one: a single-survivor mailbox (one message left after an
 *    EXPUNGE) cannot tell the two apart, because `*` resolves to the
 *    highest UID *or* the highest sequence number depending on which was
 *    meant, and with one message left those coincide either way (fix round
 *    1 caught this in the original version of this test). Two survivors
 *    after the EXPUNGE, positioned so the UID-range and the
 *    sequence-range produce *different* message counts, is what actually
 *    discriminates — see "really fetches inbound mail by UID" below, and
 *    the paired Drafts-folder check for the `search()` call site
 *    independently of the `fetch()` one.
 *  - `APPENDUID` is really returned by `APPEND` (`appendDraft`'s primary
 *    path) or the Message-ID fallback search actually works.
 *  - Folder names are correctly discovered — by special-use flag for
 *    Drafts, and by the *conventional-name fallback* for Sent. Both
 *    folders were originally named literally `Drafts`/`Sent`, which made
 *    every check pass via the special-use branch alone; empirically,
 *    GreenMail auto-tags every name in this codebase's own
 *    `SENT_CONVENTIONAL_NAMES` with `\Sent` special-use *except* one:
 *    `Sent`, `Sent Items`, and `Envoyés` (accented) are all auto-tagged
 *    (verified directly against the running container, reproduced three
 *    times — this contradicts an earlier version of this comment, which
 *    claimed `Sent Items` was not auto-tagged; that claim was wrong, most
 *    likely because it was checked with more than one sent-like folder
 *    present in the same mailbox at once, where only the first-created
 *    folder captures the special-use tag and masks the others' real
 *    behavior). Only `Envoyes` (no accent) is not auto-tagged. The Sent
 *    folder is named `Envoyes` below specifically to force its
 *    resolution through the conventional-name fallback, independently of
 *    the special-use branch Drafts still exercises (every name in
 *    `DRAFTS_CONVENTIONAL_NAMES` is auto-tagged by GreenMail, so that
 *    branch is not independently reachable against this particular
 *    server).
 *  - The RFC 5322 source actually sitting in Sent, *and* the copy GreenMail
 *    actually delivered into the prospect's own mailbox over SMTP, are
 *    both byte-identical (once base64-decoded) to what was drafted. Sent
 *    alone is not sufficient proof of the second half: it holds the
 *    *moved draft* (the `APPEND` bytes), not what the SMTP server actually
 *    received and delivered — a `fetchDraftSource` that silently returned
 *    corrupted content would still show a `250 OK` from GreenMail and a
 *    perfectly intact Sent copy. Only reading the prospect's own inbox
 *    closes that gap.
 *  - `moveToSent` really moves (not copies) the message.
 *
 * A test failure whose *cause* is one of these assumptions being false
 * against a real server is a major finding about this whole feature, not a
 * bug in this test — see the task-14 report for how any such finding is
 * handled.
 */

const GREENMAIL_HOST = "127.0.0.1";
// Host ports from docker-compose.yml's `greenmail` service -- both map onto
// GreenMail's *implicit*-TLS variants (imaps/smtps), matching
// `security: "tls"` below (this transport schema has no plaintext path).
const GREENMAIL_IMAPS_PORT = 3993;
const GREENMAIL_SMTPS_PORT = 3587;

const GREENMAIL_READINESS_TIMEOUT_MS = 1_500;
const GREENMAIL_READINESS_AUTH = {
  user: "readiness@greenmail.local",
  pass: "readiness",
};

async function probeImaps(): Promise<void> {
  const imap = new ImapFlow({
    host: GREENMAIL_HOST,
    port: GREENMAIL_IMAPS_PORT,
    secure: true,
    auth: GREENMAIL_READINESS_AUTH,
    logger: false,
    tls: { rejectUnauthorized: false },
    connectionTimeout: GREENMAIL_READINESS_TIMEOUT_MS,
    greetingTimeout: GREENMAIL_READINESS_TIMEOUT_MS,
    socketTimeout: GREENMAIL_READINESS_TIMEOUT_MS,
  });
  try {
    await imap.connect();
    await imap.logout();
  } catch (error) {
    imap.close();
    throw error;
  }
}

async function probeSmtps(): Promise<void> {
  const transporter = nodemailer.createTransport({
    host: GREENMAIL_HOST,
    port: GREENMAIL_SMTPS_PORT,
    secure: true,
    auth: GREENMAIL_READINESS_AUTH,
    tls: { rejectUnauthorized: false },
    connectionTimeout: GREENMAIL_READINESS_TIMEOUT_MS,
    greetingTimeout: GREENMAIL_READINESS_TIMEOUT_MS,
    socketTimeout: GREENMAIL_READINESS_TIMEOUT_MS,
  });
  try {
    await transporter.verify();
  } finally {
    transporter.close();
  }
}

async function protocolsAreReady(): Promise<boolean> {
  const results = await Promise.allSettled([probeImaps(), probeSmtps()]);
  return results.every((result) => result.status === "fulfilled");
}

// A raw TCP connect/destroy against an implicit-TLS port is not a harmless
// availability check: GreenMail 2.1.6 can leave its IMAP handler spinning on
// EOF indefinitely. Complete the real TLS protocols and their LOGOUT/QUIT
// shutdowns instead. A short retry loop still distinguishes a starting
// container from an absent one.
async function waitForGreenmail(): Promise<boolean> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    if (await protocolsAreReady()) return true;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

const greenmailAvailable = await waitForGreenmail();

// GreenMail's own image ships a self-signed TLS keystore
// (`-Dgreenmail.tls.keystore.file=...` baked into its default
// `GREENMAIL_OPTS`, confirmed by inspecting the published image directly).
// `ImapClient`/`SmtpClient` hardcode their TLS options (`transport-config.ts`
// only carries `security: "tls" | "starttls"`, nothing to plumb a
// `rejectUnauthorized: false` through) and offer no way to trust a specific
// test certificate on the two *production* code paths this file deliberately
// exercises unmodified (`connectSmtpImapMailbox`'s real `verifyTransport`,
// `createMailProviderForMailbox`'s real provider construction) -- this
// process-wide switch is the only seam available for those two call sites.
// Every other TLS connection this file opens (`withRawImap`, below) passes
// `tls: { rejectUnauthorized: false }` per-connection instead, which
// `imapflow` already supports natively -- shrinking what actually depends on
// this global switch to just the two production paths, not everything in
// this file.
//
// Fix round 1 found this mutated unconditionally at module scope, restored
// only in this describe block's own `afterAll` -- which `describe.skipIf`
// below never runs when the container is absent, the *normal* case on a
// fresh clone or in CI with no `docker-compose up -d greenmail` step yet.
// The switch was then left at `"0"` (all TLS certificate validation
// disabled, for every host, for the rest of the process) with nothing ever
// scheduled to undo it. The fix is not a more careful restore path -- it is
// not mutating global process state at all on the path where nothing needs
// it: the mutation itself is now conditional on `greenmailAvailable`, the
// same condition `describe.skipIf` gates on, so the two conditions can never
// disagree about whether this suite (and therefore this mutation) will run.
const originalTlsRejectUnauthorized = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
if (greenmailAvailable) {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
} else {
  const notice =
    "[smtp-imap-round-trip] GreenMail is not reachable on " +
    `${GREENMAIL_HOST}:${GREENMAIL_IMAPS_PORT}/${GREENMAIL_SMTPS_PORT} -- skipping the ` +
    "real IMAP/SMTP round-trip suite. Start it with `docker-compose up -d greenmail` " +
    "(see docker-compose.yml) and re-run `npm run test:integration`.\n";
  // A direct stream write, not just `console.warn`: vitest's default
  // reporter (unlike `--reporter=verbose`) does not surface per-file
  // `console.*` output next to a bare "1 skipped" summary line, which would
  // otherwise leave *why* the suite was skipped invisible on the one command
  // (`npm run test:integration`) this task's own instructions require to be
  // run and read. Writing straight to the process's own stderr bypasses
  // that reporter-level filtering and is what actually reaches the
  // terminal — verified empirically, not assumed.
  process.stderr.write(notice);
}

const { testUrl } = resolveDatabaseUrls(process.env);
const client = postgres(testUrl, { max: 4 });
const db = drizzle(client, { schema });

// Its own disposable keyring, matching `smtp-imap-provider-bootstrap.test.ts`
// and `send-reliability.test.ts`'s own convention: never depends on (or
// clobbers) real process env state.
const keyringActiveKeyId = "round-trip-v1";
const testEnvironment = {
  TOKEN_ENCRYPTION_ACTIVE_KEY_ID: keyringActiveKeyId,
  TOKEN_ENCRYPTION_KEYS: `${keyringActiveKeyId}:${randomBytes(32).toString("base64")}`,
};

/** Base64-decodes the body of a `buildMime`-shaped RFC 5322 source (the
 * portion after the first blank line, CRLF-folded base64) -- used to prove
 * both the message sitting in Sent *and* the copy delivered into the
 * prospect's own mailbox, each read back independently via a raw `imapflow`
 * connection, carry the exact same body `generateOutreachProposal` produced.
 * Headers a real SMTP hop prepends (`Return-Path`, `Received`) sit *before*
 * the first blank line, so they never shift where this starts reading. */
/** The exact `workflowEvents` row `send-service.ts`'s inbound gate reads for
 * an `smtp_imap` mailbox, addressed through `defaultInboundNaming` rather
 * than a hand-typed key so this helper cannot drift from the producer. */
async function sendGateHealth(mailboxId: string) {
  const [row] = await db
    .select()
    .from(schema.workflowEvents)
    .where(
      eq(
        schema.workflowEvents.idempotencyKey,
        defaultInboundNaming("smtp_imap", mailboxId).healthKey,
      ),
    );
  return row;
}

function decodeMimeBody(rawSource: string): string {
  const separator = rawSource.search(/\r?\n\r?\n/);
  if (separator === -1) return "";
  const body = rawSource.slice(separator).replace(/^\r?\n\r?\n/, "");
  return Buffer.from(body.replace(/\r?\n/g, ""), "base64").toString("utf-8");
}

async function withRawImap<T>(
  auth: { user: string; pass: string },
  fn: (imap: ImapFlow) => Promise<T>,
): Promise<T> {
  const imap = new ImapFlow({
    host: GREENMAIL_HOST,
    port: GREENMAIL_IMAPS_PORT,
    secure: true,
    auth,
    logger: false,
    // Per-connection trust of GreenMail's self-signed cert -- does not rely
    // on `NODE_TLS_REJECT_UNAUTHORIZED` at all (`imapflow` supports this
    // natively), unlike `ImapClient`/`SmtpClient` below.
    tls: { rejectUnauthorized: false },
  });
  await imap.connect();
  try {
    return await fn(imap);
  } finally {
    await imap.logout().catch(() => {});
  }
}

/** `imapflow`'s own `AppendResponseObject` types `uidValidity`/`uid` as
 * optional (only populated when the server supports UIDPLUS) -- narrows to a
 * fully-populated result or throws, both so later UID arithmetic in this
 * file never has to guard against `undefined` again and because a missing
 * `APPENDUID` here would itself be a finding about GreenMail's UIDPLUS
 * support (a priority check for this whole task), not something to paper
 * over with a fallback. */
function requireAppendUid(
  result: { uidValidity?: bigint; uid?: number } | false | undefined,
): { uidValidity: bigint; uid: number } {
  if (!result || result.uidValidity === undefined || result.uid === undefined) {
    throw new Error(
      "IMAP APPEND did not return APPENDUID (uidValidity/uid) -- test setup relies on UIDPLUS",
    );
  }
  return { uidValidity: result.uidValidity, uid: result.uid };
}

/** Deletes and expunges one message by UID -- test setup only (`ImapPort`
 * has no delete/expunge method; production code never removes mail). */
async function expungeByUid(
  auth: { user: string; pass: string },
  folder: string,
  uid: number,
) {
  await withRawImap(auth, async (imap) => {
    const lock = await imap.getMailboxLock(folder);
    try {
      await imap.messageFlagsAdd({ uid: String(uid) }, ["\\Deleted"], {
        uid: true,
      });
      await imap.messageDelete({ uid: String(uid) }, { uid: true });
    } finally {
      lock.release();
    }
  });
}

describe.skipIf(!greenmailAvailable)(
  "smtp_imap round trip against a real IMAP/SMTP server (GreenMail)",
  () => {
    beforeAll(async () => {
      await client.unsafe("drop schema if exists public cascade");
      await client.unsafe("drop schema if exists drizzle cascade");
      await client.unsafe("create schema public");
      await migrate(drizzle(client), { migrationsFolder: "drizzle" });
      // Full send-service claim path runs in this file (unlike
      // `smtp-imap-reconciliation-chain.test.ts`'s `existing_claim`
      // shortcut), so the working-hours/cap gate must be wide open --
      // mirrors `send-reliability.test.ts`'s own `beforeAll` exactly.
      await db.update(schema.operatorSendingSettings).set({
        timezone: "UTC",
        workingDays: [0, 1, 2, 3, 4, 5, 6],
        workingStartMinute: 0,
        workingEndMinute: 1_440,
        mailboxDailyCap: 10_000,
        campaignDailyCap: 100_000,
        mailboxMinimumDelaySeconds: 0,
        contactMinimumDelayMinutes: 0,
        crossCampaignCooldownDays: 0,
      });
    });

    afterAll(async () => {
      // `client.end()` rejecting must never skip the TLS restore below it --
      // fix round 1's other finding on this `afterAll`.
      try {
        await client.end();
      } finally {
        if (originalTlsRejectUnauthorized === undefined) {
          delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
        } else {
          process.env.NODE_TLS_REJECT_UNAUTHORIZED =
            originalTlsRejectUnauthorized;
        }
      }
    });

    it("connects a mailbox, sends a real draft end to end, delivers it to the prospect's own mailbox, and reconciles a real inbound reply back to the original message", async () => {
      const suffix = randomUUID();
      const mailboxDomain = `roundtrip-${suffix}.example`;
      const mailboxEmail = `operator-${suffix}@${mailboxDomain}`;
      // Deliberately *not* the email address -- GreenMail's auth is
      // disabled by default (any credentials authenticate and
      // auto-provision the mailbox), which lets this mirror the target
      // Zimbra-style "username != email" shape task requirement (b) is
      // about, rather than accidentally only ever exercising the
      // email-as-username case.
      const mailboxUsername = `operator-login-${suffix}`;
      const mailboxPassword = `pw-${suffix}`;
      const prospectEmail = `prospect-${suffix}@roundtrip-prospect.example`;

      // --- Setup: pre-create Drafts/"Envoyes" --------------------------
      // GreenMail starts a freshly auto-provisioned mailbox with only
      // INBOX. A mailbox an operator actually connects already has its
      // Drafts/Sent-equivalent folders (Zimbra, Gmail, ...) -- this is
      // that legitimate precondition, not a workaround for
      // `resolveFolderRoles`. "Envoyes" (unaccented, not "Sent" or
      // "Sent Items"): see the file header comment for why this
      // specific name is what actually forces the conventional-name
      // fallback against GreenMail.
      await withRawImap(
        { user: mailboxUsername, pass: mailboxPassword },
        async (imap) => {
          await imap.mailboxCreate("Drafts");
          await imap.mailboxCreate("Envoyes");

          // Precondition, not a redundant check: this is what actually makes
          // the assertion below (`sent: "Envoyes"`) discriminate the
          // conventional-name fallback from the special-use branch, rather
          // than passing for either reason. If GreenMail ever auto-tags
          // `Envoyes` with `\Sent` special-use -- as it already does for
          // `Sent`, `Sent Items`, and `Envoyés` (fix round 1 first claimed,
          // wrongly, that `Sent Items` was the exception; fix round 2
          // corrected that after the reviewer reproduced the real tagging
          // three times against the container) -- the special-use branch
          // would resolve `sent` to "Envoyes" too, and the assertion below
          // would go on passing without ever exercising the fallback it
          // exists to test. Fail loudly here instead of silently losing
          // coverage. Verified first-hand in this exact Drafts+Envoyes mix
          // (not a single folder in isolation) before being pinned here.
          const boxes = await imap.list();
          const envoyes = boxes.find((box) => box.path === "Envoyes");
          expect(envoyes).toBeDefined();
          expect(envoyes!.specialUse).toBeFalsy();
        },
      );

      // --- Connect: real IMAP auth + folder discovery, real SMTP auth -
      const connectResult = await connectSmtpImapMailbox(
        db,
        {
          email: mailboxEmail,
          password: mailboxPassword,
          username: mailboxUsername,
          imap: {
            host: GREENMAIL_HOST,
            port: GREENMAIL_IMAPS_PORT,
            security: "tls",
          },
          smtp: {
            host: GREENMAIL_HOST,
            port: GREENMAIL_SMTPS_PORT,
            security: "tls",
          },
        },
        { environment: testEnvironment },
      );
      expect(connectResult).toMatchObject({ ok: true });
      if (!connectResult.ok)
        throw new Error("connectSmtpImapMailbox failed in setup");
      const mailbox = connectResult.mailbox;

      // Folder names really discovered, not defaulted/hardcoded --
      // Drafts via special-use, "Envoyes" via the conventional-name
      // fallback (see the file header comment).
      const discoveredTransport = readTransport(mailbox.settings);
      expect(discoveredTransport?.folders).toEqual({
        drafts: "Drafts",
        sent: "Envoyes",
        inbox: "INBOX",
      });
      const sentFolder = discoveredTransport!.folders.sent;
      const draftsFolder = discoveredTransport!.folders.drafts;

      // --- "Sync now": mandatory before the first send ----------------
      // Connecting a mailbox now arms the inbound send gate: until an
      // inbound round has actually *succeeded*, `send-service.ts` refuses
      // to send (`REPLY_PENDING`). Nothing schedules that round for an
      // `smtp_imap` mailbox, so it is the operator's own "Sync now" that
      // clears it -- and the safe reading of "this mailbox has never read
      // its inbox" is "do not send yet": the prospect may already have
      // answered "stop writing to me".
      //
      // Dispatched exactly the way the operator's button does it
      // (`/api/operator/commands/sync-mailbox` -> task
      // "reconcile-inbound-mailbox"), so this covers the real sequence
      // against the real server, health wrapper and cursor write included.
      const gateBefore = await sendGateHealth(mailbox.id);
      expect(gateBefore?.status).toBeDefined();
      expect(gateBefore?.status).not.toBe("succeeded");

      const services = createWorkflowTaskServices(db, testEnvironment);
      await services["reconcile-inbound-mailbox"]({ mailboxId: mailbox.id });

      const gateAfter = await sendGateHealth(mailbox.id);
      expect(gateAfter?.status).toBe("succeeded");

      // --- Fixture: a real outbound message enrolled on this mailbox --
      const account = await createOrGetAccount(db, {
        name: `Round Trip ${suffix}`,
        domain: mailboxDomain,
      });
      if (!account.ok) throw new Error(account.message);
      const contact = await createOrGetContact(db, {
        accountId: account.account.id,
        firstName: "Ada",
        lastName: "Lovelace",
        jobTitle: "CTO",
      });
      if (!contact.ok) throw new Error(contact.message);
      const campaign = await createDraftCampaign(db, {
        name: `Round trip campaign ${suffix}`,
        type: "commercial_outreach",
        targetDescription: "Technology executives at relevant businesses",
        configuration: {},
        steps: [
          {
            delayMinutes: 0,
            subjectTemplate: "Hello {{first_name}}",
            bodyTemplate: "A note for {{company}}",
          },
        ],
      });
      if (!campaign.ok) throw new Error(campaign.message);
      const published = await publishCampaignVersion(db, {
        campaignId: campaign.campaign.id,
        campaignVersionId: campaign.version.id,
      });
      if (!published.ok) throw new Error(published.message);
      const enrollment = await enrollContact(db, {
        campaignId: campaign.campaign.id,
        campaignVersionId: campaign.version.id,
        contactId: contact.contact.id,
        mailboxId: mailbox.id,
      });
      if (!enrollment.ok) throw new Error(enrollment.message);
      const proposal = await generateOutreachProposal(db, {
        enrollmentId: enrollment.enrollment.id,
        stepIndex: 0,
        recipient: prospectEmail,
      });
      if (!proposal.ok) throw new Error(proposal.message);
      const reviewed = await reviewMessage(db, {
        messageId: proposal.message.id,
        action: { kind: "approve" },
        actor: "operator",
      });
      if (!reviewed.ok) throw new Error(reviewed.message);

      // --- Send: real IMAP APPEND, real SMTP submit, real MOVE --------
      const provider = await createMailProviderForMailbox(db, mailbox.id, {
        environment: testEnvironment,
        microsoftConfig: undefined,
      });
      const sendResult = await sendApprovedMessage(db, provider, {
        messageId: reviewed.message.id,
      });
      expect(sendResult).toMatchObject({ ok: true, disposition: "sent" });
      if (!sendResult.ok) throw new Error("sendApprovedMessage failed");
      const sentMessage = sendResult.message;

      const expectedMessageId = outreachMessageId(
        sentMessage.outreachId!,
        mailboxDomain,
      );
      expect(sentMessage.internetMessageId).toBe(expectedMessageId);

      // --- Independently verify against the real server, not our own --
      // provider code: presence in Sent, absence from Drafts (a MOVE, not
      // a copy), and that the RFC 5322 source actually sitting there is
      // byte-identical (once base64-decoded) to what was drafted.
      await withRawImap(
        { user: mailboxUsername, pass: mailboxPassword },
        async (imap) => {
          const sentLock = await imap.getMailboxLock(sentFolder, {
            readOnly: true,
          });
          let sentUids: number[] | false;
          let sentSource = "";
          let sentFlags = new Set<string>();
          try {
            sentUids = await imap.search(
              { header: { "message-id": expectedMessageId } },
              { uid: true },
            );
            expect(sentUids).not.toBe(false);
            const uids = sentUids as number[];
            expect(uids.length).toBeGreaterThan(0);
            const fetched = await imap.fetchOne(
              String(uids[0]),
              { source: true, flags: true },
              { uid: true },
            );
            sentSource =
              fetched && fetched.source ? fetched.source.toString("utf-8") : "";
            sentFlags =
              fetched && fetched.flags ? fetched.flags : new Set<string>();
          } finally {
            sentLock.release();
          }
          expect(sentSource).toContain(`To: ${prospectEmail}`);
          expect(decodeMimeBody(sentSource)).toBe(reviewed.message.body);
          expect(sentFlags.has("\\Draft")).toBe(false);

          const draftsLock = await imap.getMailboxLock(draftsFolder, {
            readOnly: true,
          });
          try {
            const draftUids = await imap.search(
              { header: { "message-id": expectedMessageId } },
              { uid: true },
            );
            // Moved, not copied.
            expect(draftUids).toEqual([]);
          } finally {
            draftsLock.release();
          }
        },
      );

      // --- The gap Sent alone cannot close: read the *prospect's own* --
      // auto-provisioned mailbox and prove GreenMail's SMTP server
      // actually received and delivered byte-identical content. Sent
      // holds the moved *draft* (the `APPEND` bytes); this is the only
      // check in this file that reads what SMTP itself transmitted.
      await withRawImap(
        { user: prospectEmail, pass: "prospect-inbox-check" },
        async (imap) => {
          const lock = await imap.getMailboxLock("INBOX", { readOnly: true });
          let deliveredSource = "";
          try {
            const uids = await imap.search(
              { header: { "message-id": expectedMessageId } },
              { uid: true },
            );
            expect(uids).not.toBe(false);
            const deliveredUids = uids as number[];
            expect(deliveredUids.length).toBeGreaterThan(0);
            const fetched = await imap.fetchOne(
              String(deliveredUids[0]),
              { source: true },
              { uid: true },
            );
            deliveredSource =
              fetched && fetched.source ? fetched.source.toString("utf-8") : "";
          } finally {
            lock.release();
          }
          expect(decodeMimeBody(deliveredSource)).toBe(reviewed.message.body);
        },
      );

      // --- Inject inbound mail directly into INBOX, deterministically -
      // Via IMAP APPEND rather than relying on GreenMail's own internal
      // SMTP routing -- controlled and independent of whatever that
      // routing does or does not do. Three messages, in this order, is
      // the minimum that actually discriminates a UID-vs-sequence-number
      // regression in `fetchRange` (see the file header comment and the
      // dedicated Drafts-folder test below for the full reasoning):
      //   1. a throwaway, immediately EXPUNGEd -- so the two survivors
      //      below have UIDs one higher than their post-expunge sequence
      //      numbers;
      //   2. a schema-valid but unrelated message, matching no outbound
      //      message ("unmatched" -- still counted as processed);
      //   3. the real reply, carrying `In-Reply-To`.
      // A mailbox left with only *one* survivor cannot discriminate: `*`
      // resolves to the highest UID under a correct UID-range read, but
      // also happens to resolve to the same single message under a
      // sequence-range misread when only one message remains -- exactly
      // the RFC 3501 §6.4.8 backward-resolution `fetchRange`'s own doc
      // comment warns about, and the flaw fix round 1 found in this
      // file's first version.
      const throwawayId = `<expunge-throwaway-${suffix}@roundtrip-prospect.example>`;
      const throwawayRaw = [
        `From: junk-${suffix}@unrelated.invalid`,
        `To: ${mailboxEmail}`,
        "Subject: throwaway, about to be expunged",
        `Date: ${new Date().toUTCString()}`,
        `Message-ID: ${throwawayId}`,
        "MIME-Version: 1.0",
        "Content-Type: text/plain; charset=utf-8",
        "",
        "This message is deleted and expunged before reconciliation ever runs.",
      ].join("\r\n");
      const throwawayAppend = requireAppendUid(
        await withRawImap(
          { user: mailboxUsername, pass: mailboxPassword },
          (imap) => imap.append("INBOX", throwawayRaw),
        ),
      );
      await expungeByUid(
        { user: mailboxUsername, pass: mailboxPassword },
        "INBOX",
        throwawayAppend.uid,
      );

      const junkId = `<unmatched-junk-${suffix}@roundtrip-prospect.example>`;
      const junkRaw = [
        `From: junk-${suffix}@unrelated.invalid`,
        `To: ${mailboxEmail}`,
        "Subject: unrelated inbound noise",
        `Date: ${new Date().toUTCString()}`,
        `Message-ID: ${junkId}`,
        "MIME-Version: 1.0",
        "Content-Type: text/plain; charset=utf-8",
        "",
        "Matches no outbound message -- an ordinary unmatched reply.",
      ].join("\r\n");
      await withRawImap(
        { user: mailboxUsername, pass: mailboxPassword },
        (imap) => imap.append("INBOX", junkRaw),
      );

      const replyMessageId = `<reply-${suffix}@roundtrip-prospect.example>`;
      const replyRaw = [
        `From: ${prospectEmail}`,
        `To: ${mailboxEmail}`,
        `Subject: Re: ${reviewed.message.subject}`,
        `Date: ${new Date().toUTCString()}`,
        `Message-ID: ${replyMessageId}`,
        `In-Reply-To: ${sentMessage.internetMessageId}`,
        `References: ${sentMessage.internetMessageId}`,
        "MIME-Version: 1.0",
        "Content-Type: text/plain; charset=utf-8",
        "",
        "Yes, I am interested -- tell me more.",
      ].join("\r\n");
      const replyAppend = requireAppendUid(
        await withRawImap(
          { user: mailboxUsername, pass: mailboxPassword },
          (imap) => imap.append("INBOX", replyRaw),
        ),
      );
      // Sanity check on the setup itself: the divergence this test needs
      // (real UID above the post-expunge sequence number) must actually
      // exist in this run, or the assertions below would not discriminate
      // anything even if they happened to pass.
      expect(replyAppend.uid).toBeGreaterThan(2);

      // --- Reconcile inbound: production wiring, real IMAP walk --------
      const [mailboxRow] = await db
        .select()
        .from(schema.mailboxConnections)
        .where(eq(schema.mailboxConnections.id, mailbox.id))
        .limit(1);
      if (!mailboxRow) throw new Error("mailbox row missing after send");
      const source = await resolveInboundProvider("smtp_imap").createSource(
        db,
        mailboxRow,
        { environment: testEnvironment },
      );
      const classifier = new DeterministicReplyClassifier();
      const round = await reconcileInboundMailbox(
        { source, mailboxId: mailbox.id },
        {
          loadCursor: async () => mailboxRow.syncCursor,
          saveCursor: async () => {},
          ingest: (message) => ingestInboundMessage(db, classifier, message),
        },
      );
      // The discriminating assertion (see the file header comment and the
      // setup above): a `fetchRange` that read `range` as a sequence-number
      // set instead of a UID set would fetch only the reply (the higher of
      // the two post-expunge sequence numbers, "*"), silently skipping the
      // junk message entirely -- `processed` would read `1`, not `2`. This
      // is why `processed` -- not `nextCursor` -- is the assertion doing
      // the discriminating work below: each fetched message's own `uid`
      // field is reported correctly by the server regardless of how the
      // range was interpreted, so by that same reasoning `nextCursor`
      // (derived from the last fetched message's uid) would likely still
      // land on the right value under the regression too, and can't be
      // relied on alone to catch it. (Not verified empirically the way the
      // `processed` regression was -- the regression run failed at
      // `processed` before this assertion was ever reached.)
      expect(round.processed).toBe(2);
      expect(round.nextCursor).toBe(
        `${Number(replyAppend.uidValidity)}:${replyAppend.uid}`,
      );
      expect(round.rebaselined).toBe(false);

      // --- The assertion this whole test exists for: a `replies` row is
      // created and attached to the *original outbound* message. --------
      const replyRows = await db
        .select()
        .from(schema.replies)
        .where(eq(schema.replies.messageId, reviewed.message.id));
      expect(replyRows).toHaveLength(1);
      expect(replyRows[0]).toMatchObject({
        messageId: reviewed.message.id,
        sender: prospectEmail,
        classification: "positive",
      });
    }, 45_000);

    it("really searches Drafts by UID, not sequence number, once the mailbox has been EXPUNGEd", async () => {
      // A dedicated mailbox, isolated from the main test's own Drafts
      // traffic: proves the `search()` call site inside
      // `ImapClient.findByMessageId` (the one `createDraft`/`sendDraft`/
      // `reconcile` all depend on for their deterministic-Message-ID
      // dedup) independently of `fetchRange`'s `fetch()` call site above
      // -- two different `imapflow` APIs, both taking `{uid: true}`, each
      // capable of regressing on its own.
      const suffix = randomUUID();
      const username = `uidcheck-${suffix}`;
      const password = `pw-${suffix}`;
      await withRawImap({ user: username, pass: password }, async (imap) => {
        await imap.mailboxCreate("Drafts");
        await imap.mailboxCreate("Sent");
      });

      const transport: MailboxTransport = {
        username,
        imap: {
          host: GREENMAIL_HOST,
          port: GREENMAIL_IMAPS_PORT,
          security: "tls",
        },
        smtp: {
          host: GREENMAIL_HOST,
          port: GREENMAIL_SMTPS_PORT,
          security: "tls",
        },
        folders: { drafts: "Drafts", sent: "Sent", inbox: "INBOX" },
      };
      const credentials: MailboxCredentials = {
        user: username,
        pass: password,
      };
      const imapClient = new ImapClient(transport, credentials);

      const firstMessageId = `<uid-check-1-${suffix}@d.tld>`;
      const secondMessageId = `<uid-check-2-${suffix}@d.tld>`;
      const first = await imapClient.appendDraft(
        buildMime(
          {
            sender: "a@d.tld",
            recipient: "b@d.tld",
            subject: "first",
            body: "first body",
            headers: {},
          },
          firstMessageId,
        ),
      );
      const second = await imapClient.appendDraft(
        buildMime(
          {
            sender: "a@d.tld",
            recipient: "b@d.tld",
            subject: "second",
            body: "second body",
            headers: {},
          },
          secondMessageId,
        ),
      );

      // Expunge the first draft: the second's post-expunge *sequence*
      // number becomes `1` (the only message left), while its real *UID*
      // stays whatever `APPENDUID` actually assigned it (`second.uid`,
      // `> first.uid`) -- the exact divergence a UID-vs-sequence-number
      // regression in `search(..., { uid: true })` would misreport.
      await expungeByUid(
        { user: username, pass: password },
        "Drafts",
        first.uid,
      );

      const found = await imapClient.findByMessageId("drafts", secondMessageId);
      expect(found).not.toBeNull();
      expect(found!.uid).toBe(second.uid);
      // Sanity check the setup actually created the divergence this test
      // needs: the real UID must differ from the post-expunge sequence
      // number (`1`), or a regression reading sequence numbers instead of
      // UIDs would produce the same answer by coincidence.
      expect(found!.uid).not.toBe(1);
    }, 30_000);
  },
);

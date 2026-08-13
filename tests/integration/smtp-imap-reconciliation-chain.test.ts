import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as schema from "@/lib/db/schema";
import { resolveDatabaseUrls } from "@/lib/db/test-database";
import { extractMessageId } from "@/lib/smtp-imap/mime";
import { outreachMessageId } from "@/lib/smtp-imap/message-id";
import type {
  ImapFetchedMessage,
  ImapFolderRole,
  ImapFolderRoles,
  ImapPort,
} from "@/lib/smtp-imap/imap-client";
import type {
  SmtpEnvelope,
  SmtpPort,
  SmtpSubmitResult,
} from "@/lib/smtp-imap/smtp-client";
import { createOrGetAccount } from "@/modules/accounts/service";
import {
  createDraftCampaign,
  enrollContact,
  publishCampaignVersion,
} from "@/modules/campaigns/service";
import { createOrGetContact } from "@/modules/contacts/service";
import { generateOutreachProposal } from "@/modules/messages/generation-service";
import { sendApprovedMessage } from "@/modules/messages/send-service";
import { reviewMessage } from "@/modules/messages/review-service";
import { SmtpImapMailProvider } from "@/modules/mailboxes/smtp-imap-mail-provider";
import { WorkflowEventsSendJournal } from "@/modules/mailboxes/smtp-send-journal";

/**
 * Task 14, requirement (a): the one link in the whole anti-double-send
 * mechanism no review could confirm by reading code alone -- that a
 * `{status: "accepted"}` (and, on repair, `{status: "sent"}`)
 * `MailProvider.reconcile()` answer actually lands where the design doc says
 * it does inside `send-service.ts`, and that a message recovering through
 * that path finalizes to `sent` **without ever resubmitting over SMTP**.
 *
 * This wires the *real* `SmtpImapMailProvider` + the *real*
 * `WorkflowEventsSendJournal` (backed by this suite's own Postgres) into the
 * *real* `sendApprovedMessage` -- only the IMAP/SMTP transport underneath
 * `SmtpImapMailProvider` is a fake, standing in for the network. Whether the
 * IMAP/SMTP wire protocol itself behaves the way `ImapClient`/`SmtpClient`
 * assume is a *different* question, answered against a real server in
 * `tests/integration/smtp-imap-round-trip.test.ts` -- this file only proves
 * the application-layer wiring between the provider contract and
 * `send-service.ts`.
 */

const { testUrl } = resolveDatabaseUrls(process.env);
const client = postgres(testUrl, { max: 4 });
const db = drizzle(client, { schema });

type StoredImapMessage = {
  uid: number;
  mime: string;
  messageId: string | null;
};

function unexpectedImapCall(name: string): () => never {
  return () => {
    throw new Error(`unexpected fake ImapPort call: ${name}`);
  };
}

/** Same shape as `mail-provider-contract.test.ts`'s fake -- real
 * UIDVALIDITY/UID bookkeeping and a real Message-ID index, so
 * `SmtpImapMailProvider.reconcile`'s Sent-repair logic (moving an orphaned
 * Drafts copy into Sent when the journal says "accepted" but Sent is empty)
 * runs for real, against real in-memory folders, not a canned response. */
class FakeImapTransport implements ImapPort {
  private readonly uidValidity = 9_000;
  private nextUid = 1;
  private readonly drafts = new Map<number, StoredImapMessage>();
  private readonly sent = new Map<number, StoredImapMessage>();

  async appendDraft(mime: string, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const uid = this.nextUid;
    this.nextUid += 1;
    this.drafts.set(uid, { uid, mime, messageId: extractMessageId(mime) });
    return { uidValidity: this.uidValidity, uid };
  }

  async findByMessageId(
    role: ImapFolderRole,
    messageId: string,
    signal?: AbortSignal,
  ) {
    signal?.throwIfAborted();
    const folder = role === "drafts" ? this.drafts : this.sent;
    for (const message of folder.values()) {
      if (message.messageId === messageId) {
        return { uidValidity: this.uidValidity, uid: message.uid };
      }
    }
    return null;
  }

  async moveToSent(uidValidity: number, uid: number, signal?: AbortSignal) {
    signal?.throwIfAborted();
    if (uidValidity !== this.uidValidity) {
      throw new Error("UIDVALIDITY mismatch in fake IMAP transport");
    }
    const message = this.drafts.get(uid);
    if (!message) throw new Error(`fake IMAP: no draft at uid ${uid} to move`);
    this.drafts.delete(uid);
    this.sent.set(uid, message);
  }

  async fetchDraftSource(
    uidValidity: number,
    uid: number,
    signal?: AbortSignal,
  ) {
    signal?.throwIfAborted();
    if (uidValidity !== this.uidValidity) {
      throw new Error("UIDVALIDITY mismatch in fake IMAP transport");
    }
    const message = this.drafts.get(uid);
    if (!message) throw new Error(`fake IMAP: no draft at uid ${uid}`);
    return message.mime;
  }

  resolveFolders = unexpectedImapCall(
    "resolveFolders",
  ) as () => Promise<ImapFolderRoles>;
  status = unexpectedImapCall("status") as () => Promise<{
    uidValidity: number;
    uidNext: number;
  }>;
  findFirstUidSince = unexpectedImapCall("findFirstUidSince") as () => Promise<
    number | null
  >;
  fetchRange = (): AsyncGenerator<ImapFetchedMessage[]> => {
    throw new Error("unexpected fake ImapPort call: fetchRange");
  };
}

/** Counts every call -- the test's central assertion is that this stays at
 * `0` for the whole reconciliation path, proving `send-service.ts` reached
 * `reconcile()`, not a second `sendDraft()`. */
class FakeSmtpTransport implements SmtpPort {
  readonly submissions: Array<{ mime: string; envelope: SmtpEnvelope }> = [];

  async submit(
    mime: string,
    envelope: SmtpEnvelope,
    signal?: AbortSignal,
  ): Promise<SmtpSubmitResult> {
    signal?.throwIfAborted();
    this.submissions.push({ mime, envelope });
    return {
      messageId: extractMessageId(mime) ?? "<unknown>",
      response: "250 OK (fake)",
    };
  }

  async verify(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
  }
}

let fixtureNumber = 0;

async function prepareSmtpImapMessage() {
  fixtureNumber += 1;
  const suffix = fixtureNumber;
  const account = await createOrGetAccount(db, {
    name: `Chain ${suffix}`,
    domain: `chain-${suffix}.example`,
  });
  if (!account.ok) throw new Error(account.message);
  const contact = await createOrGetContact(db, {
    accountId: account.account.id,
    firstName: "Ada",
    lastName: `Lovelace${suffix}`,
    jobTitle: "CTO",
  });
  if (!contact.ok) throw new Error(contact.message);
  const campaign = await createDraftCampaign(db, {
    name: `Chain campaign ${suffix}`,
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

  const mailboxEmail = `operator-${suffix}@chain-${suffix}.example`;
  const [mailbox] = await db
    .insert(schema.mailboxConnections)
    .values({
      provider: "smtp_imap",
      email: mailboxEmail,
      normalizedEmail: mailboxEmail,
      status: "available",
    })
    .returning();
  if (!mailbox) throw new Error("mailbox fixture missing");

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
    recipient: `ada-${suffix}@chain-${suffix}-prospect.example`,
  });
  if (!proposal.ok) throw new Error(proposal.message);
  const reviewed = await reviewMessage(db, {
    messageId: proposal.message.id,
    action: { kind: "approve" },
    actor: "operator",
  });
  if (!reviewed.ok) throw new Error(reviewed.message);

  return { message: reviewed.message, mailbox };
}

describe("reconciliation chain: accepted-in-journal repairs to sent via send-service, with zero SMTP resubmission", () => {
  beforeAll(async () => {
    await client.unsafe("drop schema if exists public cascade");
    await client.unsafe("drop schema if exists drizzle cascade");
    await client.unsafe("create schema public");
    await migrate(drizzle(client), { migrationsFolder: "drizzle" });
  });

  afterAll(async () => {
    await client.end();
  });

  it("finalizes to sent with no SMTP resubmission when the journal already recorded acceptance and the Sent copy is missing", async () => {
    const fixture = await prepareSmtpImapMessage();
    const imap = new FakeImapTransport();
    const smtp = new FakeSmtpTransport();
    const journal = new WorkflowEventsSendJournal(db);
    const provider = new SmtpImapMailProvider(
      imap,
      smtp,
      fixture.mailbox.id,
      fixture.mailbox.email,
      journal,
    );
    const domain = fixture.mailbox.email.split("@")[1]!;
    const messageKey = outreachMessageId(fixture.message.outreachId!, domain);

    // 1. A draft genuinely exists in (fake) Drafts -- exactly what a real
    // `createDraft` call left behind.
    const draft = await provider.createDraft({
      outreachId: fixture.message.outreachId!,
      mailboxId: fixture.mailbox.id,
      sender: null,
      recipient: fixture.message.recipient,
      subject: fixture.message.subject,
      body: fixture.message.body,
      headers: {},
    });

    // 2. "Acceptation enregistrée au journal, copie Sent absente": the
    // real journal is told the SMTP server already accepted this message --
    // simulating the exact crash window `SmtpImapMailProvider.sendDraft`'s
    // own doc comment names (step 5 succeeded, step 6's `moveToSent` never
    // ran) -- without ever calling `smtp.submit` to get there. The draft is
    // still sitting in the fake Drafts folder; Sent is empty.
    await journal.recordAcceptance(messageKey);
    expect(await imap.findByMessageId("sent", messageKey)).toBeNull();
    expect(await imap.findByMessageId("drafts", messageKey)).not.toBeNull();
    expect(smtp.submissions).toHaveLength(0);

    // 3. Seed the message row into exactly the shape a real "attempt threw
    // or the worker crashed, still delivery_uncertain" message would carry
    // -- the `existing_claim` path in `send-service.ts` is reached only from
    // this shape (status/attemptCount/sendAttemptToken), never from a fresh
    // claim.
    await db
      .update(schema.messages)
      .set({
        status: "delivery_uncertain",
        providerDraftId: draft.draftId,
        sendAttemptToken: randomUUID(),
        sendClaimedAt: new Date(),
        attemptCount: 1,
      })
      .where(eq(schema.messages.id, fixture.message.id));

    // 4. The full reconciliation path via the real send-service.
    const result = await sendApprovedMessage(db, provider, {
      messageId: fixture.message.id,
    });

    expect(result).toMatchObject({ ok: true, disposition: "sent" });
    // The load-bearing assertion: `send-service.ts` reached `reconcile()`,
    // read the journal's prior acceptance, and finalized -- it never called
    // `sendDraft()` again, so the fake transport never submitted anything,
    // from the very first line of this test to the last.
    expect(smtp.submissions).toHaveLength(0);

    const [stored] = await db
      .select()
      .from(schema.messages)
      .where(eq(schema.messages.id, fixture.message.id));
    expect(stored).toMatchObject({
      status: "sent",
      internetMessageId: messageKey,
    });
    expect(stored?.sentAt).not.toBeNull();

    // Bonus, makes the best-effort Sent-copy repair observable rather than
    // merely "didn't break the reported status": `reconcile`'s `reportSent`
    // found the orphaned Drafts copy and moved it for real.
    expect(await imap.findByMessageId("sent", messageKey)).not.toBeNull();
    expect(await imap.findByMessageId("drafts", messageKey)).toBeNull();
  });
});

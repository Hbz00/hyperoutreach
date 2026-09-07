import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { ImapFlow } from "imapflow";
import nodemailer from "nodemailer";

import type { AppDatabase } from "@/lib/db/types";
import { operatorSendingSettings } from "@/lib/db/schema";
import { createOrGetAccount } from "@/modules/accounts/service";
import { createOrGetContact } from "@/modules/contacts/service";
import {
  createDraftCampaign,
  enrollContact,
  publishCampaignVersion,
} from "@/modules/campaigns/service";
import { connectSmtpImapMailbox } from "@/modules/mailboxes/smtp-imap-connection-service";
import { generateOutreachProposal } from "@/modules/messages/generation-service";
import { reviewMessage } from "@/modules/messages/review-service";
import { createWorkflowTaskServices } from "@/modules/workflows/service-factory";

export function assertControlledDatabase(url: string) {
  const parsed = new URL(url);
  assert.equal(parsed.hostname, "localhost");
  assert.equal(parsed.port, "55432");
  assert.ok(parsed.pathname.endsWith("_test"));
  assert.equal(process.env.AI_PROVIDER, "mock");
  assert.equal(process.env.MAIL_PROVIDER, "mock");
}

export async function withControlledImap<T>(
  email: string,
  fn: (imap: ImapFlow) => Promise<T>,
): Promise<T> {
  assert.ok(email.endsWith(".test"));
  const imap = new ImapFlow({
    host: "127.0.0.1",
    port: 3993,
    secure: true,
    auth: { user: email, pass: "controlled-fixture" },
    logger: false,
    tls: { rejectUnauthorized: false },
    connectionTimeout: 2000,
    greetingTimeout: 2000,
    socketTimeout: 5000,
  });
  try {
    await imap.connect();
    return await fn(imap);
  } finally {
    await imap.logout().catch(() => {});
    imap.close();
  }
}

export async function controlledMessages(
  email: string,
  folder: string,
  messageId: string,
) {
  return withControlledImap(email, async (imap) => {
    const lock = await imap.getMailboxLock(folder, { readOnly: true });
    try {
      const uids = await imap.search(
        { header: { "message-id": messageId } },
        { uid: true },
      );
      assert.ok(Array.isArray(uids));
      const sources: string[] = [];
      for (const uid of uids) {
        const row = await imap.fetchOne(
          String(uid),
          { source: true },
          { uid: true },
        );
        assert.ok(row && row.source);
        sources.push(row.source.toString());
      }
      return sources;
    } finally {
      lock.release();
    }
  });
}

export async function deliverControlledMessage(
  from: string,
  to: string,
  raw: string,
) {
  assert.ok(from.endsWith(".test") && to.endsWith(".test"));
  const smtp = nodemailer.createTransport({
    host: "127.0.0.1",
    port: 3587,
    secure: true,
    auth: { user: from, pass: "controlled-fixture" },
    tls: { rejectUnauthorized: false },
    connectionTimeout: 2000,
    greetingTimeout: 2000,
    socketTimeout: 5000,
  });
  try {
    const result = await smtp.sendMail({ envelope: { from, to: [to] }, raw });
    assert.deepEqual(result.accepted, [to]);
    return result;
  } finally {
    smtp.close();
  }
}

export async function prepareControlledMessage(
  db: AppDatabase,
  ownedMailboxes?: Set<string>,
) {
  const suffix = randomUUID();
  const domain = `controlled-${suffix}.test`;
  const operator = `operator@${domain}`;
  const recipient = `prospect@${domain}`;
  // Register before the first connection so a partial setup remains owned.
  ownedMailboxes?.add(operator);
  ownedMailboxes?.add(recipient);
  await withControlledImap(operator, async (imap) => {
    await imap.mailboxCreate("Drafts");
    await imap.mailboxCreate("Sent");
  });
  await withControlledImap(recipient, async (imap) => {
    await imap.mailboxOpen("INBOX");
  });
  const connected = await connectSmtpImapMailbox(
    db,
    {
      email: operator,
      username: operator,
      password: "controlled-fixture",
      imap: { host: "127.0.0.1", port: 3993, security: "tls" },
      smtp: { host: "127.0.0.1", port: 3587, security: "tls" },
    },
    { environment: process.env },
  );
  assert.ok(connected.ok, JSON.stringify(connected));
  await db.update(operatorSendingSettings).set({
    timezone: "UTC",
    workingDays: [0, 1, 2, 3, 4, 5, 6],
    workingStartMinute: 0,
    workingEndMinute: 1440,
    mailboxDailyCap: 10000,
    campaignDailyCap: 100000,
    mailboxMinimumDelaySeconds: 0,
    contactMinimumDelayMinutes: 0,
    crossCampaignCooldownDays: 0,
  });
  await createWorkflowTaskServices(db, process.env)[
    "reconcile-inbound-mailbox"
  ]({ mailboxId: connected.mailbox.id });
  const account = await createOrGetAccount(db, {
    name: `Controlled ${suffix}`,
    domain,
  });
  assert.ok(account.ok);
  const contact = await createOrGetContact(db, {
    accountId: account.account.id,
    firstName: "Ada",
    lastName: suffix,
    jobTitle: "CTO",
  });
  assert.ok(contact.ok);
  const campaign = await createDraftCampaign(db, {
    name: `Controlled ${suffix}`,
    type: "commercial_outreach",
    targetDescription: "Controlled synthetic recipients",
    configuration: {},
    steps: [
      {
        delayMinutes: 0,
        subjectTemplate: "Hello {{first_name}}",
        bodyTemplate: "A note for {{company}}",
      },
      {
        delayMinutes: 1440,
        subjectTemplate: "Follow up",
        bodyTemplate: "Another note",
      },
    ],
  });
  assert.ok(campaign.ok);
  const published = await publishCampaignVersion(db, {
    campaignId: campaign.campaign.id,
    campaignVersionId: campaign.version.id,
  });
  assert.ok(published.ok);
  const enrollment = await enrollContact(db, {
    campaignId: campaign.campaign.id,
    campaignVersionId: campaign.version.id,
    contactId: contact.contact.id,
    mailboxId: connected.mailbox.id,
  });
  assert.ok(enrollment.ok);
  const proposal = await generateOutreachProposal(db, {
    enrollmentId: enrollment.enrollment.id,
    stepIndex: 0,
    recipient,
  });
  assert.ok(proposal.ok);
  const reviewed = await reviewMessage(db, {
    messageId: proposal.message.id,
    action: { kind: "approve" },
    actor: "operator",
  });
  assert.ok(reviewed.ok);
  return {
    operator,
    recipient,
    messageId: reviewed.message.id,
    outreachId: reviewed.message.outreachId!,
    mailboxId: connected.mailbox.id,
    enrollmentId: enrollment.enrollment.id,
    body: reviewed.message.body,
  };
}

export async function cleanupControlledMailbox(email: string) {
  await withControlledImap(email, async (imap) => {
    for (const folder of await imap.list()) {
      const lock = await imap.getMailboxLock(folder.path);
      try {
        if (imap.mailbox && imap.mailbox.exists > 0)
          await imap.messageDelete("1:*", { uid: false });
      } finally {
        lock.release();
      }
    }
  });
}

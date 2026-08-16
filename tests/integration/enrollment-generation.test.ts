import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as schema from "@/lib/db/schema";
import { resolveDatabaseUrls } from "@/lib/db/test-database";
import { enrollContact } from "@/modules/campaigns/service";
import { MockMailProvider } from "@/modules/mailboxes/mock-mail-provider";
import { evaluateSendPolicy } from "@/modules/messages/send-policy";
import { sendApprovedMessage } from "@/modules/messages/send-service";
import { drainOperatorCommands } from "@/modules/workflows/operator-command-queue";
import { WorkflowRuntime } from "@/modules/workflows/runtime";
import { createWorkflowTaskServices } from "@/modules/workflows/service-factory";
import type { WorkflowTaskName } from "@/modules/workflows/task-contracts";

const { testUrl } = resolveDatabaseUrls(process.env);
const client = postgres(testUrl, { max: 4 });
const db = drizzle(client, { schema });

const NOW = new Date("2026-08-16T12:00:00.000Z");

/**
 * Drains through the same executor production uses — the audited workflow
 * runtime, not the bare service — so payload parsing and the runtime's
 * retryable-failure conversion are exercised rather than skipped.
 */
function drain(now = NOW) {
  const services = createWorkflowTaskServices(db, {});
  const runtime = new WorkflowRuntime(db, services);
  return drainOperatorCommands(
    db,
    (input) =>
      runtime.execute(input.task as WorkflowTaskName, input.payload, {
        runId: input.runId,
        attempt: input.attempt,
      }),
    { now, limit: 5 },
  );
}

async function prospect(options: { acceptedEmail?: boolean } = {}) {
  const suffix = crypto.randomUUID().slice(0, 8);
  const [account] = await db
    .insert(schema.accounts)
    .values({ name: `Auto ${suffix}`, normalizedName: `auto-${suffix}` })
    .returning();
  const [contact] = await db
    .insert(schema.contacts)
    .values({
      accountId: account!.id,
      firstName: "Grace",
      lastName: "Hopper",
      fullName: "Grace Hopper",
      normalizedFullName: `grace-${suffix}`,
      jobTitle: "Rear admiral",
      ...(options.acceptedEmail ? { emailResolutionStatus: "resolved" } : {}),
    })
    .returning();
  if (options.acceptedEmail) {
    await db.insert(schema.emailCandidates).values({
      contactId: contact!.id,
      email: `grace-${suffix}@auto-${suffix}.example`,
      normalizedEmail: `grace-${suffix}@auto-${suffix}.example`,
      domain: `auto-${suffix}.example`,
      confidence: "0.950",
      source: "fixture",
      status: "accepted",
    });
  }
  const [campaign] = await db
    .insert(schema.campaigns)
    .values({
      name: `Auto ${suffix}`,
      type: "commercial_outreach",
      status: "active",
      targetDescription: "Generate the first message without a click",
    })
    .returning();
  const [version] = await db
    .insert(schema.campaignVersions)
    .values({ campaignId: campaign!.id, version: 1 })
    .returning();
  await db.insert(schema.sequenceSteps).values({
    campaignVersionId: version!.id,
    stepIndex: 0,
    delayMinutes: 0,
    subjectTemplate: "Hello {{first_name}}",
    bodyTemplate: "A note for {{company}}",
  });
  await db
    .update(schema.campaignVersions)
    .set({ publishedAt: NOW })
    .where(eq(schema.campaignVersions.id, version!.id));
  return {
    account: account!,
    contact: contact!,
    campaign: campaign!,
    version: version!,
  };
}

async function enroll(fixture: Awaited<ReturnType<typeof prospect>>) {
  const result = await enrollContact(db, {
    campaignId: fixture.campaign.id,
    campaignVersionId: fixture.version.id,
    contactId: fixture.contact.id,
  });
  if (!result.ok) throw new Error(result.message);
  return result.enrollment;
}

async function messagesFor(enrollmentId: string) {
  return db
    .select()
    .from(schema.messages)
    .where(eq(schema.messages.enrollmentId, enrollmentId));
}

async function commandsFor(enrollmentId: string) {
  const rows = await db.select().from(schema.operatorCommands);
  return rows.filter((row) => row.payload.enrollmentId === enrollmentId);
}

describe("the first message is written without being asked twice", () => {
  beforeAll(async () => {
    await client.unsafe("drop schema if exists public cascade");
    await client.unsafe("drop schema if exists drizzle cascade");
    await client.unsafe("create schema public");
    await migrate(drizzle(client), { migrationsFolder: "drizzle" });
  });

  afterAll(async () => {
    await client.end();
  });

  it("proposes the first message from the enrollment alone", async () => {
    const fixture = await prospect({ acceptedEmail: true });
    const enrollment = await enroll(fixture);

    await drain();

    const messages = await messagesFor(enrollment.id);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      status: "proposed",
      stepIndex: 0,
      subject: "Hello Grace",
      body: `A note for ${fixture.account.name}`,
    });
    // The audited runtime wrote its own trail, which is how the operator finds
    // what a queued command actually did.
    const audited = await db
      .select()
      .from(schema.workflowEvents)
      .where(eq(schema.workflowEvents.entityId, enrollment.id));
    expect(
      audited.filter((row) => row.workflowName === "generate-message"),
    ).not.toHaveLength(0);
  });

  // The generated message is `proposed`, and the policy refuses every status
  // but the ones a human decision produces. Automating the typing is not
  // automating the sending.
  it("produces a message the worker cannot send", async () => {
    const fixture = await prospect({ acceptedEmail: true });
    const enrollment = await enroll(fixture);
    await drain();
    const [message] = await messagesFor(enrollment.id);

    expect(
      evaluateSendPolicy({
        campaignStatus: "active",
        enrollmentState: "approved",
        messageStatus: message!.status,
        recipientSuppressed: false,
        mailboxRequired: false,
        mailboxStatus: null,
        stepAlreadySent: false,
      }),
    ).toEqual({ ok: false, code: "MESSAGE_NOT_APPROVED" });
  });

  it("refuses a real send of the message it just wrote", async () => {
    const fixture = await prospect({ acceptedEmail: true });
    const enrollment = await enroll(fixture);
    await drain();
    const [message] = await messagesFor(enrollment.id);
    const provider = new MockMailProvider();

    expect(
      await sendApprovedMessage(
        db,
        provider,
        { messageId: message!.id },
        { clock: () => NOW },
      ),
    ).toMatchObject({ ok: false, code: "MESSAGE_NOT_APPROVED" });
    expect(provider.deliveries).toHaveLength(0);
    expect((await messagesFor(enrollment.id))[0]).toMatchObject({
      status: "proposed",
      attemptCount: 0,
    });
  });

  // No number of retries produces an address nobody has resolved. It waits,
  // spends no attempt, and clears itself when resolution accepts one.
  it("waits for an address instead of failing, and clears when one arrives", async () => {
    const fixture = await prospect();
    const enrollment = await enroll(fixture);

    await drain();

    expect(await messagesFor(enrollment.id)).toHaveLength(0);
    const [parked] = await commandsFor(enrollment.id);
    expect(parked).toMatchObject({
      status: "waiting",
      waitingReason: "awaiting_accepted_email",
      attempt: 0,
    });

    await db.insert(schema.emailCandidates).values({
      contactId: fixture.contact.id,
      email: `late@${fixture.account.normalizedName}.example`,
      normalizedEmail: `late@${fixture.account.normalizedName}.example`,
      domain: `${fixture.account.normalizedName}.example`,
      confidence: "0.900",
      source: "fixture",
      status: "accepted",
    });

    await drain(new Date(NOW.getTime() + 10 * 60_000));

    const messages = await messagesFor(enrollment.id);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      status: "proposed",
      recipient: `late@${fixture.account.normalizedName}.example`,
    });
  });

  it("queues one generation per enrollment, however many times it is asked", async () => {
    const fixture = await prospect({ acceptedEmail: true });
    const enrollment = await enroll(fixture);
    await enrollContact(db, {
      campaignId: fixture.campaign.id,
      campaignVersionId: fixture.version.id,
      contactId: fixture.contact.id,
    });

    expect(await commandsFor(enrollment.id)).toHaveLength(1);
    await drain();
    expect(await messagesFor(enrollment.id)).toHaveLength(1);
  });
});

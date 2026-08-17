import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as schema from "@/lib/db/schema";
import { resolveDatabaseUrls } from "@/lib/db/test-database";
import { enrollContact } from "@/modules/campaigns/service";
import { MockMailProvider } from "@/modules/mailboxes/mock-mail-provider";
import { reviewMessage } from "@/modules/messages/review-service";
import { evaluateSendPolicy } from "@/modules/messages/send-policy";
import { sendApprovedMessage } from "@/modules/messages/send-service";
import {
  drainOperatorCommands,
  enqueueOperatorCommand,
} from "@/modules/workflows/operator-command-queue";
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
function drain(now = NOW, limit = 5) {
  const services = createWorkflowTaskServices(db, {});
  const runtime = new WorkflowRuntime(db, services);
  return drainOperatorCommands(
    db,
    (input) =>
      runtime.execute(input.task as WorkflowTaskName, input.payload, {
        runId: input.runId,
        attempt: input.attempt,
      }),
    { now, limit },
  );
}

async function prospect(
  options: { acceptedEmail?: boolean; personalized?: boolean } = {},
) {
  const suffix = crypto.randomUUID().slice(0, 8);
  const [account] = await db
    .insert(schema.accounts)
    .values({
      name: `Auto ${suffix}`,
      normalizedName: `auto-${suffix}`,
      ...(options.personalized
        ? {
            researchStatus: "complete" as const,
            researchSnapshot: { summary: "Builds measurement tooling" },
            researchedAt: NOW,
          }
        : {}),
    })
    .returning();
  if (options.personalized) {
    await db.insert(schema.evidenceSources).values({
      accountId: account!.id,
      url: `https://evidence.example/${suffix}`,
      sourceType: "website",
    });
  }
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
    bodyTemplate: options.personalized
      ? "{{personalized_opening}} — about {{company}}"
      : "A note for {{company}}",
    ...(options.personalized
      ? {
          personalizationSchema: {
            fields: ["personalized_opening"],
            minConfidence: 0.5,
          },
        }
      : {}),
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

  // A parked row asks its question again every five minutes. That is right
  // while the answer can still change, and wrong once it cannot: an enrolment
  // that was stopped will never acquire an address, so the queue would be
  // telling the operator it is waiting for something that is not coming.
  it("abandons a generation whose sequence ended, instead of waiting forever", async () => {
    const fixture = await prospect();
    const enrollment = await enroll(fixture);
    await db
      .update(schema.enrollments)
      .set({ state: "stopped" })
      .where(eq(schema.enrollments.id, enrollment.id));

    await drain();

    const [command] = await commandsFor(enrollment.id);
    expect(command).toMatchObject({ status: "abandoned" });
    expect(command!.error).toContain("sequence ended");
    expect(await messagesFor(enrollment.id)).toHaveLength(0);
  });

  // The other side of the same rule, and the one that would hurt if it were
  // wrong: `paused` and `manual_review` are not terminal. They resume, so the
  // work must still be there when they do.
  it("keeps waiting for a paused enrolment rather than abandoning it", async () => {
    const fixture = await prospect();
    const enrollment = await enroll(fixture);
    await db
      .update(schema.enrollments)
      .set({ state: "paused" })
      .where(eq(schema.enrollments.id, enrollment.id));

    await drain();

    expect((await commandsFor(enrollment.id))[0]).toMatchObject({
      status: "waiting",
      waitingReason: "awaiting_accepted_email",
    });
  });

  // The follow-up path queues its generations with the recipient already
  // resolved, which skips the address question. That shortcut must not also
  // skip the question of whether there is still anyone to write to — the
  // ordering inside `prepareCommand` is what keeps the two separate, and
  // nothing else asserts it.
  it("abandons an orphaned command even when it already knows the address", async () => {
    const fixture = await prospect({ acceptedEmail: true });
    const enrollment = await enroll(fixture);
    await db
      .update(schema.enrollments)
      .set({ state: "stopped" })
      .where(eq(schema.enrollments.id, enrollment.id));
    const carried = await enqueueOperatorCommand(db, {
      command: "generate-message",
      payload: {
        enrollmentId: enrollment.id,
        stepIndex: 1,
        recipient: "already-known@example.com",
      },
      requestedBy: "automatic_follow_up_policy",
      dedupeKey: `enrollment:${enrollment.id}:generate:1`,
    });

    await drain();

    const [row] = await db
      .select()
      .from(schema.operatorCommands)
      .where(eq(schema.operatorCommands.id, carried.id));
    expect(row).toMatchObject({ status: "abandoned" });
    expect(row!.error).toContain("sequence ended");
  });

  // An abandon costs a claim but does no work, so it draws on the parking
  // budget rather than on the pass's work budget. Asserted with a work budget
  // of one, which is what makes the two accountings distinguishable: if an
  // abandon spent it, the older orphan would exhaust the pass and the one
  // command that could actually run would never be reached.
  //
  // One orphan, not two: the parking budget is twice the work budget, so two
  // would end the pass on their own — correctly, and for the other reason.
  it("does not let an orphaned command spend the pass's work budget", async () => {
    const orphan = await enroll(await prospect());
    await db
      .update(schema.enrollments)
      .set({ state: "stopped" })
      .where(eq(schema.enrollments.id, orphan.id));
    // Queued last, so age alone would serve it last.
    const runnable = await enroll(await prospect({ acceptedEmail: true }));

    await drain(NOW, 1);

    expect((await commandsFor(orphan.id))[0]).toMatchObject({
      status: "abandoned",
    });
    expect(await messagesFor(runnable.id)).toHaveLength(1);
  });

  // The pass drains freely and stops at its first AI turn, so that ten
  // enrolments do not take ten minutes. Which commands take a turn is a
  // property of the data, not of the task name: `generate-message` is
  // deterministic interpolation until a step declares a field for the agent
  // to write. Reading the name alone let a burst of enrolments on a
  // personalized campaign spend the operator's single ChatGPT window once per
  // enrolment inside one pass.
  it("stops a pass at the first generation that asks the agent for a sentence", async () => {
    const first = await prospect({ acceptedEmail: true, personalized: true });
    const second = await prospect({ acceptedEmail: true, personalized: true });
    const firstEnrollment = await enroll(first);
    const secondEnrollment = await enroll(second);

    const drained = await drain();

    expect(drained).toHaveLength(1);
    const written = [
      ...(await messagesFor(firstEnrollment.id)),
      ...(await messagesFor(secondEnrollment.id)),
    ];
    expect(written).toHaveLength(1);

    // The one left behind is still queued, not lost, and the next pass takes
    // it.
    await drain(new Date(NOW.getTime() + 60_000));
    expect([
      ...(await messagesFor(firstEnrollment.id)),
      ...(await messagesFor(secondEnrollment.id)),
    ]).toHaveLength(2);
  });

  // A proposal is a question, and the operator has to be able to answer it.
  //
  // `reviewMessage` only takes an answer from an enrolment that is
  // `ready_for_review`, and the follow-up lane says so itself: it promotes
  // `waiting` to `ready_for_review` when it claims, before the message exists.
  // Nothing said it for the states that lane cannot claim. `manual_review` is
  // the ordinary one — a soft bounce, a definite SMTP refusal, or a held
  // non-terminal reply all park an enrolment there with no `next_action_at` —
  // and the prospect page offers "Generate step N" on exactly those. The
  // message was written, shown on `/review` with its Approve button, and the
  // click came back "Enrollment is not awaiting message review". The only way
  // out was Stop, which discards the prospect's sequence.
  it("lets the operator approve a message they generated on a held enrolment", async () => {
    const fixture = await prospect({ acceptedEmail: true });
    const enrollment = await enroll(fixture);
    // As a soft bounce or a definite recipient refusal leaves it: parked for a
    // human, with nothing scheduled and no inbound hold outstanding.
    await db
      .update(schema.enrollments)
      .set({
        state: "manual_review",
        nextActionAt: null,
        nextActionToken: null,
      })
      .where(eq(schema.enrollments.id, enrollment.id));

    await drain();

    const [message] = await messagesFor(enrollment.id);
    expect(message?.status).toBe("proposed");
    const reviewed = await reviewMessage(db, {
      messageId: message!.id,
      action: { kind: "approve" },
      actor: "operator",
    });
    expect(reviewed.ok).toBe(true);
  });

  // The same rule, for the pair the bug already created. An enrolment that is
  // holding a proposal it cannot approve is unblocked by asking for the
  // message again — which is what an operator does — even though generation
  // finds the row already there and writes nothing.
  it("unblocks an enrolment already holding a proposal it could not approve", async () => {
    const fixture = await prospect({ acceptedEmail: true });
    const enrollment = await enroll(fixture);
    await drain();
    const [message] = await messagesFor(enrollment.id);
    await db
      .update(schema.enrollments)
      .set({
        state: "manual_review",
        nextActionAt: null,
        nextActionToken: null,
      })
      .where(eq(schema.enrollments.id, enrollment.id));

    await enqueueOperatorCommand(db, {
      command: "generate-message",
      payload: { enrollmentId: enrollment.id, stepIndex: 0 },
      requestedBy: "operator",
      dedupeKey: `ui:generate:${enrollment.id}:0:${crypto.randomUUID()}`,
    });
    await drain(new Date(NOW.getTime() + 60_000));

    const reviewed = await reviewMessage(db, {
      messageId: message!.id,
      action: { kind: "approve" },
      actor: "operator",
    });
    expect(reviewed.ok).toBe(true);
  });

  // The other half of the same rule: a deterministic generation costs no turn,
  // so a pass must not stop for it.
  it("drains several deterministic generations in one pass", async () => {
    const first = await prospect({ acceptedEmail: true });
    const second = await prospect({ acceptedEmail: true });
    const firstEnrollment = await enroll(first);
    const secondEnrollment = await enroll(second);

    await drain();

    expect([
      ...(await messagesFor(firstEnrollment.id)),
      ...(await messagesFor(secondEnrollment.id)),
    ]).toHaveLength(2);
  });
});

import { randomUUID } from "node:crypto";

import { and, asc, desc, eq, isNull, lte, or, sql } from "drizzle-orm";
import { z } from "zod";

import {
  campaigns,
  campaignVersions,
  contacts,
  enrollments,
  mailboxConnections,
  messagePersonalizationFields,
  messages,
  operatorSendingSettings,
  sequenceSteps,
  stateTransitions,
  suppressionEntries,
  workflowEvents,
} from "@/lib/db/schema";
import type { AppDatabase } from "@/lib/db/types";
import type { MailProvider } from "@/modules/mailboxes/mail-provider";
import { isTerminalEnrollmentState } from "@/modules/campaigns/enrollment-state";
import { generateOutreachProposal } from "@/modules/messages/generation-service";
import { reviewMessage } from "@/modules/messages/review-service";
import { sendApprovedMessage } from "@/modules/messages/send-service";
import {
  AUTOMATIC_FOLLOW_UP_ACTOR,
  validateWorkflowInvocation,
} from "@/modules/workflows/follow-up-policy";
import { stepDeclaresPersonalization } from "@/modules/messages/personalization-declaration";
import { enqueueOperatorCommand } from "@/modules/workflows/operator-command-queue";

const invocationSchema = z.object({
  enrollmentId: z.uuid(),
  expectedStep: z.number().int().min(0),
  expectedVersionId: z.uuid(),
  expectedDueAt: z.coerce.date(),
  expectedToken: z.string().trim().min(1).max(200),
});

/**
 * Hands the enrolment back to the operator, and stops it being due.
 *
 * The target state is a parameter because the two reasons to hand back are not
 * the same thing. Something that went wrong — a generation that failed — is
 * `manual_review`: there may be no message, and a human has to decide what to
 * do at all. A message waiting for a decision is `ready_for_review`, which is
 * the state `reviewMessage` requires: it refuses to approve anything whose
 * enrolment is not in it. Handing a perfectly good personalized message to
 * `manual_review` therefore parked it where the operator could see it and not
 * act on it.
 */
async function markFollowUpHandedBack(
  db: AppDatabase,
  input: z.infer<typeof invocationSchema>,
  now: Date,
  reason: string,
  claimId: string,
  state: "manual_review" | "ready_for_review" = "manual_review",
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(
      sql`select id from enrollments where id = ${input.enrollmentId} for update`,
    );
    const [current] = await tx
      .select()
      .from(enrollments)
      .where(eq(enrollments.id, input.enrollmentId))
      .limit(1);
    if (!current) return;
    if (current.workflowClaimId !== claimId) return;
    // Terminal enrolments are left alone — handing one back would resurrect a
    // sequence somebody ended. Everything else is handed back, and the
    // schedule is cleared whether or not the state itself changes: an enrolment
    // already sitting in the target state can still be carrying the
    // `nextActionAt` and token of the very follow-up being refused, which is
    // live work pointing at a decision already taken.
    if (!isTerminalEnrollmentState(current.state)) {
      await tx
        .update(enrollments)
        .set({
          state,
          nextActionAt: null,
          nextActionToken: null,
          workflowClaimId: null,
          workflowClaimedAt: null,
        })
        .where(eq(enrollments.id, current.id));
      // Only when it actually moved: a transition row from a state to itself
      // records nothing and reads as noise in the audit.
      if (current.state !== state) {
        await tx.insert(stateTransitions).values({
          entityType: "enrollment",
          entityId: current.id,
          fromState: current.state,
          toState: state,
          reason,
          metadata: {
            expectedStep: input.expectedStep,
            expectedToken: input.expectedToken,
          },
        });
      }
    }
    await tx
      .update(workflowEvents)
      .set({ status: "failed", completedAt: now, error: reason })
      .where(
        eq(
          workflowEvents.idempotencyKey,
          `followup:${input.enrollmentId}:${input.expectedToken}:claim:${claimId}`,
        ),
      );
  });
}

async function auditFollowUpBlock(
  db: AppDatabase,
  input: z.infer<typeof invocationSchema>,
  code: string,
  now: Date,
): Promise<void> {
  await db
    .insert(workflowEvents)
    .values({
      entityType: "enrollment",
      entityId: input.enrollmentId,
      event: "follow_up.policy_blocked",
      workflowName: "follow_up_progression",
      idempotencyKey: `followup:${input.enrollmentId}:${input.expectedToken}:blocked:${code}`,
      status: "skipped",
      completedAt: now,
      payload: { code, expectedStep: input.expectedStep },
    })
    .onConflictDoNothing();
}

async function rescheduleFollowUp(
  db: AppDatabase,
  input: z.infer<typeof invocationSchema>,
  now: Date,
  code: string,
  claimId?: string,
): Promise<void> {
  const retryAt = new Date(
    now.getTime() + (code === "IN_PROGRESS" ? 5_000 : 15 * 60_000),
  );
  await db.transaction(async (tx) => {
    await tx.execute(
      sql`select id from enrollments where id = ${input.enrollmentId} for update`,
    );
    const [current] = await tx
      .select()
      .from(enrollments)
      .where(eq(enrollments.id, input.enrollmentId))
      .limit(1);
    if (
      !current ||
      isTerminalEnrollmentState(current.state) ||
      (claimId && current.workflowClaimId !== claimId)
    )
      return;
    await tx
      .update(enrollments)
      .set({
        state: "waiting",
        nextActionAt: retryAt,
        workflowClaimId: null,
        workflowClaimedAt: null,
      })
      .where(eq(enrollments.id, current.id));
    if (current.state !== "waiting") {
      await tx.insert(stateTransitions).values({
        entityType: "enrollment",
        entityId: current.id,
        fromState: current.state,
        toState: "waiting",
        reason: "follow_up_retry_scheduled",
        metadata: { code, retryAt: retryAt.toISOString() },
      });
    }
    await tx
      .insert(workflowEvents)
      .values({
        entityType: "enrollment",
        entityId: current.id,
        event: "follow_up.retry_scheduled",
        workflowName: "follow_up_progression",
        idempotencyKey: `followup:${current.id}:${input.expectedToken}:retry:${code}:${retryAt.toISOString()}`,
        status: "scheduled",
        scheduledAt: retryAt,
        payload: { code, retryAt: retryAt.toISOString() },
      })
      .onConflictDoNothing();
  });
}

async function releaseFollowUpClaim(
  db: AppDatabase,
  enrollmentId: string,
  claimId: string,
): Promise<void> {
  await db
    .update(enrollments)
    .set({ workflowClaimId: null, workflowClaimedAt: null })
    .where(
      and(
        eq(enrollments.id, enrollmentId),
        eq(enrollments.workflowClaimId, claimId),
      ),
    );
}

export async function findDueEnrollments(
  db: AppDatabase,
  input: { now?: Date; limit?: number } = {},
): Promise<
  Array<{
    enrollmentId: string;
    expectedStep: number;
    expectedVersionId: string;
    expectedDueAt: Date;
    expectedToken: string;
  }>
> {
  const now = input.now ?? new Date();
  const limit = Math.min(Math.max(input.limit ?? 50, 1), 200);
  const rows = await db
    .select({
      enrollmentId: enrollments.id,
      expectedStep: enrollments.currentStep,
      expectedVersionId: enrollments.campaignVersionId,
      expectedDueAt: enrollments.nextActionAt,
      expectedToken: enrollments.nextActionToken,
    })
    .from(enrollments)
    .where(
      and(
        or(
          eq(enrollments.state, "waiting"),
          eq(enrollments.state, "approved"),
          and(
            eq(enrollments.state, "ready_for_review"),
            sql`not exists (
              select 1 from messages due_message
              where due_message.enrollment_id = ${enrollments.id}
                and due_message.direction = 'outbound'
                and due_message.step_index = ${enrollments.currentStep}
                -- A step whose only message was proven undeliverable has no
                -- message: the ladder freed it to be written again.
                and due_message.address_dead_at is null
            )`,
          ),
        ),
        lte(enrollments.nextActionAt, now),
        sql`${enrollments.nextActionToken} is not null`,
      ),
    )
    .orderBy(asc(enrollments.nextActionAt))
    .limit(limit);
  return rows.flatMap((row) =>
    row.expectedDueAt && row.expectedToken
      ? [
          {
            ...row,
            expectedDueAt: row.expectedDueAt,
            expectedToken: row.expectedToken,
          },
        ]
      : [],
  );
}

export async function processFollowUpInvocation(
  db: AppDatabase,
  provider: MailProvider,
  rawInput: unknown,
  options: {
    now?: Date;
    crashAt?: "after_claim" | "after_approval";
    claimLeaseMs?: number;
    clock?: () => Date;
  } = {},
): Promise<
  | {
      ok: true;
      disposition: "awaiting_review" | "sent" | "already_sent";
      messageId: string;
    }
  // Its own member, deliberately without a `messageId`: nothing was written
  // yet, and a caller that reads one here would be reading a message that does
  // not exist.
  | { ok: true; disposition: "generation_queued" }
  | {
      ok: false;
      code:
        | "INVALID_INPUT"
        | "NOT_FOUND"
        | "NOT_DUE"
        | "STALE_INVOCATION"
        | "CAMPAIGN_INACTIVE"
        | "MAILBOX_UNAVAILABLE"
        | "EMERGENCY_PAUSED"
        | "REPLY_PENDING"
        | "IN_PROGRESS"
        | "RECIPIENT_SUPPRESSED"
        | "COMPANY_SUPPRESSED"
        | "PROFESSIONAL_RELEVANCE_REQUIRED"
        | "MISSING_STEP"
        | "GENERATION_ERROR"
        | "REVIEW_ERROR"
        | "SEND_BLOCKED"
        | "DATABASE_ERROR";
      blockCode?: string;
    }
> {
  const parsed = invocationSchema.safeParse(rawInput);
  if (!parsed.success) return { ok: false, code: "INVALID_INPUT" };
  const input = parsed.data;
  const clock = options.clock ?? (() => new Date());
  const now = options.now ?? clock();
  const claimLeaseMs = options.claimLeaseMs ?? 60_000;
  const claimId = randomUUID();
  try {
    const claim = await db.transaction(async (tx) => {
      await tx.execute(
        sql`select id from enrollments where id = ${input.enrollmentId} for update`,
      );
      const [context] = await tx
        .select({
          enrollment: enrollments,
          campaignStatus: campaigns.status,
          configuration: campaignVersions.configuration,
          mailboxStatus: mailboxConnections.status,
          professionalRelevance: contacts.professionalRelevance,
          recipient: messages.recipient,
          stepId: sequenceSteps.id,
          emergencyPause: operatorSendingSettings.emergencyPause,
        })
        .from(enrollments)
        .innerJoin(campaigns, eq(campaigns.id, enrollments.campaignId))
        .innerJoin(
          campaignVersions,
          eq(campaignVersions.id, enrollments.campaignVersionId),
        )
        .innerJoin(contacts, eq(contacts.id, enrollments.contactId))
        .innerJoin(
          sequenceSteps,
          and(
            eq(sequenceSteps.campaignVersionId, enrollments.campaignVersionId),
            eq(sequenceSteps.stepIndex, enrollments.currentStep),
          ),
        )
        .innerJoin(
          messages,
          and(
            eq(messages.enrollmentId, enrollments.id),
            eq(messages.direction, "outbound"),
            eq(messages.stepIndex, sql`${enrollments.currentStep} - 1`),
            /**
             * Never the address a ladder advance proved does not exist.
             *
             * A follow-up addresses the thread it is following, so it takes the
             * previous step's recipient — and after an advance that step has two
             * messages, the dead one and the one that replaced it. Picking the
             * dead one would send to an address this product permanently
             * suppressed one line of code earlier, so the follow-up would be
             * refused and the enrollment stopped as `recipient_suppressed`: an
             * enrollment the ladder had just saved, killed by the rescue.
             *
             * The `limit(1)` below made that a coin toss rather than a certainty,
             * which is worse. The ordering makes the surviving row deterministic
             * as well as live.
             */
            isNull(messages.addressDeadAt),
          ),
        )
        .leftJoin(
          mailboxConnections,
          eq(mailboxConnections.id, enrollments.mailboxId),
        )
        .leftJoin(operatorSendingSettings, eq(operatorSendingSettings.id, 1))
        .where(eq(enrollments.id, input.enrollmentId))
        // One row per enrollment once the dead ones are excluded, but ordered
        // rather than left to chance: `limit(1)` over an unordered join is how
        // the dead address would have been picked half the time.
        .orderBy(desc(messages.sentAt))
        .limit(1);
      if (!context) {
        const [enrollmentOnly] = await tx
          .select()
          .from(enrollments)
          .where(eq(enrollments.id, input.enrollmentId))
          .limit(1);
        return enrollmentOnly
          ? ({ kind: "missing_step" } as const)
          : ({ kind: "not_found" } as const);
      }
      if (context.enrollment.inboundHoldCount > 0) {
        return { kind: "blocked", code: "REPLY_PENDING" } as const;
      }
      const invocation = validateWorkflowInvocation(
        {
          enrollmentState: context.enrollment.state,
          campaignVersionId: context.enrollment.campaignVersionId,
          currentStep: context.enrollment.currentStep,
          nextActionAt: context.enrollment.nextActionAt,
          nextActionToken: context.enrollment.nextActionToken,
        },
        input,
        now,
      );
      if (!invocation.ok)
        return { kind: "invalid", code: invocation.code } as const;
      if (
        context.enrollment.workflowClaimId &&
        context.enrollment.workflowClaimedAt &&
        now.getTime() - context.enrollment.workflowClaimedAt.getTime() <
          claimLeaseMs
      ) {
        return { kind: "in_progress" } as const;
      }
      if (context.campaignStatus !== "active") {
        return { kind: "blocked", code: "CAMPAIGN_INACTIVE" } as const;
      }
      if (context.emergencyPause) {
        return { kind: "blocked", code: "EMERGENCY_PAUSED" } as const;
      }
      if (
        context.enrollment.mailboxId &&
        context.mailboxStatus !== "available"
      ) {
        return { kind: "blocked", code: "MAILBOX_UNAVAILABLE" } as const;
      }
      const domain = context.recipient.split("@")[1] ?? "";
      const suppressed = await tx
        .select({ scope: suppressionEntries.scope })
        .from(suppressionEntries)
        .where(
          or(
            and(
              eq(suppressionEntries.scope, "email"),
              eq(suppressionEntries.normalizedValue, context.recipient),
            ),
            and(
              eq(suppressionEntries.scope, "domain"),
              eq(suppressionEntries.normalizedValue, domain),
            ),
          ),
        );
      const suppressionBlock = suppressed.some((row) => row.scope === "email")
        ? {
            code: "RECIPIENT_SUPPRESSED" as const,
            stopReason: "recipient_suppressed" as const,
          }
        : suppressed.some((row) => row.scope === "domain")
          ? {
              code: "COMPANY_SUPPRESSED" as const,
              stopReason: "company_suppressed" as const,
            }
          : null;
      if (suppressionBlock) {
        await tx
          .update(enrollments)
          .set({
            state: "stopped",
            stopReason: suppressionBlock.stopReason,
            stoppedAt: now,
            nextActionAt: null,
            nextActionToken: null,
            inboundHoldCount: 0,
            inboundHoldAt: null,
            inboundHoldPreviousState: null,
            inboundHoldPreviousNextActionAt: null,
            inboundHoldPreviousNextActionToken: null,
            workflowClaimId: null,
            workflowClaimedAt: null,
          })
          .where(eq(enrollments.id, context.enrollment.id));
        await tx.insert(stateTransitions).values({
          entityType: "enrollment",
          entityId: context.enrollment.id,
          fromState: context.enrollment.state,
          toState: "stopped",
          reason: suppressionBlock.stopReason,
          metadata: { expectedStep: input.expectedStep },
        });
        return { kind: "blocked", code: suppressionBlock.code } as const;
      }
      const config = context.configuration as {
        automaticFollowUps?: boolean;
        requireProfessionalRelevance?: boolean;
      };
      const relevance = context.professionalRelevance as {
        relevant?: unknown;
      } | null;
      if (config.requireProfessionalRelevance && relevance?.relevant !== true) {
        return {
          kind: "blocked",
          code: "PROFESSIONAL_RELEVANCE_REQUIRED",
        } as const;
      }
      const [claimed] =
        context.enrollment.state === "waiting"
          ? await tx
              .update(enrollments)
              .set({
                state: "ready_for_review",
                workflowClaimId: claimId,
                workflowClaimedAt: now,
              })
              .where(eq(enrollments.id, context.enrollment.id))
              .returning()
          : await tx
              .update(enrollments)
              .set({ workflowClaimId: claimId, workflowClaimedAt: now })
              .where(eq(enrollments.id, context.enrollment.id))
              .returning();
      if (!claimed) throw new Error("Follow-up claim returned no row");
      if (context.enrollment.state === "waiting") {
        await tx.insert(stateTransitions).values({
          entityType: "enrollment",
          entityId: claimed.id,
          fromState: "waiting",
          toState: "ready_for_review",
          reason: "due_follow_up_claimed",
          metadata: {
            expectedStep: input.expectedStep,
            expectedToken: input.expectedToken,
          },
        });
      }
      await tx
        .insert(workflowEvents)
        .values({
          entityType: "enrollment",
          entityId: claimed.id,
          event: "follow_up.due_claimed",
          workflowName: "follow_up_progression",
          idempotencyKey: `followup:${claimed.id}:${input.expectedToken}:claim:${claimId}`,
          status: "started",
          startedAt: now,
          payload: {
            expectedStep: input.expectedStep,
            expectedVersionId: input.expectedVersionId,
          },
        })
        .onConflictDoNothing();
      return {
        kind: "claimed",
        automatic: config.automaticFollowUps === true,
        recipient: context.recipient,
        claimId,
      } as const;
    });

    if (claim.kind === "not_found") return { ok: false, code: "NOT_FOUND" };
    if (claim.kind === "missing_step")
      return { ok: false, code: "MISSING_STEP" };
    if (claim.kind === "invalid") return { ok: false, code: claim.code };
    if (claim.kind === "in_progress") {
      return { ok: false, code: "IN_PROGRESS" };
    }
    if (claim.kind === "blocked") {
      await auditFollowUpBlock(db, input, claim.code, now);
      if (
        [
          "CAMPAIGN_INACTIVE",
          "MAILBOX_UNAVAILABLE",
          "EMERGENCY_PAUSED",
        ].includes(claim.code)
      ) {
        await rescheduleFollowUp(db, input, now, claim.code);
      }
      return { ok: false, code: claim.code };
    }

    if (options.crashAt === "after_claim") {
      throw new Error("Injected crash after follow-up claim");
    }

    // A step that asks an agent for a sentence cannot be generated here.
    //
    // This stage loops over every due enrolment, so an agent call inside the
    // loop would spend the operator's single ChatGPT window once per due
    // prospect, unbounded — exactly the bound the command queue exists to
    // impose, and the reason step zero was queued in the first place. The work
    // goes to the queue, which spends at most one turn per pass.
    //
    // The enrolment goes to review in the same movement, and that costs
    // nothing: personalized text and unattended sending are mutually exclusive
    // by design, so this path was never going to send the result anyway. What
    // it would otherwise have done — generate deterministically — is worse
    // than waiting: it would write a message with the agent's sentence
    // missing, and interpolation fails on it.
    const [declaringStep] = await db
      .select({ declared: sequenceSteps.personalizationSchema })
      .from(sequenceSteps)
      .where(
        and(
          eq(sequenceSteps.campaignVersionId, input.expectedVersionId),
          eq(sequenceSteps.stepIndex, input.expectedStep),
        ),
      )
      .limit(1);
    if (stepDeclaresPersonalization(declaringStep?.declared)) {
      // The same key shape enrolment uses for step zero, so a re-invocation
      // that arrives before the review mark lands answers "already queued"
      // instead of writing a second row.
      await enqueueOperatorCommand(db, {
        command: "generate-message",
        payload: {
          enrollmentId: input.enrollmentId,
          stepIndex: input.expectedStep,
          // Carried rather than left for the queue to re-derive. A follow-up
          // addresses the thread it is following: this is the previous step's
          // recipient, which is what this path has always used and is not
          // necessarily the contact's currently accepted candidate. Re-deriving
          // would quietly change which address a follow-up goes to.
          recipient: claim.recipient,
        },
        requestedBy: AUTOMATIC_FOLLOW_UP_ACTOR,
        dedupeKey: `enrollment:${input.enrollmentId}:generate:${input.expectedStep}`,
      });
      await markFollowUpHandedBack(
        db,
        input,
        now,
        "personalized_follow_up_queued",
        claim.claimId,
        // A message is coming and the operator will have to decide on it.
        // `reviewMessage` refuses to approve anything whose enrolment is not
        // `ready_for_review`, so parking it in `manual_review` would show the
        // card and refuse the click.
        "ready_for_review",
      );
      return { ok: true, disposition: "generation_queued" };
    }

    const generated = await generateOutreachProposal(db, {
      enrollmentId: input.enrollmentId,
      stepIndex: input.expectedStep,
      recipient: claim.recipient,
      workflowClaimId: claim.claimId,
    });
    if (!generated.ok) {
      await markFollowUpHandedBack(
        db,
        input,
        now,
        "follow_up_generation_failed",
        claim.claimId,
      );
      return { ok: false, code: "GENERATION_ERROR" };
    }
    if (!claim.automatic) {
      await releaseFollowUpClaim(db, input.enrollmentId, claim.claimId);
      await db
        .update(workflowEvents)
        .set({ status: "succeeded", completedAt: now })
        .where(
          eq(
            workflowEvents.idempotencyKey,
            `followup:${input.enrollmentId}:${input.expectedToken}:claim:${claim.claimId}`,
          ),
        );
      return {
        ok: true,
        disposition: "awaiting_review",
        messageId: generated.message.id,
      };
    }
    // A sentence an agent wrote has to reach the operator's eye. Automatic
    // follow-ups approve and send in one pass, so a message that already
    // carries agent-written fields — pre-generated by an operator wanting to
    // read it ahead of time, for instance — would go out unread. Personalized
    // text and unattended sending are mutually exclusive by design, and this
    // is where the two paths would otherwise meet.
    const [personalized] = await db
      .select({ id: messagePersonalizationFields.id })
      .from(messagePersonalizationFields)
      .where(eq(messagePersonalizationFields.messageId, generated.message.id))
      .limit(1);
    if (personalized) {
      // No `releaseFollowUpClaim` first, deliberately.
      // `markFollowUpHandedBack` is fenced on the claim id and clears the
      // claim itself when it succeeds. Releasing beforehand made the mark a
      // silent no-op: the message was correctly not sent, but the enrolment
      // stayed `ready_for_review` carrying a `nextActionAt` and a token for a
      // follow-up that had already been refused. It was not picked up again,
      // but only by accident — `findDueEnrollments` skips a
      // `ready_for_review` row that already has a message at its step. Cancel
      // that message and the stale schedule becomes live work again. Every
      // other hand-back marks first, for the same reason. The one branch that
      // releases without marking — a non-automatic generation that succeeded,
      // above — leaves the same stale schedule behind, and is dormant on the
      // same accident rather than on a guarantee.
      await markFollowUpHandedBack(
        db,
        input,
        now,
        "personalized_message_requires_review",
        claim.claimId,
        // Same reason: there is a perfectly good `proposed` message here and
        // the only thing left to do with it is approve it.
        "ready_for_review",
      );
      return {
        ok: true,
        disposition: "awaiting_review",
        messageId: generated.message.id,
      };
    }
    if (generated.message.status === "proposed") {
      const reviewed = await reviewMessage(db, {
        messageId: generated.message.id,
        action: { kind: "approve" },
        actor: AUTOMATIC_FOLLOW_UP_ACTOR,
        workflowClaimId: claim.claimId,
      });
      if (!reviewed.ok) {
        await markFollowUpHandedBack(
          db,
          input,
          now,
          "follow_up_review_failed",
          claim.claimId,
        );
        return { ok: false, code: "REVIEW_ERROR" };
      }
    } else if (["approved", "drafted"].includes(generated.message.status)) {
      await db
        .update(enrollments)
        .set({ state: "approved" })
        .where(eq(enrollments.id, input.enrollmentId));
    }
    if (options.crashAt === "after_approval") {
      throw new Error("Injected crash after follow-up approval");
    }
    const sent = await sendApprovedMessage(
      db,
      provider,
      { messageId: generated.message.id },
      {
        clock,
        globalLockAttempts: 20,
        globalLockRetryDelayMs: 25,
        workflowClaimId: claim.claimId,
      },
    );
    if (!sent.ok) {
      const transient = [
        "IN_PROGRESS",
        "PROVIDER_ERROR",
        "CAMPAIGN_INACTIVE",
        "MAILBOX_UNAVAILABLE",
        "EMERGENCY_PAUSED",
        "OUTSIDE_WORKING_HOURS",
        "MAILBOX_DAILY_CAP_REACHED",
        "CAMPAIGN_DAILY_CAP_REACHED",
        "MAILBOX_MINIMUM_DELAY",
        "CONTACT_MINIMUM_DELAY",
        "RECENT_CONTACT_COOLDOWN",
      ].includes(sent.code);
      if (transient) {
        await rescheduleFollowUp(db, input, now, sent.code, claim.claimId);
        await auditFollowUpBlock(db, input, sent.code, now);
      } else {
        await markFollowUpHandedBack(
          db,
          input,
          now,
          `follow_up_send_blocked:${sent.code}`,
          claim.claimId,
        );
      }
      return { ok: false, code: "SEND_BLOCKED", blockCode: sent.code };
    }
    await db
      .update(workflowEvents)
      .set({ status: "succeeded", completedAt: now })
      .where(
        eq(
          workflowEvents.idempotencyKey,
          `followup:${input.enrollmentId}:${input.expectedToken}:claim:${claim.claimId}`,
        ),
      );
    return {
      ok: true,
      disposition: sent.disposition,
      messageId: sent.message.id,
    };
  } catch {
    return { ok: false, code: "DATABASE_ERROR" };
  }
}

export async function reconcileDueFollowUps(
  db: AppDatabase,
  provider: MailProvider,
  options: { now?: Date; limit?: number; concurrency?: number } = {},
) {
  const due = await findDueEnrollments(db, options);
  const results: Awaited<ReturnType<typeof processFollowUpInvocation>>[] = [];
  const concurrency = Math.min(Math.max(options.concurrency ?? 5, 1), 10);
  let nextIndex = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, due.length) }, async () => {
      while (nextIndex < due.length) {
        const index = nextIndex;
        nextIndex += 1;
        results[index] = await processFollowUpInvocation(
          db,
          provider,
          due[index]!,
          { now: options.now },
        );
      }
    }),
  );
  return results;
}

import { randomUUID } from "node:crypto";

import { and, asc, eq, lte, or, sql } from "drizzle-orm";
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

const invocationSchema = z.object({
  enrollmentId: z.uuid(),
  expectedStep: z.number().int().min(0),
  expectedVersionId: z.uuid(),
  expectedDueAt: z.coerce.date(),
  expectedToken: z.string().trim().min(1).max(200),
});

async function markFollowUpManualReview(
  db: AppDatabase,
  input: z.infer<typeof invocationSchema>,
  now: Date,
  reason: string,
  claimId: string,
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
    if (
      !isTerminalEnrollmentState(current.state) &&
      current.state !== "manual_review"
    ) {
      await tx
        .update(enrollments)
        .set({
          state: "manual_review",
          nextActionAt: null,
          nextActionToken: null,
          workflowClaimId: null,
          workflowClaimedAt: null,
        })
        .where(eq(enrollments.id, current.id));
      await tx.insert(stateTransitions).values({
        entityType: "enrollment",
        entityId: current.id,
        fromState: current.state,
        toState: "manual_review",
        reason,
        metadata: {
          expectedStep: input.expectedStep,
          expectedToken: input.expectedToken,
        },
      });
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
          ),
        )
        .leftJoin(
          mailboxConnections,
          eq(mailboxConnections.id, enrollments.mailboxId),
        )
        .leftJoin(operatorSendingSettings, eq(operatorSendingSettings.id, 1))
        .where(eq(enrollments.id, input.enrollmentId))
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

    const generated = await generateOutreachProposal(db, {
      enrollmentId: input.enrollmentId,
      stepIndex: input.expectedStep,
      recipient: claim.recipient,
      workflowClaimId: claim.claimId,
    });
    if (!generated.ok) {
      await markFollowUpManualReview(
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
      await releaseFollowUpClaim(db, input.enrollmentId, claim.claimId);
      await markFollowUpManualReview(
        db,
        input,
        now,
        "personalized_message_requires_review",
        claim.claimId,
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
        await markFollowUpManualReview(
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
        await markFollowUpManualReview(
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

import { randomUUID } from "node:crypto";

import {
  and,
  desc,
  eq,
  gte,
  inArray,
  isNotNull,
  ne,
  or,
  sql,
} from "drizzle-orm";
import { z } from "zod";

import {
  campaigns,
  campaignVersions,
  contacts,
  emailCandidates,
  enrollments,
  graphNotificationReceipts,
  mailboxConnections,
  messages,
  operatorSendingSettings,
  sequenceSteps,
  stateTransitions,
  suppressionEntries,
  workflowEvents,
} from "@/lib/db/schema";
import type { AppDatabase } from "@/lib/db/types";
import type {
  MailProvider,
  MailReconciliation,
  SentMail,
} from "@/modules/mailboxes/mail-provider";
import { isTerminalEnrollmentState } from "@/modules/campaigns/enrollment-state";
import { evaluateSendPolicy } from "@/modules/messages/send-policy";
import type { SendPolicyBlockCode } from "@/modules/messages/send-policy";
import { isWithinWorkingHours } from "@/modules/settings/service";
import { calculateNextActionAt } from "@/modules/workflows/follow-up-policy";
import { actionLockKey, withActionLocks } from "@/lib/db/action-lock";
import { isActionLockBusy } from "@/lib/db/action-lock";

const inputSchema = z.object({ messageId: z.uuid() });
type Message = typeof messages.$inferSelect;
type SendServiceOptions = {
  clock?: () => Date;
  claimStaleAfterMs?: number;
  providerOperationTimeoutMs?: number;
  globalLockAttempts?: number;
  globalLockRetryDelayMs?: number;
  workflowClaimId?: string;
};

async function providerOperation<T>(
  timeoutMs: number,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new Error("Mail provider operation timed out")),
    timeoutMs,
  );
  try {
    return await Promise.race([
      operation(controller.signal),
      new Promise<never>((_, reject) =>
        controller.signal.addEventListener(
          "abort",
          () => reject(controller.signal.reason),
          { once: true },
        ),
      ),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

export type SendMessageResult =
  | {
      ok: true;
      disposition: "sent" | "already_sent";
      message: Message;
    }
  | {
      ok: false;
      code:
        | "INVALID_INPUT"
        | "NOT_FOUND"
        | "MAILBOX_PROVIDER_MISMATCH"
        | SendPolicyBlockCode
        | "IN_PROGRESS"
        | "DELIVERY_UNCERTAIN"
        | "PROVIDER_ERROR"
        | "DATABASE_ERROR";
      message?: string;
    };

type BlockCode = SendPolicyBlockCode | "MAILBOX_PROVIDER_MISMATCH";

function providerBindingCode(
  provider: MailProvider,
  mailbox: {
    id: string | null;
    provider: "mock" | "microsoft_graph" | null;
    status: string | null;
  },
  requireAvailable = true,
): "MAILBOX_UNAVAILABLE" | "MAILBOX_PROVIDER_MISMATCH" | null {
  if (!mailbox.id) {
    return provider.kind === "mock" ? null : "MAILBOX_UNAVAILABLE";
  }
  if (mailbox.provider !== provider.kind) return "MAILBOX_PROVIDER_MISMATCH";
  if (requireAvailable && mailbox.status !== "available") {
    return "MAILBOX_UNAVAILABLE";
  }
  return null;
}

async function recordBlocked(
  db: AppDatabase,
  messageId: string,
  code: BlockCode,
  now = new Date(),
): Promise<void> {
  await db
    .insert(workflowEvents)
    .values({
      entityType: "message",
      entityId: messageId,
      event: "message.send_blocked",
      workflowName: "send_message",
      idempotencyKey: `send:${messageId}:blocked:${code}`,
      status: "skipped",
      completedAt: now,
      payload: { code },
    })
    .onConflictDoNothing();
}

async function recordProviderFailure(
  db: AppDatabase,
  messageId: string,
  phase: "reconcile" | "create_draft",
  claimToken: string | null,
  now: Date,
  releasePreSendClaim = true,
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(
      sql`select id from messages where id = ${messageId} for update`,
    );
    const [current] = await tx
      .select()
      .from(messages)
      .where(eq(messages.id, messageId))
      .limit(1);
    if (!current) return;
    if (
      releasePreSendClaim &&
      current.attemptCount === 0 &&
      (!claimToken || current.sendAttemptToken === claimToken)
    ) {
      const safeStatus = current.providerDraftId ? "drafted" : "approved";
      await tx
        .update(messages)
        .set({
          status: safeStatus,
          sendAttemptToken: null,
          sendClaimedAt: null,
          lastError: "Mail provider operation failed",
        })
        .where(eq(messages.id, messageId));
      if (current.status !== safeStatus) {
        await tx.insert(stateTransitions).values({
          entityType: "message",
          entityId: messageId,
          fromState: current.status,
          toState: safeStatus,
          reason: `provider_${phase}_failed_before_send`,
        });
      }
    }
    await tx
      .insert(workflowEvents)
      .values({
        entityType: "message",
        entityId: messageId,
        event: "message.provider_failed",
        workflowName: "send_message",
        idempotencyKey: `send:${messageId}:provider_failed:${phase}:${claimToken ?? "recovery"}`,
        status: "failed",
        completedAt: now,
        error: "Mail provider operation failed",
        payload: { phase },
      })
      .onConflictDoNothing();
  });
}

async function finalizeSent(
  db: AppDatabase,
  messageId: string,
  sent: SentMail,
  providerDraftId: string,
  now: Date,
): Promise<Message | null> {
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select id from messages where id = ${messageId} for update`,
    );
    const [current] = await tx
      .select()
      .from(messages)
      .where(eq(messages.id, messageId))
      .limit(1);
    if (!current) return null;
    if (current.status === "sent") return current;

    const [updated] = await tx
      .update(messages)
      .set({
        status: "sent",
        providerDraftId,
        providerMessageId: sent.providerMessageId,
        internetMessageId: sent.internetMessageId,
        conversationId: sent.conversationId,
        sentAt: now,
        lastError: null,
      })
      .where(eq(messages.id, messageId))
      .returning();
    if (!updated) return null;

    await tx.execute(
      sql`select id from enrollments where id = ${updated.enrollmentId} for update`,
    );
    const [enrollment] = await tx
      .select()
      .from(enrollments)
      .where(eq(enrollments.id, updated.enrollmentId))
      .limit(1);
    if (!enrollment) throw new Error("Sent enrollment is missing");
    const nextStepIndex = (updated.stepIndex ?? enrollment.currentStep) + 1;
    const [nextStep] = await tx
      .select()
      .from(sequenceSteps)
      .where(
        and(
          eq(sequenceSteps.campaignVersionId, enrollment.campaignVersionId),
          eq(sequenceSteps.stepIndex, nextStepIndex),
        ),
      )
      .limit(1);
    const preserveEnrollment = isTerminalEnrollmentState(enrollment.state);
    const enrollmentUpdate = preserveEnrollment
      ? {
          lastMessageAt: now,
          workflowClaimId: null,
          workflowClaimedAt: null,
        }
      : nextStep
        ? {
            state: "waiting" as const,
            currentStep: nextStep.stepIndex,
            nextActionAt: calculateNextActionAt(now, nextStep.delayMinutes),
            nextActionToken: `followup_${randomUUID()}`,
            lastMessageAt: now,
            stopReason: null,
            stoppedAt: null,
            workflowClaimId: null,
            workflowClaimedAt: null,
          }
        : {
            state: "completed" as const,
            currentStep: updated.stepIndex ?? enrollment.currentStep,
            nextActionAt: null,
            nextActionToken: null,
            lastMessageAt: now,
            stopReason: "sequence_complete" as const,
            stoppedAt: now,
            workflowClaimId: null,
            workflowClaimedAt: null,
          };
    const [updatedEnrollment] = await tx
      .update(enrollments)
      .set(enrollmentUpdate)
      .where(eq(enrollments.id, enrollment.id))
      .returning();
    await tx.insert(stateTransitions).values({
      entityType: "message",
      entityId: updated.id,
      fromState: current.status,
      toState: "sent",
      reason: "provider_reconciliation_confirmed",
    });
    if (
      !preserveEnrollment &&
      updatedEnrollment &&
      updatedEnrollment.state !== enrollment.state
    ) {
      await tx.insert(stateTransitions).values({
        entityType: "enrollment",
        entityId: updated.enrollmentId,
        fromState: enrollment.state,
        toState: updatedEnrollment.state,
        reason: nextStep ? "follow_up_scheduled" : "sequence_complete",
        metadata: nextStep
          ? {
              nextStep: nextStep.stepIndex,
              nextActionAt: updatedEnrollment.nextActionAt?.toISOString(),
              nextActionToken: updatedEnrollment.nextActionToken,
            }
          : {},
      });
      if (nextStep) {
        await tx.insert(workflowEvents).values({
          entityType: "enrollment",
          entityId: enrollment.id,
          event: "follow_up.scheduled",
          workflowName: "follow_up_progression",
          idempotencyKey: `followup:${enrollment.id}:${nextStep.stepIndex}:${updatedEnrollment.nextActionToken}`,
          status: "scheduled",
          scheduledAt: updatedEnrollment.nextActionAt,
          payload: {
            expectedStep: nextStep.stepIndex,
            expectedVersionId: enrollment.campaignVersionId,
            expectedDueAt: updatedEnrollment.nextActionAt?.toISOString(),
            expectedToken: updatedEnrollment.nextActionToken,
          },
        });
      }
    }
    if (current.sendAttemptToken) {
      await tx
        .update(workflowEvents)
        .set({ status: "succeeded", completedAt: now, error: null })
        .where(
          eq(
            workflowEvents.idempotencyKey,
            `send:${updated.id}:attempt:${current.sendAttemptToken}`,
          ),
        );
    }
    await tx
      .insert(workflowEvents)
      .values({
        entityType: "message",
        entityId: updated.id,
        event: "message.sent",
        workflowName: "send_message",
        idempotencyKey: `send:${updated.id}:sent`,
        status: "succeeded",
        completedAt: now,
        payload: { providerMessageId: sent.providerMessageId },
      })
      .onConflictDoNothing();
    return updated;
  });
}

async function markDeliveryUncertain(
  db: AppDatabase,
  messageId: string,
  reason: string,
  transitionReason: string,
  now: Date,
): Promise<Message | null> {
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select id from messages where id = ${messageId} for update`,
    );
    const [current] = await tx
      .select()
      .from(messages)
      .where(eq(messages.id, messageId))
      .limit(1);
    if (!current) return null;
    if (current.status === "sent" || current.status === "delivery_uncertain") {
      return current;
    }
    const [updated] = await tx
      .update(messages)
      .set({ status: "delivery_uncertain", lastError: reason })
      .where(eq(messages.id, messageId))
      .returning();
    if (!updated) return null;
    await tx.insert(stateTransitions).values({
      entityType: "message",
      entityId: updated.id,
      fromState: current.status,
      toState: "delivery_uncertain",
      reason: transitionReason,
    });
    if (current.sendAttemptToken) {
      await tx
        .update(workflowEvents)
        .set({ status: "failed", completedAt: now, error: reason })
        .where(
          eq(
            workflowEvents.idempotencyKey,
            `send:${updated.id}:attempt:${current.sendAttemptToken}`,
          ),
        );
    }
    await tx
      .insert(workflowEvents)
      .values({
        entityType: "message",
        entityId: updated.id,
        event: "message.delivery_uncertain",
        workflowName: "send_message",
        idempotencyKey: `send:${updated.id}:uncertain:${current.sendAttemptToken ?? "recovered"}`,
        status: "failed",
        completedAt: now,
        error: reason,
        payload: { manualReviewRequired: true, reason: transitionReason },
      })
      .onConflictDoNothing();
    return updated;
  });
}

async function releaseUnattemptedClaim(
  db: AppDatabase,
  messageId: string,
  claimToken: string,
): Promise<void> {
  await db
    .update(messages)
    .set({ status: "drafted", sendAttemptToken: null, sendClaimedAt: null })
    .where(
      and(
        eq(messages.id, messageId),
        eq(messages.sendAttemptToken, claimToken),
        eq(messages.attemptCount, 0),
      ),
    );
}

async function reconcileProvider(
  provider: MailProvider,
  message: Message,
  timeoutMs: number,
): Promise<MailReconciliation> {
  return providerOperation(timeoutMs, (signal) =>
    provider.reconcile({
      outreachId: message.outreachId!,
      draftId: message.providerDraftId,
      mailboxId: message.mailboxId,
      signal,
    }),
  );
}

type Transaction = Parameters<Parameters<AppDatabase["transaction"]>[0]>[0];

async function evaluateStoredSendPolicy(
  tx: Transaction,
  provider: MailProvider,
  messageId: string,
  now: Date,
): Promise<
  | { kind: "not_found" }
  | { kind: "evaluated"; result: ReturnType<typeof evaluateSendPolicy> }
> {
  const [context] = await tx
    .select({
      message: messages,
      campaignId: campaigns.id,
      campaignStatus: campaigns.status,
      configuration: campaignVersions.configuration,
      enrollmentState: enrollments.state,
      enrollmentCurrentStep: enrollments.currentStep,
      enrollmentStopReason: enrollments.stopReason,
      inboundHoldCount: enrollments.inboundHoldCount,
      lastReplyClassification: enrollments.lastReplyClassification,
      contactId: enrollments.contactId,
      mailboxId: enrollments.mailboxId,
      mailboxProvider: mailboxConnections.provider,
      mailboxStatus: mailboxConnections.status,
      professionalRelevance: contacts.professionalRelevance,
      currentContactAccountId: contacts.accountId,
      currentEmploymentVersion: contacts.employmentVersion,
      emailResolutionStatus: contacts.emailResolutionStatus,
      settings: operatorSendingSettings,
    })
    .from(messages)
    .innerJoin(enrollments, eq(enrollments.id, messages.enrollmentId))
    .innerJoin(campaigns, eq(campaigns.id, enrollments.campaignId))
    .innerJoin(
      campaignVersions,
      eq(campaignVersions.id, enrollments.campaignVersionId),
    )
    .innerJoin(contacts, eq(contacts.id, enrollments.contactId))
    .leftJoin(
      mailboxConnections,
      eq(mailboxConnections.id, enrollments.mailboxId),
    )
    .innerJoin(operatorSendingSettings, eq(operatorSendingSettings.id, 1))
    .where(eq(messages.id, messageId))
    .limit(1);
  if (!context) return { kind: "not_found" };

  if (
    context.message.contactAccountId !== null &&
    (context.message.contactAccountId !== context.currentContactAccountId ||
      context.message.employmentVersion !== context.currentEmploymentVersion)
  ) {
    return {
      kind: "evaluated",
      result: { ok: false, code: "ENROLLMENT_INACTIVE" },
    };
  }
  if (context.emailResolutionStatus === "resolved") {
    const [acceptedRecipient] = await tx
      .select({ id: emailCandidates.id })
      .from(emailCandidates)
      .where(
        and(
          eq(emailCandidates.contactId, context.contactId),
          eq(emailCandidates.normalizedEmail, context.message.recipient),
          eq(emailCandidates.status, "accepted"),
        ),
      )
      .limit(1);
    if (!acceptedRecipient) {
      return {
        kind: "evaluated",
        result: { ok: false, code: "ENROLLMENT_INACTIVE" },
      };
    }
  }

  const bindingCode = providerBindingCode(provider, {
    id: context.mailboxId,
    provider: context.mailboxProvider,
    status: context.mailboxStatus,
  });
  if (bindingCode) {
    return { kind: "evaluated", result: { ok: false, code: bindingCode } };
  }

  const domain = context.message.recipient.split("@")[1] ?? "";
  const suppressed = await tx
    .select({ scope: suppressionEntries.scope })
    .from(suppressionEntries)
    .where(
      or(
        and(
          eq(suppressionEntries.scope, "email"),
          eq(suppressionEntries.normalizedValue, context.message.recipient),
        ),
        and(
          eq(suppressionEntries.scope, "domain"),
          eq(suppressionEntries.normalizedValue, domain),
        ),
      ),
    );
  const [alreadySent] = await tx
    .select({ id: messages.id })
    .from(messages)
    .where(
      and(
        eq(messages.enrollmentId, context.message.enrollmentId),
        eq(messages.stepIndex, context.message.stepIndex!),
        eq(messages.direction, "outbound"),
        eq(messages.status, "sent"),
        ne(messages.id, context.message.id),
      ),
    )
    .limit(1);
  let graphInboundPending = false;
  if (context.mailboxId && context.mailboxProvider === "microsoft_graph") {
    const [pendingReceipt] = await tx
      .select({ id: graphNotificationReceipts.id })
      .from(graphNotificationReceipts)
      .where(
        and(
          eq(graphNotificationReceipts.mailboxId, context.mailboxId),
          or(
            sql`${graphNotificationReceipts.processedAt} is null`,
            and(
              eq(graphNotificationReceipts.requiresReview, true),
              sql`${graphNotificationReceipts.reviewResolvedAt} is null`,
            ),
          ),
        ),
      )
      .limit(1);
    const [pendingRecovery] = await tx
      .select({ id: workflowEvents.id })
      .from(workflowEvents)
      .where(
        and(
          eq(workflowEvents.entityType, "mailbox"),
          eq(workflowEvents.entityId, context.mailboxId),
          inArray(workflowEvents.workflowName, [
            "graph_lifecycle_reconciliation",
            "graph_delta_health",
          ]),
          sql`${workflowEvents.status} <> 'succeeded'`,
        ),
      )
      .limit(1);
    graphInboundPending = Boolean(pendingReceipt || pendingRecovery);
  }

  const settings = context.settings;
  const dailyWindowStart = gte(
    messages.sentAt,
    new Date(now.getTime() - 24 * 60 * 60_000),
  );
  const dailyAttemptWindowStart = gte(
    messages.sendAttemptedAt,
    new Date(now.getTime() - 24 * 60 * 60_000),
  );
  const [{ count: campaignDailySent = 0 } = { count: 0 }] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(messages)
    .innerJoin(enrollments, eq(enrollments.id, messages.enrollmentId))
    .where(
      and(
        eq(messages.direction, "outbound"),
        eq(enrollments.campaignId, context.campaignId),
        or(dailyWindowStart, dailyAttemptWindowStart),
      ),
    );
  let mailboxDailySent = 0;
  let latestMailboxSend: Date | null = null;
  if (context.mailboxId) {
    [{ count: mailboxDailySent = 0 } = { count: 0 }] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(messages)
      .innerJoin(enrollments, eq(enrollments.id, messages.enrollmentId))
      .where(
        and(
          eq(messages.direction, "outbound"),
          eq(enrollments.mailboxId, context.mailboxId),
          or(dailyWindowStart, dailyAttemptWindowStart),
        ),
      );
    const [latest] = await tx
      .select({ sentAt: messages.sentAt })
      .from(messages)
      .innerJoin(enrollments, eq(enrollments.id, messages.enrollmentId))
      .where(
        and(
          eq(messages.direction, "outbound"),
          eq(messages.status, "sent"),
          eq(enrollments.mailboxId, context.mailboxId),
          isNotNull(messages.sentAt),
        ),
      )
      .orderBy(desc(messages.sentAt))
      .limit(1);
    const [latestAttempt] = await tx
      .select({ attemptedAt: messages.sendAttemptedAt })
      .from(messages)
      .innerJoin(enrollments, eq(enrollments.id, messages.enrollmentId))
      .where(
        and(
          eq(messages.direction, "outbound"),
          eq(enrollments.mailboxId, context.mailboxId),
          isNotNull(messages.sendAttemptedAt),
          ne(messages.id, context.message.id),
        ),
      )
      .orderBy(desc(messages.sendAttemptedAt))
      .limit(1);
    const mailboxActivity = [latest?.sentAt, latestAttempt?.attemptedAt].filter(
      (value): value is Date => value instanceof Date,
    );
    latestMailboxSend = mailboxActivity.length
      ? new Date(Math.max(...mailboxActivity.map((value) => value.getTime())))
      : null;
  }
  const [latestContact] = await tx
    .select({ sentAt: messages.sentAt, campaignId: enrollments.campaignId })
    .from(messages)
    .innerJoin(enrollments, eq(enrollments.id, messages.enrollmentId))
    .where(
      and(
        eq(messages.direction, "outbound"),
        eq(messages.status, "sent"),
        eq(enrollments.contactId, context.contactId),
        isNotNull(messages.sentAt),
      ),
    )
    .orderBy(desc(messages.sentAt))
    .limit(1);
  const [latestContactAttempt] = await tx
    .select({
      attemptedAt: messages.sendAttemptedAt,
      campaignId: enrollments.campaignId,
    })
    .from(messages)
    .innerJoin(enrollments, eq(enrollments.id, messages.enrollmentId))
    .where(
      and(
        eq(messages.direction, "outbound"),
        eq(enrollments.contactId, context.contactId),
        isNotNull(messages.sendAttemptedAt),
        ne(messages.id, context.message.id),
      ),
    )
    .orderBy(desc(messages.sendAttemptedAt))
    .limit(1);
  const latestContactActivity = [
    latestContact?.sentAt,
    latestContactAttempt?.attemptedAt,
  ].filter((value): value is Date => value instanceof Date);
  const latestContactActivityAt = latestContactActivity.length
    ? new Date(
        Math.max(...latestContactActivity.map((value) => value.getTime())),
      )
    : null;
  const [otherCampaignSend] = await tx
    .select({ sentAt: messages.sentAt })
    .from(messages)
    .innerJoin(enrollments, eq(enrollments.id, messages.enrollmentId))
    .where(
      and(
        eq(messages.direction, "outbound"),
        eq(messages.status, "sent"),
        eq(enrollments.contactId, context.contactId),
        ne(enrollments.campaignId, context.campaignId),
        isNotNull(messages.sentAt),
      ),
    )
    .orderBy(desc(messages.sentAt))
    .limit(1);
  const [otherCampaignAttempt] = await tx
    .select({ attemptedAt: messages.sendAttemptedAt })
    .from(messages)
    .innerJoin(enrollments, eq(enrollments.id, messages.enrollmentId))
    .where(
      and(
        eq(messages.direction, "outbound"),
        eq(enrollments.contactId, context.contactId),
        ne(enrollments.campaignId, context.campaignId),
        isNotNull(messages.sendAttemptedAt),
        ne(messages.id, context.message.id),
      ),
    )
    .orderBy(desc(messages.sendAttemptedAt))
    .limit(1);
  const otherCampaignActivity = [
    otherCampaignSend?.sentAt,
    otherCampaignAttempt?.attemptedAt,
  ].filter((value): value is Date => value instanceof Date);
  const latestOtherCampaignActivityAt = otherCampaignActivity.length
    ? new Date(
        Math.max(...otherCampaignActivity.map((value) => value.getTime())),
      )
    : null;
  const elapsed = (value: Date | null | undefined) =>
    value ? now.getTime() - value.getTime() : Number.POSITIVE_INFINITY;
  const configuration = context.configuration as {
    campaignDailyCap?: number;
    requireProfessionalRelevance?: boolean;
  };
  const relevance = context.professionalRelevance as {
    relevant?: unknown;
  } | null;
  return {
    kind: "evaluated",
    result: evaluateSendPolicy({
      campaignStatus: context.campaignStatus,
      enrollmentState: context.enrollmentState,
      messageStatus: context.message.status,
      terminalReply: ["positive", "negative", "question", "referral"].includes(
        context.lastReplyClassification ?? "",
      ),
      unsubscribed:
        context.enrollmentState === "opted_out" ||
        context.enrollmentStopReason === "unsubscribe",
      hardBounced:
        context.enrollmentState === "bounced" ||
        context.enrollmentStopReason === "hard_bounce",
      manuallyStopped: context.enrollmentStopReason === "manual_stop",
      recipientSuppressed: suppressed.some((entry) => entry.scope === "email"),
      accountDomainSuppressed: suppressed.some(
        (entry) => entry.scope === "domain",
      ),
      mailboxRequired: context.mailboxId !== null,
      mailboxStatus: context.mailboxStatus,
      providerMatches: true,
      stepAlreadySent: Boolean(alreadySent),
      expectedStepMatches:
        context.enrollmentCurrentStep === context.message.stepIndex,
      emergencyPaused: settings.emergencyPause,
      withinWorkingHours: isWithinWorkingHours(now, settings),
      mailboxDailySent,
      mailboxDailyCap: settings.mailboxDailyCap,
      campaignDailySent,
      campaignDailyCap:
        configuration.campaignDailyCap ?? settings.campaignDailyCap,
      mailboxMinimumDelaySatisfied:
        elapsed(latestMailboxSend) >=
        settings.mailboxMinimumDelaySeconds * 1_000,
      contactMinimumDelaySatisfied:
        elapsed(latestContactActivityAt) >=
        settings.contactMinimumDelayMinutes * 60_000,
      recentContactCooldownSatisfied:
        elapsed(latestOtherCampaignActivityAt) >=
        settings.crossCampaignCooldownDays * 86_400_000,
      professionalRelevanceRequired:
        configuration.requireProfessionalRelevance === true,
      professionallyRelevant: relevance?.relevant === true,
      replyPending: context.inboundHoldCount > 0 || graphInboundPending,
    }),
  };
}

export async function sendApprovedMessage(
  db: AppDatabase,
  provider: MailProvider,
  rawInput: unknown,
  options: SendServiceOptions = {},
): Promise<SendMessageResult> {
  const parsed = inputSchema.safeParse(rawInput);
  if (!parsed.success) {
    return { ok: false, code: "INVALID_INPUT", message: "Invalid send input" };
  }
  const messageId = parsed.data.messageId;
  const clock = options.clock ?? (() => new Date());
  const claimStaleAfterMs = options.claimStaleAfterMs ?? 5 * 60_000;
  const providerTimeoutMs = options.providerOperationTimeoutMs ?? 10_000;
  const now = clock();

  try {
    const claimToken = randomUUID();
    const claimed = await db.transaction(async (tx) => {
      await tx.execute(
        sql`select id from messages where id = ${messageId} for update`,
      );
      const [context] = await tx
        .select({
          message: messages,
          campaignStatus: campaigns.status,
          enrollmentState: enrollments.state,
          mailboxId: enrollments.mailboxId,
          mailboxEmail: mailboxConnections.email,
          mailboxProvider: mailboxConnections.provider,
          mailboxStatus: mailboxConnections.status,
          workflowClaimId: enrollments.workflowClaimId,
        })
        .from(messages)
        .innerJoin(enrollments, eq(enrollments.id, messages.enrollmentId))
        .innerJoin(campaigns, eq(campaigns.id, enrollments.campaignId))
        .leftJoin(
          mailboxConnections,
          eq(mailboxConnections.id, enrollments.mailboxId),
        )
        .where(eq(messages.id, messageId))
        .limit(1);
      if (!context) return { kind: "not_found" } as const;
      if (
        options.workflowClaimId &&
        context.workflowClaimId !== options.workflowClaimId
      ) {
        return { kind: "not_owner" } as const;
      }
      if (context.message.status === "sent") {
        return { kind: "sent", message: context.message } as const;
      }

      if (
        context.message.status === "draft_creating" ||
        context.message.status === "sending" ||
        context.message.status === "delivery_uncertain" ||
        context.message.attemptCount > 0 ||
        context.message.sendAttemptToken
      ) {
        const identityCode = providerBindingCode(
          provider,
          {
            id: context.mailboxId,
            provider: context.mailboxProvider,
            status: context.mailboxStatus,
          },
          false,
        );
        if (identityCode) {
          return { kind: "blocked", code: identityCode } as const;
        }
        return { kind: "existing_claim", message: context.message } as const;
      }

      const storedPolicy = await evaluateStoredSendPolicy(
        tx,
        provider,
        messageId,
        now,
      );
      if (storedPolicy.kind === "not_found")
        return { kind: "not_found" } as const;
      if (!storedPolicy.result.ok) {
        return { kind: "blocked", code: storedPolicy.result.code } as const;
      }

      const nextStatus = context.message.providerDraftId
        ? "sending"
        : "draft_creating";
      const [updated] = await tx
        .update(messages)
        .set({
          status: nextStatus,
          sendAttemptToken: claimToken,
          sendClaimedAt: now,
        })
        .where(eq(messages.id, messageId))
        .returning();
      if (!updated) throw new Error("Send claim returned no row");
      await tx.insert(stateTransitions).values({
        entityType: "message",
        entityId: updated.id,
        fromState: context.message.status,
        toState: nextStatus,
        reason:
          nextStatus === "draft_creating"
            ? "durable_draft_claim_acquired"
            : "durable_send_claim_acquired",
      });
      await tx.insert(workflowEvents).values({
        entityType: "message",
        entityId: updated.id,
        event:
          nextStatus === "draft_creating"
            ? "message.draft_claimed"
            : "message.send_claimed",
        workflowName: "send_message",
        idempotencyKey: `send:${updated.id}:claim:${claimToken}`,
        status: "succeeded",
        completedAt: now,
        payload: { claimToken },
      });
      return {
        kind: "owner",
        message: updated,
        mailboxEmail: context.mailboxEmail,
        mailboxId: context.mailboxId,
      } as const;
    });

    if (claimed.kind === "not_found") {
      return { ok: false, code: "NOT_FOUND", message: "Message not found" };
    }
    if (claimed.kind === "not_owner") {
      return { ok: false, code: "IN_PROGRESS" };
    }
    if (claimed.kind === "sent") {
      return {
        ok: true,
        disposition: "already_sent",
        message: claimed.message,
      };
    }
    if (claimed.kind === "blocked") {
      await recordBlocked(db, messageId, claimed.code, now);
      return { ok: false, code: claimed.code };
    }

    if (claimed.kind === "existing_claim") {
      const claimedAt = claimed.message.sendClaimedAt?.getTime();
      const stale =
        claimedAt !== undefined &&
        now.getTime() - claimedAt >= claimStaleAfterMs;
      let reconciliation: MailReconciliation;
      try {
        reconciliation = await reconcileProvider(
          provider,
          claimed.message,
          providerTimeoutMs,
        );
      } catch {
        if (claimed.message.attemptCount > 0) {
          await markDeliveryUncertain(
            db,
            messageId,
            "Persisted send attempt requires manual reconciliation",
            "provider_reconciliation_failed_after_send_attempt",
            now,
          );
          return { ok: false, code: "DELIVERY_UNCERTAIN" };
        }
        if (claimed.message.status === "delivery_uncertain") {
          await recordProviderFailure(
            db,
            messageId,
            "reconcile",
            claimed.message.sendAttemptToken,
            now,
            false,
          );
          return { ok: false, code: "DELIVERY_UNCERTAIN" };
        }
        if (stale) {
          await markDeliveryUncertain(
            db,
            messageId,
            "Stale send claim requires manual reconciliation",
            "stale_claim_provider_outcome_unresolved",
            now,
          );
          await recordProviderFailure(
            db,
            messageId,
            "reconcile",
            claimed.message.sendAttemptToken,
            now,
            false,
          );
          return { ok: false, code: "DELIVERY_UNCERTAIN" };
        }
        await recordProviderFailure(
          db,
          messageId,
          "reconcile",
          claimed.message.sendAttemptToken,
          now,
          false,
        );
        return { ok: false, code: "PROVIDER_ERROR" };
      }
      if (reconciliation?.status === "sent") {
        const finalized = await finalizeSent(
          db,
          messageId,
          reconciliation,
          reconciliation.draftId,
          clock(),
        );
        return finalized
          ? { ok: true, disposition: "sent", message: finalized }
          : { ok: false, code: "DATABASE_ERROR" };
      }
      if (reconciliation?.status === "accepted") {
        if (!claimed.message.providerDraftId) {
          await db
            .update(messages)
            .set({ providerDraftId: reconciliation.draftId })
            .where(eq(messages.id, messageId));
        }
        await markDeliveryUncertain(
          db,
          messageId,
          claimed.message.providerDraftId
            ? "Provider acceptance is not confirmed"
            : "Provider acceptance discovered during reconciliation",
          claimed.message.providerDraftId
            ? "provider_acceptance_unconfirmed"
            : "provider_acceptance_discovered_by_reconciliation",
          now,
        );
        return { ok: false, code: "DELIVERY_UNCERTAIN" };
      }

      if (claimed.message.status === "delivery_uncertain") {
        return { ok: false, code: "DELIVERY_UNCERTAIN" };
      }

      if (!stale) {
        return { ok: false, code: "IN_PROGRESS" };
      }
      if (claimed.message.attemptCount > 0) {
        await markDeliveryUncertain(
          db,
          messageId,
          "Stale persisted send attempt requires manual reconciliation",
          "stale_persisted_send_attempt",
          now,
        );
        return { ok: false, code: "DELIVERY_UNCERTAIN" };
      }

      const releasedStatus =
        reconciliation?.status === "drafted" || claimed.message.providerDraftId
          ? "drafted"
          : "approved";
      await db.transaction(async (tx) => {
        await tx.execute(
          sql`select id from messages where id = ${messageId} for update`,
        );
        const [current] = await tx
          .select()
          .from(messages)
          .where(eq(messages.id, messageId))
          .limit(1);
        if (
          !current ||
          current.sendAttemptToken !== claimed.message.sendAttemptToken ||
          current.attemptCount !== 0
        ) {
          return;
        }
        await tx
          .update(messages)
          .set({
            status: releasedStatus,
            providerDraftId:
              reconciliation?.status === "drafted"
                ? reconciliation.draftId
                : current.providerDraftId,
            sendAttemptToken: null,
            sendClaimedAt: null,
          })
          .where(eq(messages.id, messageId));
        const reason =
          releasedStatus === "drafted"
            ? "stale_claim_released_after_draft_reconciliation"
            : "stale_draft_claim_released_after_null_reconciliation";
        await tx.insert(stateTransitions).values({
          entityType: "message",
          entityId: messageId,
          fromState: current.status,
          toState: releasedStatus,
          reason,
        });
        await tx
          .insert(workflowEvents)
          .values({
            entityType: "message",
            entityId: messageId,
            event: "message.stale_claim_released",
            workflowName: "send_message",
            idempotencyKey: `send:${messageId}:stale_release:${current.sendAttemptToken}`,
            status: "succeeded",
            completedAt: now,
            payload: { reason },
          })
          .onConflictDoNothing();
      });
      return { ok: false, code: "IN_PROGRESS" };
    }

    let ownerMessage = claimed.message;
    if (ownerMessage.status === "draft_creating") {
      let reconciliation: MailReconciliation;
      try {
        reconciliation = await reconcileProvider(
          provider,
          ownerMessage,
          providerTimeoutMs,
        );
      } catch {
        await recordProviderFailure(
          db,
          messageId,
          "reconcile",
          claimToken,
          now,
        );
        return { ok: false, code: "PROVIDER_ERROR" };
      }
      if (reconciliation?.status === "sent") {
        const finalized = await finalizeSent(
          db,
          messageId,
          reconciliation,
          reconciliation.draftId,
          clock(),
        );
        return finalized
          ? { ok: true, disposition: "sent", message: finalized }
          : { ok: false, code: "DATABASE_ERROR" };
      }
      if (reconciliation?.status === "accepted") {
        await db
          .update(messages)
          .set({ providerDraftId: reconciliation.draftId })
          .where(eq(messages.id, messageId));
        await markDeliveryUncertain(
          db,
          messageId,
          "Provider acceptance discovered during reconciliation",
          "provider_acceptance_discovered_by_reconciliation",
          now,
        );
        return { ok: false, code: "DELIVERY_UNCERTAIN" };
      }

      let draftId: string;
      if (reconciliation?.status === "drafted") {
        draftId = reconciliation.draftId;
      } else {
        try {
          const draft = await providerOperation(providerTimeoutMs, (signal) =>
            provider.createDraft({
              outreachId: ownerMessage.outreachId!,
              mailboxId: claimed.mailboxId,
              sender: claimed.mailboxEmail,
              recipient: ownerMessage.recipient,
              subject: ownerMessage.subject,
              body: ownerMessage.body,
              headers: {
                ...ownerMessage.headers,
                "X-Outreach-ID": ownerMessage.outreachId!,
              },
              signal,
            }),
          );
          draftId = draft.draftId;
        } catch {
          await recordProviderFailure(
            db,
            messageId,
            "create_draft",
            claimToken,
            now,
          );
          return { ok: false, code: "PROVIDER_ERROR" };
        }
      }

      const persisted = await db.transaction(async (tx) => {
        await tx.execute(
          sql`select id from messages where id = ${messageId} for update`,
        );
        const [current] = await tx
          .select()
          .from(messages)
          .where(eq(messages.id, messageId))
          .limit(1);
        if (
          !current ||
          current.status !== "draft_creating" ||
          current.sendAttemptToken !== claimToken
        ) {
          return null;
        }
        const [updated] = await tx
          .update(messages)
          .set({
            providerDraftId: draftId,
            status: "sending",
            draftedAt: now,
          })
          .where(eq(messages.id, messageId))
          .returning();
        await tx.insert(stateTransitions).values([
          {
            entityType: "message",
            entityId: messageId,
            fromState: "draft_creating",
            toState: "drafted",
            reason: "provider_draft_persisted",
          },
          {
            entityType: "message",
            entityId: messageId,
            fromState: "drafted",
            toState: "sending",
            reason: "durable_send_claim_acquired",
          },
        ]);
        await tx
          .insert(workflowEvents)
          .values({
            entityType: "message",
            entityId: messageId,
            event: "message.drafted",
            workflowName: "send_message",
            idempotencyKey: `send:${messageId}:drafted`,
            status: "succeeded",
            completedAt: now,
            payload: { providerDraftId: draftId },
          })
          .onConflictDoNothing();
        return updated;
      });
      if (!persisted) return { ok: false, code: "IN_PROGRESS" };
      ownerMessage = persisted;
    }

    let ownerReconciliation: MailReconciliation;
    try {
      ownerReconciliation = await reconcileProvider(
        provider,
        ownerMessage,
        providerTimeoutMs,
      );
    } catch {
      await recordProviderFailure(db, messageId, "reconcile", claimToken, now);
      return { ok: false, code: "PROVIDER_ERROR" };
    }
    if (ownerReconciliation?.status === "sent") {
      const finalized = await finalizeSent(
        db,
        messageId,
        ownerReconciliation,
        ownerReconciliation.draftId,
        clock(),
      );
      return finalized
        ? { ok: true, disposition: "sent", message: finalized }
        : { ok: false, code: "DATABASE_ERROR" };
    }
    if (ownerReconciliation?.status === "accepted") {
      await markDeliveryUncertain(
        db,
        messageId,
        "Provider acceptance is not confirmed",
        "provider_acceptance_unconfirmed",
        now,
      );
      return { ok: false, code: "DELIVERY_UNCERTAIN" };
    }

    const [actionContext] = await db
      .select({
        enrollmentId: enrollments.id,
        campaignId: enrollments.campaignId,
        mailboxId: enrollments.mailboxId,
        recipient: messages.recipient,
        contactId: enrollments.contactId,
      })
      .from(messages)
      .innerJoin(enrollments, eq(enrollments.id, messages.enrollmentId))
      .where(eq(messages.id, messageId))
      .limit(1);
    if (!actionContext) {
      return { ok: false, code: "NOT_FOUND", message: "Message not found" };
    }
    const domain = actionContext.recipient.split("@")[1] ?? "";
    let lockedAttempt;
    try {
      lockedAttempt = await withActionLocks(
        db,
        [
          actionLockKey.settings(),
          actionLockKey.campaign(actionContext.campaignId),
          actionLockKey.enrollment(actionContext.enrollmentId),
          actionLockKey.contact(actionContext.contactId),
          actionLockKey.mailbox(actionContext.mailboxId),
          actionLockKey.recipient(actionContext.recipient),
          actionLockKey.domain(domain),
        ],
        async (lockedDb) => {
          const finalNow = clock();
          // This transaction is deliberately the last awaited operation before
          // sendDraft. It rechecks policy and durably reserves the send attempt.
          const finalPolicy = await lockedDb.transaction(async (tx) => {
            await tx.execute(
              sql`select id from messages where id = ${messageId} for update`,
            );
            const [context] = await tx
              .select({ message: messages })
              .from(messages)
              .where(eq(messages.id, messageId))
              .limit(1);
            if (!context) return { kind: "not_found" } as const;
            if (options.workflowClaimId) {
              const [owner] = await tx
                .select({ workflowClaimId: enrollments.workflowClaimId })
                .from(enrollments)
                .where(eq(enrollments.id, context.message.enrollmentId))
                .limit(1);
              if (owner?.workflowClaimId !== options.workflowClaimId) {
                return { kind: "not_owner" } as const;
              }
            }
            if (
              context.message.status !== "sending" ||
              context.message.sendAttemptToken !== claimToken ||
              context.message.attemptCount !== 0
            ) {
              return { kind: "not_owner" } as const;
            }
            const storedPolicy = await evaluateStoredSendPolicy(
              tx,
              provider,
              messageId,
              finalNow,
            );
            if (storedPolicy.kind === "not_found")
              return { kind: "not_found" } as const;
            const blockCode = storedPolicy.result.ok
              ? null
              : storedPolicy.result.code;
            if (blockCode) {
              await tx
                .update(messages)
                .set({
                  status: "drafted",
                  sendAttemptToken: null,
                  sendClaimedAt: null,
                })
                .where(eq(messages.id, messageId));
              await tx.insert(stateTransitions).values({
                entityType: "message",
                entityId: messageId,
                fromState: "sending",
                toState: "drafted",
                reason: `final_policy_blocked:${blockCode}`,
              });
              return { kind: "blocked", code: blockCode } as const;
            }
            const [attempted] = await tx
              .update(messages)
              .set({ attemptCount: 1, sendAttemptedAt: finalNow })
              .where(eq(messages.id, messageId))
              .returning();
            await tx.insert(workflowEvents).values({
              entityType: "message",
              entityId: messageId,
              event: "message.sending",
              workflowName: "send_message",
              idempotencyKey: `send:${messageId}:attempt:${claimToken}`,
              status: "started",
              startedAt: finalNow,
              payload: { claimToken, attempt: attempted!.attemptCount },
            });
            return { kind: "attempt", message: attempted! } as const;
          });
          if (finalPolicy.kind !== "attempt") {
            return {
              finalPolicy,
              providerThrew: false,
              confirmation: null,
              finalized: null,
            };
          }
          let providerThrew = false;
          try {
            await providerOperation(providerTimeoutMs, (signal) =>
              provider.sendDraft({
                draftId: finalPolicy.message.providerDraftId!,
                outreachId: finalPolicy.message.outreachId!,
                mailboxId: finalPolicy.message.mailboxId,
                signal,
              }),
            );
          } catch {
            providerThrew = true;
          }
          let confirmation: MailReconciliation = null;
          try {
            confirmation = await reconcileProvider(
              provider,
              finalPolicy.message,
              providerTimeoutMs,
            );
          } catch {
            // The attempt is durable, so transport uncertainty is handled after
            // the action locks are safely released.
          }
          const finalized =
            confirmation?.status === "sent"
              ? await finalizeSent(
                  lockedDb,
                  messageId,
                  confirmation,
                  confirmation.draftId,
                  clock(),
                )
              : null;
          return { finalPolicy, providerThrew, confirmation, finalized };
        },
        {
          globalAttempts: options.globalLockAttempts,
          globalRetryDelayMs: options.globalLockRetryDelayMs,
        },
      );
    } catch (error) {
      if (isActionLockBusy(error)) {
        await releaseUnattemptedClaim(db, messageId, claimToken);
        return { ok: false, code: "IN_PROGRESS" };
      }
      throw error;
    }
    const { finalPolicy, providerThrew, confirmation, finalized } =
      lockedAttempt;

    if (finalPolicy.kind === "not_found") {
      return { ok: false, code: "NOT_FOUND", message: "Message not found" };
    }
    if (finalPolicy.kind === "not_owner") {
      return { ok: false, code: "IN_PROGRESS" };
    }
    if (finalPolicy.kind === "blocked") {
      await recordBlocked(db, messageId, finalPolicy.code, now);
      return { ok: false, code: finalPolicy.code };
    }

    if (confirmation?.status === "sent") {
      return finalized
        ? { ok: true, disposition: "sent", message: finalized }
        : { ok: false, code: "DATABASE_ERROR" };
    }
    await markDeliveryUncertain(
      db,
      messageId,
      providerThrew
        ? "Mail provider failed after send attempt"
        : "Provider acceptance is not confirmed",
      providerThrew
        ? "provider_failed_after_send_attempt"
        : "provider_acceptance_unconfirmed",
      now,
    );
    return { ok: false, code: "DELIVERY_UNCERTAIN" };
  } catch {
    return {
      ok: false,
      code: "DATABASE_ERROR",
      message: "Could not send message",
    };
  }
}

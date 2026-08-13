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
  MailProviderKind,
  MailReconciliation,
  SentMail,
} from "@/modules/mailboxes/mail-provider";
import { isTerminalEnrollmentState } from "@/modules/campaigns/enrollment-state";
import { DEFAULT_INBOUND_WORKFLOW_NAME } from "@/modules/mailboxes/inbound-reconciliation";
import { GRAPH_DELTA_HEALTH_WORKFLOW_NAME } from "@/modules/mailboxes/microsoft-graph-inbound-naming";
import { markMailboxAuthenticationFailed } from "@/modules/mailboxes/lifecycle-service";
import { evaluateSendPolicy } from "@/modules/messages/send-policy";
import type { SendPolicyBlockCode } from "@/modules/messages/send-policy";
import { isWithinWorkingHours } from "@/modules/settings/service";
import { insertSuppressionInTransaction } from "@/modules/suppression/service";
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
        | "PERMANENT_REJECTION"
        | "PROVIDER_ERROR"
        | "DATABASE_ERROR";
      message?: string;
    };

type BlockCode = SendPolicyBlockCode | "MAILBOX_PROVIDER_MISMATCH";

/**
 * Best-effort, provider-agnostic description of a thrown `provider.sendDraft`
 * error, for the operator-visible `messages.lastError` column. Duck-typed on
 * a `responseCode` field rather than importing any concrete provider's error
 * class (`SmtpRejectionError` and friends live in provider-specific modules
 * this generic, multi-provider file must never depend on — see
 * `MailProvider`'s own abstraction boundary). Microsoft Graph's errors carry
 * none of these fields and fall straight through to `undefined`, so this
 * never changes Graph's behavior; only `smtp_imap`'s rejections currently
 * populate it. Returns `undefined` when nothing more specific than "the
 * provider call failed" is available — the caller falls back to that
 * generic message unchanged.
 */
function describeProviderError(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined;
  const withCode = error as Error & {
    responseCode?: unknown;
    response?: unknown;
  };
  if (typeof withCode.responseCode !== "number") return undefined;
  const detail =
    typeof withCode.response === "string" ? withCode.response : error.message;
  return `Mail provider failed after send attempt: SMTP ${withCode.responseCode} — ${detail}`;
}

/**
 * Same duck-typing doctrine as `describeProviderError`: checks for
 * `smtpErrorCode === "EAUTH"` structurally rather than importing
 * `SmtpRejectionError` (a `smtp_imap`-specific class) — this file stays
 * provider-agnostic, and Microsoft Graph's errors, which never carry this
 * field, always evaluate to `false` here and are completely unaffected.
 * A `true` result is *the* signal that a stored credential — not this
 * particular message — is the problem: authentication happens before
 * `MAIL FROM`, so nothing about the message content or recipient caused
 * this failure, and letting the caller keep retrying the same login on the
 * next recovery tick punishes the mailbox exactly as design doc §8 warns
 * against ("réessayés en boucle").
 *
 * Also requires `responseCode >= 500`: `nodemailer` sets `code: 'EAUTH'` for
 * *any* non-2xx AUTH response, including a transient one — a
 * `454 4.7.0 Temporary authentication failure` (Postfix, when its SASL
 * backend is momentarily unreachable) is `EAUTH` too, but says nothing
 * about whether the stored password is correct. Revoking the mailbox on
 * that would misfire on every SASL hiccup. `SmtpRejectionError.responseCode`
 * is always populated for an `EAUTH` rejection (it is a complete numbered
 * server reply, never one of `classifySmtpRejection`'s ambiguous
 * connection-level codes — see that function's own doc comment), so this
 * check never silently passes an `EAUTH` with no code to inspect; it is
 * only ever `false` because the code is genuinely `< 500`. This is a
 * narrower rule than round 1's `releaseAttempt` decision for the *send
 * journal* (`smtp-imap-mail-provider.ts`, which releases the attempt on
 * *any* `EAUTH` regardless of code) — the two questions are different:
 * "is this message safe to resubmit" (round 1, answered generously) versus
 * "is the mailbox's stored credential provably broken" (here, answered
 * conservatively) — and this file does not change the former.
 */
function isSmtpAuthFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const withCode = error as Error & {
    smtpErrorCode?: unknown;
    responseCode?: unknown;
  };
  return (
    withCode.smtpErrorCode === "EAUTH" &&
    typeof withCode.responseCode === "number" &&
    withCode.responseCode >= 500
  );
}

/**
 * The IMAP-side counterpart to `isSmtpAuthFailure`, same duck-typing
 * doctrine: checks `error.name === "ImapAuthenticationError"` — the marker
 * `ImapClient.withConnection` (`imap-client.ts`) wraps a definite `imapflow`
 * auth failure into — rather than importing the concrete class, so this file
 * stays provider-agnostic and Microsoft Graph is unaffected (it never throws
 * this). Named "the first protocol contacted" deliberately: for `smtp_imap`,
 * *every* IMAP operation (`createDraft`'s `appendDraft`, `sendDraft`'s
 * `fetchDraftSource`, `reconcile`'s `findByMessageId`) opens its own fresh
 * connection and authenticates from scratch, so a wrong stored password
 * shows up here at least as often as — usually before — it would on the SMTP
 * side.
 */
function isImapAuthFailure(error: unknown): boolean {
  return error instanceof Error && error.name === "ImapAuthenticationError";
}

/**
 * Shared by every provider-error handler below that has a `mailboxId` on
 * hand: if `error` is a definite SMTP or IMAP authentication failure, revoke
 * the mailbox (design doc §8) so the *next* claim — on this message or any
 * other on the same mailbox — is blocked by `send-policy.ts`'s
 * `MAILBOX_UNAVAILABLE` check before the provider is ever contacted again.
 * A no-op for every other kind of failure (ambiguous, or provider-side but
 * not credential-related) and for Microsoft Graph (neither `isSmtpAuthFailure`
 * nor `isImapAuthFailure` ever return `true` for its errors).
 */
async function revokeMailboxOnAuthFailure(
  db: AppDatabase,
  mailboxId: string | null,
  error: unknown,
): Promise<void> {
  if (!mailboxId) return;
  if (isSmtpAuthFailure(error)) {
    await markMailboxAuthenticationFailed(
      db,
      mailboxId,
      "smtp_authentication_failed",
    );
  } else if (isImapAuthFailure(error)) {
    await markMailboxAuthenticationFailed(
      db,
      mailboxId,
      "imap_authentication_failed",
    );
  }
}

function providerBindingCode(
  provider: MailProvider,
  mailbox: {
    id: string | null;
    provider: MailProviderKind | null;
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
  options: {
    releasePreSendClaim?: boolean;
    /** The error that triggered this call, and the mailbox it happened on
     * — when both are present, `revokeMailboxOnAuthFailure` runs after the
     * transaction below commits (never nested inside it: that function
     * opens its own `db.transaction`, and this one's caller may itself be
     * running inside `withActionLocks`'s reserved session — see its own
     * doc for why it never needs, and must never trigger, a second lock
     * acquisition). Omit either to skip the check entirely, e.g. for a
     * caller with no `mailboxId` in scope. */
    error?: unknown;
    mailboxId?: string | null;
  } = {},
): Promise<void> {
  const releasePreSendClaim = options.releasePreSendClaim ?? true;
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
  if ("mailboxId" in options) {
    await revokeMailboxOnAuthFailure(
      db,
      options.mailboxId ?? null,
      options.error,
    );
  }
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

async function markPermanentlyRejected(
  db: AppDatabase,
  messageId: string,
  rejection: Extract<NonNullable<MailReconciliation>, { status: "rejected" }>,
  now: Date,
): Promise<void> {
  const reason = `SMTP ${rejection.responseCode}${rejection.response ? `: ${rejection.response}` : ""}`;
  await db.transaction(async (tx) => {
    await tx.execute(
      sql`select id from messages where id = ${messageId} for update`,
    );
    const [current] = await tx
      .select()
      .from(messages)
      .where(eq(messages.id, messageId))
      .limit(1);
    if (!current || current.status === "sent" || current.status === "failed")
      return;
    await tx
      .update(messages)
      .set({
        status: "failed",
        lastError: reason,
        sendAttemptToken: null,
        sendClaimedAt: null,
      })
      .where(eq(messages.id, messageId));
    await tx.insert(stateTransitions).values({
      entityType: "message",
      entityId: messageId,
      fromState: current.status,
      toState: "failed",
      reason: "provider_permanent_rejection",
      metadata: { responseCode: rejection.responseCode },
    });
    const [enrollment] = await tx
      .select()
      .from(enrollments)
      .where(eq(enrollments.id, current.enrollmentId))
      .limit(1);
    if (enrollment && !isTerminalEnrollmentState(enrollment.state)) {
      const nextState = rejection.hardBounce ? "bounced" : "manual_review";
      await tx
        .update(enrollments)
        .set({
          state: nextState,
          nextActionAt: null,
          nextActionToken: null,
          workflowClaimId: null,
          workflowClaimedAt: null,
          ...(rejection.hardBounce
            ? { stopReason: "hard_bounce" as const, stoppedAt: now }
            : {}),
        })
        .where(eq(enrollments.id, enrollment.id));
      await tx.insert(stateTransitions).values({
        entityType: "enrollment",
        entityId: enrollment.id,
        fromState: enrollment.state,
        toState: nextState,
        reason: rejection.hardBounce
          ? "hard_bounce"
          : "provider_permanent_rejection",
        metadata: { messageId, responseCode: rejection.responseCode },
      });
      if (rejection.hardBounce) {
        await insertSuppressionInTransaction(tx, {
          scope: "email",
          normalizedValue: current.recipient,
          reason: "hard_bounce",
          actor: "system:smtp",
          notes: reason.slice(0, 2_000),
        });
      }
    }
    if (current.sendAttemptToken) {
      await tx
        .update(workflowEvents)
        .set({ status: "failed", completedAt: now, error: reason })
        .where(
          eq(
            workflowEvents.idempotencyKey,
            `send:${messageId}:attempt:${current.sendAttemptToken}`,
          ),
        );
    }
    await tx
      .insert(workflowEvents)
      .values({
        entityType: "message",
        entityId: messageId,
        event: "message.permanently_rejected",
        workflowName: "send_message",
        idempotencyKey: `send:${messageId}:permanently_rejected`,
        status: "failed",
        completedAt: now,
        error: reason,
        payload: {
          responseCode: rejection.responseCode,
          smtpErrorCode: rejection.smtpErrorCode ?? null,
          hardBounce: rejection.hardBounce,
        },
      })
      .onConflictDoNothing();
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
  let inboundSyncPending = false;
  // Every mailbox-backed provider except `mock` reconciles inbound replies,
  // so every one of them can go silent — checked by exclusion, not by
  // enumerating providers, so a new one is covered without touching this
  // gate.
  if (context.mailboxId && context.mailboxProvider !== "mock") {
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
          // Read back from the modules that *produce* them, not retyped:
          // this array is the only place the gate on a live mailbox can be
          // disarmed by a silent rename. `graph_delta_health` comes from
          // Graph's own constants module and `inbound_reconciliation` from
          // `defaultInboundNaming`, which is what every non-Graph provider's
          // round is registered under (`inbound-source-bootstrap.ts`).
          // `graph_lifecycle_reconciliation` is still a literal: its two
          // producers are Graph services this branch must leave untouched,
          // and a constant only the consumer imports would be a decoration,
          // not a guarantee.
          inArray(workflowEvents.workflowName, [
            "graph_lifecycle_reconciliation",
            GRAPH_DELTA_HEALTH_WORKFLOW_NAME,
            DEFAULT_INBOUND_WORKFLOW_NAME,
          ]),
          sql`${workflowEvents.status} <> 'succeeded'`,
        ),
      )
      .limit(1);
    inboundSyncPending = Boolean(pendingReceipt || pendingRecovery);
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
      replyPending: context.inboundHoldCount > 0 || inboundSyncPending,
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
  // SMTP cannot consume AbortSignal once DATA is in flight. Its transport is
  // bounded to 60s and surrounding IMAP operations to 30s, so keep the outer
  // claim/lock alive longer than that sequence rather than returning while a
  // socket can still submit in the background.
  const providerTimeoutMs =
    options.providerOperationTimeoutMs ??
    (provider.kind === "smtp_imap" ? 150_000 : 10_000);
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
        // Carries the mailbox identity/status forward, not just `message`:
        // the `existing_claim` handler below needs it to gate
        // `reconcileProvider` on availability *before* calling it, without
        // a second query for the same row this transaction already read.
        return {
          kind: "existing_claim",
          message: context.message,
          mailboxId: context.mailboxId,
          mailboxProvider: context.mailboxProvider,
          mailboxStatus: context.mailboxStatus,
        } as const;
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
      // A revoked/disconnected/degraded mailbox must not be contacted for
      // *any* reason, including "just reconciling" — discovering whether a
      // message already went out has no urgency next to an account
      // lockout, and becomes possible again the moment an operator fixes
      // the credentials and reconnects (§8, and task-10-bis fix round 3).
      // Deliberately `requireAvailable: true` here, unlike the `false` used
      // to *classify* into `existing_claim` above: that earlier check only
      // guards provider/mailbox identity (must always hold, availability
      // aside); this one is the new availability gate, checked once more
      // right before the one call this whole task exists to prevent.
      // `providerBindingCode`'s own `!mailbox.id` branch keeps the
      // credential-free `mock` provider path (no mailbox at all) exempt,
      // so this can never fire for those tests.
      const availabilityCode = providerBindingCode(
        provider,
        {
          id: claimed.mailboxId,
          provider: claimed.mailboxProvider,
          status: claimed.mailboxStatus,
        },
        true,
      );
      if (availabilityCode) {
        // No provider call, no message mutation at all -- the message stays
        // exactly as it is (still reclaimable the instant the mailbox comes
        // back), only an audit event records that this attempt was blocked.
        await recordBlocked(db, messageId, availabilityCode, now);
        return { ok: false, code: availabilityCode };
      }

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
      } catch (error) {
        // Reached only once the availability gate above already confirmed
        // the mailbox was `available` moments ago -- so a definite auth
        // failure surfacing *here* is freshly discovered, not something a
        // prior tick already caught. Checked once, ahead of every branch
        // below, since all four want the same reaction.
        await revokeMailboxOnAuthFailure(db, claimed.mailboxId, error);
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
            { releasePreSendClaim: false },
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
            { releasePreSendClaim: false },
          );
          return { ok: false, code: "DELIVERY_UNCERTAIN" };
        }
        await recordProviderFailure(
          db,
          messageId,
          "reconcile",
          claimed.message.sendAttemptToken,
          now,
          { releasePreSendClaim: false },
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
      if (reconciliation?.status === "rejected") {
        await markPermanentlyRejected(db, messageId, reconciliation, now);
        return { ok: false, code: "PERMANENT_REJECTION" };
      }

      if (claimed.message.status === "delivery_uncertain") {
        // A `"drafted"` reconciliation here is *positive proof*, not an
        // absence of proof: for `smtp_imap` it means the local journal has
        // no attempt/acceptance recorded for this outreach at all (the
        // provider released it — see `SmtpRejectionDetails`); for
        // `microsoft_graph` it means the server itself still shows the
        // message sitting in Drafts. Either way the provider is telling us,
        // right now, that nothing went out — unlike `null` (nothing found
        // anywhere, could mean the provider just can't see it) or a thrown
        // reconcile (unknown), which both stay uncertain untouched below.
        // Release the claim so a fresh attempt can actually happen instead
        // of being re-marked uncertain on every recovery tick forever.
        if (reconciliation?.status === "drafted") {
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
              current.status !== "delivery_uncertain" ||
              current.sendAttemptToken !== claimed.message.sendAttemptToken
            ) {
              return;
            }
            await tx
              .update(messages)
              .set({
                status: "drafted",
                providerDraftId: reconciliation.draftId,
                sendAttemptToken: null,
                sendClaimedAt: null,
                // The stale failure banner (`/review`) must not survive a
                // release the provider itself just proved was unwarranted —
                // a message sitting healthily in `drafted` should not still
                // show "Mail provider failed after send attempt".
                lastError: null,
                // Reset, not just left alone: this message very likely
                // already went through one real `attemptCount: 1` submit
                // (that is how it got here) — leaving it at 1 would keep
                // tripping the `existing_claim` classification above and
                // the `attemptCount !== 0` guard on the next claim
                // transaction, trapping the message right back where it
                // started instead of letting a fresh attempt proceed.
                attemptCount: 0,
                // `sendAttemptedAt` is deliberately *not* reset here, unlike
                // `attemptCount`: nothing routes on it for claim eligibility
                // (only `attemptCount`/`status`/`sendAttemptToken` do), so
                // this is not a throttle on *this* message's own next
                // attempt — the three `MAILBOX_MINIMUM_DELAY`/cooldown pacing
                // reads at the top of this file (`isNotNull(...)`, ordered by
                // it) each carry `ne(messages.id, context.message.id)` and so
                // never see this row's own value once it is the one being
                // evaluated. What preserving it *does* still feed: (a) those
                // same pacing reads when evaluating *other* messages on this
                // mailbox/contact, which correctly keep seeing this failed
                // attempt as recent mailbox/contact activity; and (b) the
                // campaign/mailbox 24h daily-cap windows just above
                // (`dailyAttemptWindowStart`), which count every row
                // regardless of id and so keep counting this one — matching
                // "an attempt was made" being true even though it failed.
                // Nulling it would silently erase both.
              })
              .where(eq(messages.id, messageId));
            await tx.insert(stateTransitions).values({
              entityType: "message",
              entityId: messageId,
              fromState: current.status,
              toState: "drafted",
              reason:
                "delivery_uncertain_released_after_drafted_reconciliation",
            });
            await tx
              .insert(workflowEvents)
              .values({
                entityType: "message",
                entityId: messageId,
                event: "message.uncertain_claim_released",
                workflowName: "send_message",
                // Falls back to a fresh `randomUUID()`, not a fixed literal
                // like `"recovered"`, when there is no token: a fixed
                // fallback would let this same idempotency key collide
                // across genuinely distinct release events (a message can
                // legitimately cycle through delivery_uncertain → released
                // more than once), silently absorbing every release after
                // the first into `onConflictDoNothing()`.
                idempotencyKey: `send:${messageId}:uncertain_release:${current.sendAttemptToken ?? randomUUID()}`,
                status: "succeeded",
                completedAt: now,
                payload: { reason: "drafted_reconciliation" },
              })
              .onConflictDoNothing();
          });
          return { ok: false, code: "IN_PROGRESS" };
        }
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
      } catch (error) {
        await recordProviderFailure(
          db,
          messageId,
          "reconcile",
          claimToken,
          now,
          {
            error,
            mailboxId: claimed.mailboxId,
          },
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
      if (reconciliation?.status === "rejected") {
        await markPermanentlyRejected(db, messageId, reconciliation, now);
        return { ok: false, code: "PERMANENT_REJECTION" };
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
        } catch (error) {
          await recordProviderFailure(
            db,
            messageId,
            "create_draft",
            claimToken,
            now,
            {
              error,
              mailboxId: claimed.mailboxId,
            },
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
    } catch (error) {
      await recordProviderFailure(db, messageId, "reconcile", claimToken, now, {
        error,
        mailboxId: claimed.mailboxId,
      });
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
    if (ownerReconciliation?.status === "rejected") {
      await markPermanentlyRejected(db, messageId, ownerReconciliation, now);
      return { ok: false, code: "PERMANENT_REJECTION" };
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
              providerFailureDetail: undefined,
              confirmation: null,
              finalized: null,
            };
          }
          let providerThrew = false;
          let providerFailureDetail: string | undefined;
          try {
            await providerOperation(providerTimeoutMs, (signal) =>
              provider.sendDraft({
                draftId: finalPolicy.message.providerDraftId!,
                outreachId: finalPolicy.message.outreachId!,
                mailboxId: finalPolicy.message.mailboxId,
                signal,
              }),
            );
          } catch (error) {
            providerThrew = true;
            providerFailureDetail = describeProviderError(error);
            // Stops the loop at its source, for either protocol: the *next*
            // claim on this mailbox now fails `send-policy.ts`'s
            // `MAILBOX_UNAVAILABLE` check before ever calling
            // `provider.sendDraft` again — no further SMTP connection or
            // IMAP login (`fetchDraftSource`, called just before `submit`
            // inside `sendDraft`, is itself an IMAP round trip). Uses
            // `lockedDb` (not the outer `db`): this call already holds this
            // mailbox's action lock via the `withActionLocks` this whole
            // block runs inside, and `markMailboxAuthenticationFailed` is
            // written to never re-acquire it (see its own doc).
            await revokeMailboxOnAuthFailure(
              lockedDb,
              finalPolicy.message.mailboxId,
              error,
            );
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
          if (confirmation?.status === "rejected") {
            await markPermanentlyRejected(
              lockedDb,
              messageId,
              confirmation,
              clock(),
            );
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
          return {
            finalPolicy,
            providerThrew,
            providerFailureDetail,
            confirmation,
            finalized,
          };
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
    const {
      finalPolicy,
      providerThrew,
      providerFailureDetail,
      confirmation,
      finalized,
    } = lockedAttempt;

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
    if (confirmation?.status === "rejected") {
      return { ok: false, code: "PERMANENT_REJECTION" };
    }
    await markDeliveryUncertain(
      db,
      messageId,
      providerThrew
        ? (providerFailureDetail ?? "Mail provider failed after send attempt")
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

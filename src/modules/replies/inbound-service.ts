import { createHash, randomUUID } from "node:crypto";

import { and, asc, desc, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { z } from "zod";

import {
  campaignVersions,
  enrollments,
  inboundRecords,
  messages,
  replies,
  stateTransitions,
  workflowEvents,
} from "@/lib/db/schema";
import type { AppDatabase } from "@/lib/db/types";
import { actionLockKey, withActionLocks } from "@/lib/db/action-lock";
import {
  validateReplyClassification,
  type ReplyClassifier,
} from "@/modules/replies/reply-classifier";
import {
  completeAgentRun,
  failAgentRun,
  startAgentRun,
} from "@/modules/agents/observability";
import { isObservedReplyClassifier } from "@/modules/replies/classification-service";
import type { AgentResult } from "@/modules/agents/types";
import type { ReplyClassification } from "@/modules/replies/reply-classifier";
import { mapReplyOutcome } from "@/modules/replies/reply-policy";
import {
  advanceAddressLadder,
  type LadderAdvanceOutcome,
} from "@/modules/email-resolution/ladder-service";
import { normalizeEmail } from "@/modules/prospects/normalization";
import { insertSuppressionInTransaction } from "@/modules/suppression/service";
import { isTerminalEnrollmentState } from "@/modules/campaigns/enrollment-state";

const inboundSchema = z.object({
  mailboxId: z.uuid(),
  providerMessageId: z.string().trim().min(1).max(1_000),
  providerNotificationId: z.string().trim().min(1).max(1_000).optional(),
  internetMessageId: z.string().trim().min(1).max(2_000).optional(),
  conversationId: z.string().trim().min(1).max(2_000).optional(),
  inReplyTo: z.string().trim().min(1).max(2_000).optional(),
  references: z.array(z.string().trim().min(1).max(2_000)).max(100).optional(),
  outreachId: z.string().trim().min(1).max(200).optional(),
  sender: z.string().trim().min(1).max(500),
  recipient: z.string().trim().min(1).max(500),
  subject: z.string().max(10_000),
  body: z.string().max(1_000_000),
  bounceKind: z.enum(["hard", "soft"]).nullable().optional(),
  bouncedRecipient: z.string().trim().min(1).max(500).optional(),
  receivedAt: z.coerce.date(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

type InboundInput = z.infer<typeof inboundSchema>;
type Message = typeof messages.$inferSelect;
type Transaction = Parameters<Parameters<AppDatabase["transaction"]>[0]>[0];
type Queryable = Pick<Transaction, "select">;
type MatchResult = Awaited<ReturnType<typeof findMatchedMessage>>;

function reconcileMatchAfterLock(
  initial: MatchResult,
  revalidated: MatchResult,
): MatchResult {
  if (revalidated.ambiguous) return revalidated;
  if (initial.message && revalidated.message?.id !== initial.message.id) {
    return { message: null, ambiguous: true };
  }
  return revalidated;
}

async function findMatchedMessage(
  tx: Queryable,
  input: InboundInput,
): Promise<{ message: Message | null; ambiguous: boolean }> {
  const candidates: Message[] = [];
  const strongMessageIds = new Set<string>();
  let ambiguous = false;
  if (input.outreachId) {
    const found = await tx
      .select()
      .from(messages)
      .where(
        and(
          eq(messages.mailboxId, input.mailboxId),
          eq(messages.direction, "outbound"),
          eq(messages.outreachId, input.outreachId),
        ),
      )
      .limit(2);
    candidates.push(...found);
    found.forEach((message) => strongMessageIds.add(message.id));
    ambiguous ||= found.length > 1;
  }
  if (input.inReplyTo) {
    const found = await tx
      .select()
      .from(messages)
      .where(
        and(
          eq(messages.mailboxId, input.mailboxId),
          eq(messages.direction, "outbound"),
          eq(messages.internetMessageId, input.inReplyTo),
        ),
      )
      .limit(2);
    candidates.push(...found);
    found.forEach((message) => strongMessageIds.add(message.id));
    ambiguous ||= found.length > 1;
  }
  if (input.references?.length) {
    const found = await tx
      .select()
      .from(messages)
      .where(
        and(
          eq(messages.mailboxId, input.mailboxId),
          eq(messages.direction, "outbound"),
          inArray(messages.internetMessageId, input.references),
        ),
      )
      .orderBy(desc(messages.sentAt));
    const enrollmentIds = new Set(found.map((row) => row.enrollmentId));
    candidates.push(...found);
    ambiguous ||= enrollmentIds.size > 1;
  }
  if (input.conversationId) {
    const found = await tx
      .select()
      .from(messages)
      .where(
        and(
          eq(messages.mailboxId, input.mailboxId),
          eq(messages.direction, "outbound"),
          eq(messages.conversationId, input.conversationId),
        ),
      )
      .orderBy(desc(messages.sentAt));
    const enrollmentIds = new Set(found.map((row) => row.enrollmentId));
    candidates.push(...found);
    ambiguous ||= enrollmentIds.size > 1;
  }
  const byId = [...new Map(candidates.map((row) => [row.id, row])).values()];
  const enrollmentIds = new Set(byId.map((row) => row.enrollmentId));
  if (ambiguous || strongMessageIds.size > 1 || enrollmentIds.size > 1) {
    return { message: null, ambiguous: true };
  }
  return { message: byId[0] ?? null, ambiguous: false };
}

function validateMatchedIdentity(
  match: MatchResult,
  input: InboundInput,
  sender: string,
  bouncedRecipient: string | undefined,
): MatchResult {
  if (!match.message) return match;
  const expected = match.message.recipient;
  const valid = input.bounceKind
    ? Boolean(bouncedRecipient && bouncedRecipient === expected)
    : sender === expected;
  return valid ? match : { message: null, ambiguous: true };
}

/**
 * Privacy boundary for mailbox sweeps. A general IMAP/Graph mailbox contains
 * unrelated personal mail; only messages that can be tied to one of this
 * application's outbound messages may cross into persistence/classification.
 */
export async function ingestMatchedInboundMessage(
  db: AppDatabase,
  classifier: ReplyClassifier,
  rawInput: unknown,
  options: { now?: Date; classificationClaimTtlMs?: number } = {},
) {
  const parsed = inboundSchema.safeParse(rawInput);
  if (!parsed.success) return { ok: false, code: "INVALID_INPUT" } as const;
  let sender: string;
  let bouncedRecipient: string | undefined;
  try {
    sender = normalizeEmail(parsed.data.sender);
    bouncedRecipient = parsed.data.bouncedRecipient
      ? normalizeEmail(parsed.data.bouncedRecipient)
      : undefined;
  } catch {
    return { ok: false, code: "INVALID_INPUT" } as const;
  }
  const match = validateMatchedIdentity(
    await findMatchedMessage(db, parsed.data),
    parsed.data,
    sender,
    bouncedRecipient,
  );
  if (!match.message) {
    return { ok: true, disposition: "ignored" } as const;
  }
  return ingestInboundMessage(db, classifier, parsed.data, options);
}

export async function ingestInboundMessage(
  db: AppDatabase,
  classifier: ReplyClassifier,
  rawInput: unknown,
  options: { now?: Date; classificationClaimTtlMs?: number } = {},
): Promise<
  | {
      ok: true;
      disposition: "processed" | "existing" | "unmatched" | "ambiguous";
      reply: typeof replies.$inferSelect;
    }
  | {
      ok: false;
      code:
        "INVALID_INPUT" | "IN_PROGRESS" | "CLASSIFIER_ERROR" | "DATABASE_ERROR";
    }
> {
  const parsed = inboundSchema.safeParse(rawInput);
  if (!parsed.success) return { ok: false, code: "INVALID_INPUT" };
  const input = parsed.data;
  const now = options.now ?? new Date();
  const classificationClaimTtlMs =
    options.classificationClaimTtlMs ?? 5 * 60_000;
  const classificationClaimId = randomUUID();
  let sender: string;
  let bouncedRecipient: string | undefined;
  try {
    sender = normalizeEmail(input.sender);
    bouncedRecipient = input.bouncedRecipient
      ? normalizeEmail(input.bouncedRecipient)
      : undefined;
  } catch {
    return { ok: false, code: "INVALID_INPUT" };
  }
  const payloadHash = createHash("sha256")
    .update(
      JSON.stringify({
        providerMessageId: input.providerMessageId,
        internetMessageId: input.internetMessageId,
        sender,
        subject: input.subject,
        body: input.body,
        receivedAt: input.receivedAt.toISOString(),
      }),
    )
    .digest("hex");

  let initialMatch: MatchResult;
  let stagedInbound: typeof inboundRecords.$inferSelect;
  let stagedReply: typeof replies.$inferSelect | undefined;
  let stagedHoldEnrollmentId: string | undefined;
  try {
    initialMatch = validateMatchedIdentity(
      await findMatchedMessage(db, input),
      input,
      sender,
      bouncedRecipient,
    );
    const lockRecipient = initialMatch.message?.recipient ?? sender;
    const lockDomain = lockRecipient.split("@")[1];
    const lockKeys = [actionLockKey.mailbox(input.mailboxId)];
    if (initialMatch.message) {
      lockKeys.push(
        actionLockKey.enrollment(initialMatch.message.enrollmentId),
      );
    }
    lockKeys.push(actionLockKey.recipient(lockRecipient));
    if (lockDomain) lockKeys.push(actionLockKey.domain(lockDomain));
    const staged = await withActionLocks(db, lockKeys, async (lockedDb) =>
      lockedDb.transaction(async (tx) => {
        const [created] = await tx
          .insert(inboundRecords)
          .values({
            mailboxId: input.mailboxId,
            providerMessageId: input.providerMessageId,
            providerNotificationId: input.providerNotificationId,
            outreachId: input.outreachId,
            internetMessageId: input.internetMessageId,
            conversationId: input.conversationId,
            inReplyTo: input.inReplyTo,
            references: input.references ?? [],
            eventType: input.bounceKind ? "bounce" : "message",
            payloadHash,
            status: "processing",
            classificationClaimId,
            classificationClaimedAt: now,
            lastAttemptAt: now,
            metadata: {
              ...input.metadata,
              sender,
              bouncedRecipient,
              recipient: input.recipient,
              subject: input.subject,
              body: input.body,
              bounceKind: input.bounceKind,
            },
            receivedAt: input.receivedAt,
          })
          .onConflictDoNothing()
          .returning();
        const [existing] = created
          ? [created]
          : await tx
              .select()
              .from(inboundRecords)
              .where(
                and(
                  eq(inboundRecords.mailboxId, input.mailboxId),
                  input.providerNotificationId
                    ? or(
                        eq(
                          inboundRecords.providerMessageId,
                          input.providerMessageId,
                        ),
                        eq(
                          inboundRecords.providerNotificationId,
                          input.providerNotificationId,
                        ),
                      )
                    : eq(
                        inboundRecords.providerMessageId,
                        input.providerMessageId,
                      ),
                ),
              )
              .limit(1);
        if (!existing)
          throw new Error("Inbound conflict could not be reconciled");
        await tx.execute(
          sql`select id from inbound_records where id = ${existing.id} for update`,
        );
        const [existingReply] = await tx
          .select()
          .from(replies)
          .where(eq(replies.inboundRecordId, existing.id))
          .limit(1);
        if (existingReply?.messageId || existingReply?.enrollmentId) {
          return {
            inbound: existing,
            reply: existingReply,
            holdEnrollmentId:
              typeof existing.metadata.holdEnrollmentId === "string"
                ? existing.metadata.holdEnrollmentId
                : undefined,
          };
        }
        const ownsClaim =
          existing.classificationClaimId === classificationClaimId;
        const claimIsFresh = Boolean(
          existing.classificationClaimId &&
          existing.classificationClaimedAt &&
          now.getTime() - existing.classificationClaimedAt.getTime() <
            classificationClaimTtlMs,
        );
        if (!ownsClaim && claimIsFresh) {
          return {
            inbound: existing,
            reply: existingReply,
            holdEnrollmentId:
              typeof existing.metadata.holdEnrollmentId === "string"
                ? existing.metadata.holdEnrollmentId
                : undefined,
            busy: true,
          };
        }
        await tx
          .update(inboundRecords)
          .set({
            status: "processing",
            error: null,
            classificationClaimId,
            classificationClaimedAt: now,
            lastAttemptAt: now,
          })
          .where(eq(inboundRecords.id, existing.id));
        const revalidated = validateMatchedIdentity(
          reconcileMatchAfterLock(
            initialMatch,
            await findMatchedMessage(tx, input),
          ),
          input,
          sender,
          bouncedRecipient,
        );
        let holdEnrollmentId =
          typeof existing.metadata.holdEnrollmentId === "string"
            ? existing.metadata.holdEnrollmentId
            : undefined;
        if (revalidated.message && !holdEnrollmentId) {
          await tx.execute(
            sql`select id from enrollments where id = ${revalidated.message.enrollmentId} for update`,
          );
          const [current] = await tx
            .select()
            .from(enrollments)
            .where(eq(enrollments.id, revalidated.message.enrollmentId))
            .limit(1);
          if (current && !isTerminalEnrollmentState(current.state)) {
            const firstHold = current.inboundHoldCount === 0;
            await tx
              .update(enrollments)
              .set({
                state: "manual_review",
                nextActionAt: null,
                nextActionToken: null,
                inboundHoldCount: current.inboundHoldCount + 1,
                inboundHoldAt: firstHold ? new Date() : current.inboundHoldAt,
                inboundHoldPreviousState: firstHold
                  ? current.state
                  : current.inboundHoldPreviousState,
                inboundHoldPreviousNextActionAt: firstHold
                  ? current.nextActionAt
                  : current.inboundHoldPreviousNextActionAt,
                inboundHoldPreviousNextActionToken: firstHold
                  ? current.nextActionToken
                  : current.inboundHoldPreviousNextActionToken,
              })
              .where(eq(enrollments.id, current.id));
            holdEnrollmentId = current.id;
            await tx
              .update(inboundRecords)
              .set({
                metadata: {
                  ...existing.metadata,
                  holdEnrollmentId: current.id,
                },
              })
              .where(eq(inboundRecords.id, existing.id));
            if (current.state !== "manual_review") {
              await tx.insert(stateTransitions).values({
                entityType: "enrollment",
                entityId: current.id,
                fromState: current.state,
                toState: "manual_review",
                reason: "inbound_reply_pending",
                metadata: { inboundRecordId: existing.id },
              });
            }
          }
        }
        return { inbound: existing, reply: existingReply, holdEnrollmentId };
      }),
    );
    stagedInbound = staged.inbound;
    stagedReply = staged.reply;
    stagedHoldEnrollmentId = staged.holdEnrollmentId;
    if (staged.busy) return { ok: false, code: "IN_PROGRESS" };
    if (stagedReply?.messageId || stagedReply?.enrollmentId) {
      return { ok: true, disposition: "existing", reply: stagedReply };
    }
  } catch {
    return { ok: false, code: "DATABASE_ERROR" };
  }

  let classification: ReplyClassification;
  let classificationAgentRunId: string | null = null;
  let classificationAgentRunOwned = false;
  let observedClassification: AgentResult<ReplyClassification> | null = null;
  try {
    if (stagedReply) {
      classification = validateReplyClassification({
        category: stagedReply.classification,
        confidence: Number(stagedReply.confidence),
        reason: stagedReply.classificationReason,
      });
      classificationAgentRunId = stagedReply.agentRunId;
    } else if (input.bounceKind) {
      classification = {
        category: "bounce",
        confidence: 1,
        reason: `${input.bounceKind} bounce provider signal`,
      };
    } else if (isObservedReplyClassifier(classifier)) {
      const classifierInput = {
        subject: input.subject,
        body: input.body,
        sender,
      };
      classificationAgentRunId = await startAgentRun(
        db,
        {
          name: "reply_classifier",
          model: classifier.model,
          // Carried through, not omitted. This descriptor is hand-built rather
          // than the classifier itself, so leaving the effort out wrote `null`
          // into every reply-classification row on a transport where both
          // lanes run the same model — the one case the column exists for.
          effort: classifier.effort,
          promptVersion: classifier.promptVersion,
          schemaVersion: classifier.schemaVersion,
        },
        classifierInput,
      );
      classificationAgentRunOwned = true;
      observedClassification =
        await classifier.classifyObserved(classifierInput);
      classification = validateReplyClassification(
        observedClassification.output,
      );
    } else {
      classification = validateReplyClassification(
        await classifier.classify({
          subject: input.subject,
          body: input.body,
          sender,
        }),
      );
    }
  } catch (error) {
    if (classificationAgentRunOwned && classificationAgentRunId) {
      await failAgentRun(db, classificationAgentRunId, error).catch(
        () => undefined,
      );
    }
    const failed = await db.transaction(async (tx) => {
      const [owned] = await tx
        .update(inboundRecords)
        .set({
          status: "failed",
          error: "Reply classification failed",
          classificationClaimId: null,
          classificationClaimedAt: null,
        })
        .where(
          and(
            eq(inboundRecords.id, stagedInbound.id),
            eq(inboundRecords.classificationClaimId, classificationClaimId),
          ),
        )
        .returning({ id: inboundRecords.id });
      if (!owned) return false;
      await tx
        .insert(workflowEvents)
        .values({
          entityType: "inbound_record",
          entityId: stagedInbound.id,
          event: "inbound.classification_failed",
          workflowName: "inbound_ingestion",
          idempotencyKey: `inbound:${stagedInbound.id}:classification_failed`,
          status: "failed",
          completedAt: new Date(),
          error: "Reply classification failed",
        })
        .onConflictDoNothing();
      return true;
    });
    return failed
      ? { ok: false, code: "CLASSIFIER_ERROR" }
      : { ok: false, code: "IN_PROGRESS" };
  }

  try {
    const explicitSuppressionTarget =
      classification.category === "unsubscribe"
        ? sender
        : classification.category === "bounce" && input.bounceKind === "hard"
          ? bouncedRecipient
          : undefined;
    const lockRecipient =
      explicitSuppressionTarget ?? initialMatch.message?.recipient ?? sender;
    const lockDomain = lockRecipient?.split("@")[1];
    const lockKeys = [actionLockKey.mailbox(input.mailboxId)];
    const finalEnrollmentId =
      stagedHoldEnrollmentId ?? initialMatch.message?.enrollmentId;
    if (finalEnrollmentId) {
      lockKeys.push(actionLockKey.enrollment(finalEnrollmentId));
    }
    if (lockRecipient) lockKeys.push(actionLockKey.recipient(lockRecipient));
    if (lockDomain) lockKeys.push(actionLockKey.domain(lockDomain));

    return await withActionLocks(db, lockKeys, async (lockedDb) =>
      lockedDb.transaction(async (tx) => {
        const inbound = stagedInbound;
        const existingReply = stagedReply;

        await tx.execute(
          sql`select id from inbound_records where id = ${inbound.id} for update`,
        );
        const [ownedInbound] = await tx
          .select({
            classificationClaimId: inboundRecords.classificationClaimId,
          })
          .from(inboundRecords)
          .where(eq(inboundRecords.id, inbound.id))
          .limit(1);
        if (ownedInbound?.classificationClaimId !== classificationClaimId) {
          return { ok: false, code: "IN_PROGRESS" } as const;
        }
        const revalidatedMatch = validateMatchedIdentity(
          await findMatchedMessage(tx, input),
          input,
          sender,
          bouncedRecipient,
        );
        const matched = reconcileMatchAfterLock(initialMatch, revalidatedMatch);
        if (existingReply && !matched.message) {
          const [released] = await tx
            .update(inboundRecords)
            .set({
              status: "processed",
              processedAt: now,
              lastAttemptAt: now,
              classificationClaimId: null,
              classificationClaimedAt: null,
            })
            .where(
              and(
                eq(inboundRecords.id, inbound.id),
                eq(inboundRecords.classificationClaimId, classificationClaimId),
              ),
            )
            .returning({ id: inboundRecords.id });
          if (!released) return { ok: false, code: "IN_PROGRESS" } as const;
          return {
            ok: true,
            disposition: matched.ambiguous ? "ambiguous" : "unmatched",
            reply: existingReply,
          } as const;
        }
        let holdNonTerminal = true;
        if (matched.message) {
          const [version] = await tx
            .select({ configuration: campaignVersions.configuration })
            .from(enrollments)
            .innerJoin(
              campaignVersions,
              eq(campaignVersions.id, enrollments.campaignVersionId),
            )
            .where(eq(enrollments.id, matched.message.enrollmentId))
            .limit(1);
          holdNonTerminal =
            version?.configuration.holdNonTerminalReplies !== false;
        }
        const outcome = mapReplyOutcome(
          classification.category,
          input.bounceKind ?? null,
          holdNonTerminal,
        );
        /**
         * A hard bounce proves the address does not exist. It does not prove the
         * person is done, and the product used to conflate the two.
         *
         * Run before the reply row is written, because whether the sequence
         * actually terminated is one of the facts that row records. The enrollment
         * is locked here for the same reason the terminal path locks it below: the
         * ladder rewrites it.
         */
        let ladder: LadderAdvanceOutcome | null = null;
        if (
          matched.message &&
          classification.category === "bounce" &&
          input.bounceKind === "hard"
        ) {
          await tx.execute(
            sql`select id from enrollments where id = ${matched.message.enrollmentId} for update`,
          );
          ladder = await advanceAddressLadder(tx, {
            messageId: matched.message.id,
            now,
            actor: "system:inbound",
          });
        }
        // The ladder owns the enrollment whenever it decided anything about it:
        // an advance, or a hold on a bound the operator can raise. Both leave a
        // live prospect, so neither may be written over with the terminal
        // bounce outcome below.
        const ladderOwnsEnrollment =
          ladder !== null &&
          (ladder.kind === "advanced" || !ladder.endsEnrollment);
        const effectiveOutcome = ladderOwnsEnrollment
          ? {
              ...outcome,
              state: "manual_review" as const,
              stopReason: null,
              terminal: false,
            }
          : outcome;
        const replyValues = {
          inboundRecordId: inbound.id,
          messageId: matched.message?.id,
          enrollmentId: matched.message?.enrollmentId,
          agentRunId: stagedReply?.agentRunId ?? classificationAgentRunId,
          body: input.body,
          classification: classification.category,
          confidence: classification.confidence.toString(),
          classificationReason: classification.reason,
          classifier: stagedReply?.classifier ?? classifier.name,
          bounceKind: input.bounceKind ?? null,
          sender,
          subject: input.subject,
          metadata: input.metadata ?? {},
          terminatesSequence: Boolean(
            matched.message && effectiveOutcome.terminal,
          ),
          receivedAt: input.receivedAt,
        };
        const [reply] = existingReply
          ? await tx
              .update(replies)
              .set({
                messageId: replyValues.messageId,
                enrollmentId: replyValues.enrollmentId,
                agentRunId: replyValues.agentRunId,
                classification: replyValues.classification,
                confidence: replyValues.confidence,
                classificationReason: replyValues.classificationReason,
                classifier: replyValues.classifier,
                bounceKind: replyValues.bounceKind,
                metadata: replyValues.metadata,
                terminatesSequence: replyValues.terminatesSequence,
              })
              .where(eq(replies.id, existingReply.id))
              .returning()
          : await tx.insert(replies).values(replyValues).returning();
        if (!reply) throw new Error("Reply insert returned no row");
        if (
          classificationAgentRunOwned &&
          classificationAgentRunId &&
          observedClassification
        ) {
          await completeAgentRun(
            tx,
            classificationAgentRunId,
            observedClassification,
          );
        }

        // The ladder has already rewritten this enrollment — non-terminal, back
        // at the dead step, with the inbound hold cleared — and it wrote its own
        // transition row. Running the terminal update over the top would undo
        // the thing that was just decided.
        /**
         * The ladder owns the enrollment's state, but this record's hold is
         * still this path's to release. `inboundHoldCount` counts every inbound
         * record holding the enrollment, so leaving it alone would hold a
         * prospect the ladder just freed, and zeroing it inside the ladder would
         * discard a different record's hold.
         */
        if (matched.message && ladderOwnsEnrollment && stagedHoldEnrollmentId) {
          const [current] = await tx
            .select({ inboundHoldCount: enrollments.inboundHoldCount })
            .from(enrollments)
            .where(eq(enrollments.id, matched.message.enrollmentId))
            .limit(1);
          const remaining = Math.max(0, (current?.inboundHoldCount ?? 0) - 1);
          await tx
            .update(enrollments)
            .set({
              inboundHoldCount: remaining,
              ...(remaining === 0
                ? {
                    inboundHoldAt: null,
                    inboundHoldPreviousState: null,
                    inboundHoldPreviousNextActionAt: null,
                    inboundHoldPreviousNextActionToken: null,
                  }
                : {}),
            })
            .where(eq(enrollments.id, matched.message.enrollmentId));
        }
        if (matched.message && !ladderOwnsEnrollment) {
          await tx.execute(
            sql`select id from enrollments where id = ${matched.message.enrollmentId} for update`,
          );
          const [current] = await tx
            .select()
            .from(enrollments)
            .where(eq(enrollments.id, matched.message.enrollmentId))
            .limit(1);
          if (!current) throw new Error("Matched enrollment missing");
          const heldByInbound = stagedHoldEnrollmentId === current.id;
          const remainingHolds = heldByInbound
            ? Math.max(0, current.inboundHoldCount - 1)
            : current.inboundHoldCount;
          const restorePrevious =
            heldByInbound &&
            remainingHolds === 0 &&
            !outcome.terminal &&
            !holdNonTerminal &&
            current.state === "manual_review" &&
            current.stopReason === null;
          const clearHold = heldByInbound && remainingHolds === 0;
          const update = isTerminalEnrollmentState(current.state)
            ? { lastReplyClassification: classification.category }
            : outcome.terminal
              ? {
                  lastReplyClassification: classification.category,
                  state: outcome.state!,
                  nextActionAt: null,
                  nextActionToken: null,
                  stopReason: outcome.stopReason,
                  stoppedAt: input.receivedAt,
                  inboundHoldCount: 0,
                  inboundHoldAt: null,
                  inboundHoldPreviousState: null,
                  inboundHoldPreviousNextActionAt: null,
                  inboundHoldPreviousNextActionToken: null,
                  workflowClaimId: null,
                  workflowClaimedAt: null,
                }
              : restorePrevious
                ? {
                    lastReplyClassification: classification.category,
                    state: current.inboundHoldPreviousState ?? "waiting",
                    nextActionAt: current.inboundHoldPreviousNextActionAt,
                    nextActionToken: current.inboundHoldPreviousNextActionToken,
                    inboundHoldCount: 0,
                    inboundHoldAt: null,
                    inboundHoldPreviousState: null,
                    inboundHoldPreviousNextActionAt: null,
                    inboundHoldPreviousNextActionToken: null,
                  }
                : {
                    lastReplyClassification: classification.category,
                    ...(outcome.state ? { state: outcome.state } : {}),
                    ...(outcome.clearSchedule
                      ? { nextActionAt: null, nextActionToken: null }
                      : {}),
                    ...(classification.category === "bounce" &&
                    input.bounceKind === "soft"
                      ? { softBounceCount: current.softBounceCount + 1 }
                      : {}),
                    ...(heldByInbound
                      ? {
                          inboundHoldCount: remainingHolds,
                          ...(clearHold
                            ? {
                                inboundHoldAt: null,
                                inboundHoldPreviousState: null,
                                inboundHoldPreviousNextActionAt: null,
                                inboundHoldPreviousNextActionToken: null,
                              }
                            : {}),
                        }
                      : {}),
                  };
          await tx
            .update(enrollments)
            .set(update)
            .where(eq(enrollments.id, current.id));
          if (restorePrevious) {
            await tx.insert(stateTransitions).values({
              entityType: "enrollment",
              entityId: current.id,
              fromState: "manual_review",
              toState: current.inboundHoldPreviousState ?? "waiting",
              reason: "inbound_nonterminal_reply_resumed",
              metadata: {
                replyId: reply.id,
                restoredNextActionAt:
                  current.inboundHoldPreviousNextActionAt?.toISOString() ??
                  null,
                restoredNextActionToken:
                  current.inboundHoldPreviousNextActionToken,
              },
            });
            await tx
              .insert(workflowEvents)
              .values({
                entityType: "enrollment",
                entityId: current.id,
                event: "inbound.nonterminal_reply_resumed",
                workflowName: "inbound_ingestion",
                idempotencyKey: `inbound:${inbound.id}:nonterminal_resumed`,
                status: "succeeded",
                completedAt: now,
                payload: {
                  replyId: reply.id,
                  restoredState: current.inboundHoldPreviousState ?? "waiting",
                  restoredNextActionAt:
                    current.inboundHoldPreviousNextActionAt?.toISOString() ??
                    null,
                  restoredNextActionToken:
                    current.inboundHoldPreviousNextActionToken,
                },
              })
              .onConflictDoNothing();
          }
          if (
            !isTerminalEnrollmentState(current.state) &&
            outcome.state &&
            outcome.state !== current.state
          ) {
            await tx.insert(stateTransitions).values({
              entityType: "enrollment",
              entityId: current.id,
              fromState: current.state,
              toState: outcome.state,
              reason:
                outcome.stopReason ?? `reply_${classification.category}_held`,
              metadata: {
                replyId: reply.id,
                confidence: classification.confidence,
              },
            });
          }
        }

        const suppressionTarget =
          classification.category === "unsubscribe"
            ? sender
            : classification.category === "bounce" &&
                input.bounceKind === "hard"
              ? (bouncedRecipient ?? matched.message?.recipient)
              : undefined;
        if (suppressionTarget) {
          await insertSuppressionInTransaction(tx, {
            scope: "email",
            normalizedValue: suppressionTarget,
            reason:
              classification.category === "unsubscribe"
                ? "unsubscribe"
                : "hard_bounce",
            actor: "system:inbound",
            sourceReplyId: reply.id,
            sourceInboundRecordId: inbound.id,
          });
        }

        await tx
          .update(inboundRecords)
          .set({
            status: "processed",
            processedAt: now,
            classificationClaimId: null,
            classificationClaimedAt: null,
          })
          .where(eq(inboundRecords.id, inbound.id));
        const workflowEventValues = {
          event: matched.ambiguous
            ? "inbound.ambiguous"
            : matched.message
              ? "inbound.reply_processed"
              : "inbound.unmatched",
          status: "succeeded" as const,
          completedAt: new Date(),
          payload: {
            replyId: reply.id,
            classification: classification.category,
            confidence: classification.confidence,
          },
        };
        await tx
          .insert(workflowEvents)
          .values({
            entityType: "inbound_record",
            entityId: inbound.id,
            ...workflowEventValues,
            workflowName: "inbound_ingestion",
            idempotencyKey: existingReply
              ? `inbound:${inbound.id}:rematched`
              : `inbound:${inbound.id}:processed`,
          })
          .onConflictDoNothing();
        return {
          ok: true,
          disposition: matched.ambiguous
            ? "ambiguous"
            : matched.message
              ? "processed"
              : "unmatched",
          reply,
        } as const;
      }),
    );
  } catch (error) {
    if (classificationAgentRunOwned && classificationAgentRunId) {
      await failAgentRun(db, classificationAgentRunId, error).catch(
        () => undefined,
      );
    }
    return { ok: false, code: "DATABASE_ERROR" };
  }
}

export async function reconcilePendingInboundRecords(
  db: AppDatabase,
  classifier: ReplyClassifier,
  options: {
    limit?: number;
    now?: Date;
    classificationClaimTtlMs?: number;
  } = {},
) {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
  const now = options.now ?? new Date();
  const classificationClaimTtlMs =
    options.classificationClaimTtlMs ?? 5 * 60_000;
  const staleBefore = new Date(now.getTime() - classificationClaimTtlMs);
  const pending = await db
    .select({ inbound: inboundRecords })
    .from(inboundRecords)
    .leftJoin(replies, eq(replies.inboundRecordId, inboundRecords.id))
    .where(
      and(
        or(
          inArray(inboundRecords.status, ["processing", "failed"]),
          and(
            eq(inboundRecords.status, "processed"),
            isNull(replies.messageId),
            isNull(replies.enrollmentId),
          ),
        ),
        or(
          isNull(inboundRecords.classificationClaimId),
          isNull(inboundRecords.classificationClaimedAt),
          lte(inboundRecords.classificationClaimedAt, staleBefore),
        ),
      ),
    )
    .orderBy(
      sql`case ${inboundRecords.status}
        when 'failed' then 0
        when 'processing' then 1
        else 2
      end`,
      sql`${inboundRecords.lastAttemptAt} asc nulls first`,
      sql`${inboundRecords.processedAt} asc nulls first`,
      asc(inboundRecords.createdAt),
      asc(inboundRecords.id),
    )
    .limit(limit);
  const results = [];
  for (const { inbound } of pending) {
    const metadata = inbound.metadata;
    if (
      typeof metadata.sender !== "string" ||
      typeof metadata.recipient !== "string" ||
      typeof metadata.subject !== "string" ||
      typeof metadata.body !== "string"
    ) {
      continue;
    }
    results.push(
      await ingestInboundMessage(
        db,
        classifier,
        {
          mailboxId: inbound.mailboxId,
          providerMessageId: inbound.providerMessageId,
          providerNotificationId: inbound.providerNotificationId ?? undefined,
          outreachId: inbound.outreachId ?? undefined,
          internetMessageId: inbound.internetMessageId ?? undefined,
          conversationId: inbound.conversationId ?? undefined,
          inReplyTo: inbound.inReplyTo ?? undefined,
          references: inbound.references,
          sender: metadata.sender,
          recipient: metadata.recipient,
          subject: metadata.subject,
          body: metadata.body,
          bounceKind:
            metadata.bounceKind === "hard" || metadata.bounceKind === "soft"
              ? metadata.bounceKind
              : undefined,
          bouncedRecipient:
            typeof metadata.bouncedRecipient === "string"
              ? metadata.bouncedRecipient
              : undefined,
          receivedAt: inbound.receivedAt,
        },
        { now, classificationClaimTtlMs },
      ),
    );
  }
  return results;
}

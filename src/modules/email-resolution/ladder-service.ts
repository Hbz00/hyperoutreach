import {
  and,
  desc,
  eq,
  gte,
  inArray,
  isNotNull,
  isNull,
  ne,
  or,
  sql,
} from "drizzle-orm";

import {
  contacts,
  emailCandidates,
  enrollments,
  messages,
  operatorCommands,
  operatorSendingSettings,
  stateTransitions,
  suppressionEntries,
  workflowEvents,
} from "@/lib/db/schema";
import type { AppDatabase } from "@/lib/db/types";
import { isTerminalEnrollmentState } from "@/modules/campaigns/enrollment-state";
import {
  chooseNextRung,
  conventionEvidenceOrder,
  isConventionDemoted,
  isLadderCircuitOpen,
  LADDER_FAILURE_WINDOW_MS,
  rankLadderRungs,
} from "@/modules/email-resolution/ladder";

type Transaction = Parameters<Parameters<AppDatabase["transaction"]>[0]>[0];
/** Anything that can run a select: the pool, or a transaction inside one. */
export type LadderQueryable = Pick<Transaction, "select">;

/**
 * The ladder's own settings, with the schema's defaults standing in when the
 * singleton row has not been created yet.
 *
 * Reading rather than inserting on demand, deliberately: this is called from
 * inside resolution and from inside a bounce transaction, and neither is a place
 * to acquire a write on an unrelated table.
 */
export const LADDER_SETTING_DEFAULTS = {
  enabled: true,
  maxRungs: 3,
  maxAdvancesPerAccountPerDay: 2,
  failureRatePercent: 30,
  failureRateMinimumSends: 20,
  demotionMinimumPeople: 2,
  demotionFailureSharePercent: 50,
} as const;

export type LadderSettings = {
  enabled: boolean;
  maxRungs: number;
  maxAdvancesPerAccountPerDay: number;
  failureRatePercent: number;
  failureRateMinimumSends: number;
  demotionMinimumPeople: number;
  demotionFailureSharePercent: number;
};

export async function readLadderSettings(
  db: LadderQueryable,
): Promise<LadderSettings> {
  const [row] = await db
    .select({
      enabled: operatorSendingSettings.addressLadderEnabled,
      maxRungs: operatorSendingSettings.addressLadderMaxRungs,
      maxAdvancesPerAccountPerDay:
        operatorSendingSettings.addressLadderMaxAdvancesPerAccountPerDay,
      failureRatePercent:
        operatorSendingSettings.addressLadderFailureRatePercent,
      failureRateMinimumSends:
        operatorSendingSettings.addressLadderFailureRateMinimumSends,
      demotionMinimumPeople:
        operatorSendingSettings.addressLadderDemotionMinimumPeople,
      demotionFailureSharePercent:
        operatorSendingSettings.addressLadderDemotionFailureSharePercent,
    })
    .from(operatorSendingSettings)
    .where(eq(operatorSendingSettings.id, 1))
    .limit(1);
  return row ?? { ...LADDER_SETTING_DEFAULTS };
}

export type ConventionOutcome = {
  pattern: string;
  /** Distinct people a send to this convention was attempted for. */
  peopleAttempted: number;
  /** Distinct people it was proven not to exist for. */
  peopleProvenDead: number;
  /**
   * Distinct people whose send produced no delivery failure at all.
   *
   * Deliberately not called "delivered". Silence is not a signal in either
   * direction, and this column is the number that tests the operator's contested
   * assumption that non-existent recipients are reported back in practice.
   */
  peopleNoSignal: number;
  demoted: boolean;
};

/**
 * What delivery has said about each convention, on one domain or across the
 * installation.
 *
 * Keyed on the candidate's own `domain`, never on the account its contact
 * currently belongs to. A convention is a property of a mail domain, and a
 * contact who changes employer keeps their old candidate rows while
 * `contacts.account_id` moves — so joining through the contact attributed an old
 * employer's failure to the new one, where it could demote a convention that
 * company never ran and re-rank unrelated colleagues there. It also made the old
 * employer's own record of that failure disappear. The domain cannot move.
 *
 * "Attempted" counts a proven-dead address even if its attempt clock was never
 * stamped — a rejection discovered during reconciliation can prove an address
 * dead before a send attempt was durably reserved — so the share can never
 * exceed one and a death can never be invisible to its own denominator.
 */
export async function readConventionOutcomes(
  db: LadderQueryable,
  input: {
    domain?: string | null;
    minimumPeople: number;
    failureSharePercent: number;
  },
): Promise<ConventionOutcome[]> {
  const rows = await db
    .select({
      pattern: emailCandidates.pattern,
      peopleAttempted: sql<number>`count(distinct case
        when ${emailCandidates.firstAttemptedAt} is not null
          or ${emailCandidates.deadAt} is not null
        then ${emailCandidates.contactId} end)::int`,
      peopleProvenDead: sql<number>`count(distinct case
        when ${emailCandidates.deadAt} is not null
        then ${emailCandidates.contactId} end)::int`,
    })
    .from(emailCandidates)
    .where(
      and(
        isNotNull(emailCandidates.pattern),
        input.domain ? eq(emailCandidates.domain, input.domain) : undefined,
      ),
    )
    .groupBy(emailCandidates.pattern);
  return rows
    .flatMap((row) =>
      row.pattern === null ? [] : [{ ...row, pattern: row.pattern }],
    )
    .map((row) => ({
      ...row,
      peopleNoSignal: Math.max(0, row.peopleAttempted - row.peopleProvenDead),
      demoted: isConventionDemoted({
        peopleProvenDead: row.peopleProvenDead,
        peopleAttempted: row.peopleAttempted,
        minimumPeople: input.minimumPeople,
        failureSharePercent: input.failureSharePercent,
      }),
    }))
    .sort(
      (left, right) =>
        right.peopleAttempted - left.peopleAttempted ||
        left.pattern.localeCompare(right.pattern),
    );
}

/** The conventions this domain's own delivery record has discredited. */
export async function readDemotedConventions(
  db: LadderQueryable,
  input: {
    domain: string | null;
    minimumPeople: number;
    failureSharePercent: number;
  },
): Promise<Set<string>> {
  const outcomes = await readConventionOutcomes(db, input);
  return new Set(
    outcomes
      .filter((outcome) => outcome.demoted)
      .map((outcome) => outcome.pattern),
  );
}

/**
 * Which of these addresses the suppression list blocks.
 *
 * A domain-scoped entry blocks every one of them, which is why the domain is
 * asked about separately rather than being inferred from the addresses.
 */
export async function readSuppressedAddresses(
  db: LadderQueryable,
  input: { addresses: string[]; domain: string },
): Promise<Set<string>> {
  if (input.addresses.length === 0) return new Set();
  const rows = await db
    .select({
      scope: suppressionEntries.scope,
      normalizedValue: suppressionEntries.normalizedValue,
    })
    .from(suppressionEntries)
    .where(
      or(
        and(
          eq(suppressionEntries.scope, "email"),
          inArray(suppressionEntries.normalizedValue, input.addresses),
        ),
        and(
          eq(suppressionEntries.scope, "domain"),
          eq(suppressionEntries.normalizedValue, input.domain),
        ),
      ),
    );
  if (rows.some((row) => row.scope === "domain")) {
    return new Set(input.addresses);
  }
  return new Set(rows.map((row) => row.normalizedValue));
}

/**
 * Rewrites the rung numbers of every candidate one contact holds.
 *
 * The ladder is the contact's whole candidate set: rows an earlier resolution
 * wrote, an address the operator accepted by hand, and the conventions the
 * latest pass inferred all compete for the same order. Ranking only the newest
 * would leave two rows claiming rung one.
 *
 * `conventionEvidenceOrder` is what makes this possible without a stored field —
 * confidence already encodes the sample count, and the pattern encodes how common
 * the form is — which is also why a demotion months later can reorder a ladder it
 * never saw being built.
 */
export async function rewriteLadderRanks(
  tx: Transaction,
  input: { contactId: string; demotedPatterns: ReadonlySet<string> },
): Promise<void> {
  const rows = await tx
    .select({
      id: emailCandidates.id,
      normalizedEmail: emailCandidates.normalizedEmail,
      pattern: emailCandidates.pattern,
      confidence: emailCandidates.confidence,
      ladderRank: emailCandidates.ladderRank,
    })
    .from(emailCandidates)
    .where(eq(emailCandidates.contactId, input.contactId));
  const ranked = rankLadderRungs(
    rows.map((row) => ({
      normalizedEmail: row.normalizedEmail,
      pattern: row.pattern,
      confidence: Number(row.confidence),
      evidenceOrder: conventionEvidenceOrder(row.pattern),
    })),
    input.demotedPatterns,
  );
  const byEmail = new Map(rows.map((row) => [row.normalizedEmail, row]));
  for (const rung of ranked) {
    const row = byEmail.get(rung.normalizedEmail);
    if (!row || row.ladderRank === rung.ladderRank) continue;
    await tx
      .update(emailCandidates)
      .set({ ladderRank: rung.ladderRank })
      .where(eq(emailCandidates.id, row.id));
  }
}

/**
 * The rungs of one contact's ladder that a suppression is blocking.
 *
 * The ladder skips these silently when it advances, which is right — and would
 * be indistinguishable from a rung that simply is not next if the operator could
 * not see which ones they are. A suppression is permanent and keyed on the
 * address alone, so a colleague's failed guess can own the address this person's
 * best convention produces; that is a thing to show, not a thing to hide.
 */
export async function readBlockedRungs(
  db: LadderQueryable,
  contactId: string,
): Promise<Set<string>> {
  const rows = await db
    .select({
      normalizedEmail: emailCandidates.normalizedEmail,
      domain: emailCandidates.domain,
    })
    .from(emailCandidates)
    .where(eq(emailCandidates.contactId, contactId));
  if (rows.length === 0) return new Set();
  return readSuppressedAddresses(db, {
    addresses: rows.map((row) => row.normalizedEmail),
    domain: rows[0]!.domain,
  });
}

export type LadderCircuitState = {
  sendsAttempted: number;
  sendsProvenDead: number;
  sendsNoSignal: number;
  failureSharePercent: number;
  open: boolean;
};

/**
 * The cost side of the ledger, over the breaker's window.
 *
 * Counted across every outbound send rather than only the ladder's own, because
 * the number being bounded is the mailbox's explicit-failure rate — the thing the
 * feature spends — not the feature's internal success.
 */
export async function readLadderCircuitState(
  db: LadderQueryable,
  input: {
    now: Date;
    thresholdPercent: number;
    minimumSends: number;
  },
): Promise<LadderCircuitState> {
  const since = new Date(input.now.getTime() - LADDER_FAILURE_WINDOW_MS);
  const [row] = await db
    .select({
      sendsAttempted: sql<number>`count(*)::int`,
      sendsProvenDead: sql<number>`count(case
        when ${messages.addressDeadAt} is not null then 1 end)::int`,
    })
    .from(messages)
    .where(
      and(
        eq(messages.direction, "outbound"),
        // A proven-dead message counts as an attempt whether or not its attempt
        // clock was stamped: a recipient refusal discovered while resuming a
        // draft never reaches the transaction that stamps it, and a failure
        // invisible to both sides of this ratio is a failure the breaker cannot
        // see. Written with typed operators rather than a `coalesce` fragment
        // because a raw template passes a JavaScript `Date` through without the
        // column's own mapping, and PostgreSQL refuses the string it becomes.
        or(
          gte(messages.sendAttemptedAt, since),
          and(
            isNull(messages.sendAttemptedAt),
            gte(messages.addressDeadAt, since),
          ),
        ),
      ),
    );
  const sendsAttempted = row?.sendsAttempted ?? 0;
  const sendsProvenDead = row?.sendsProvenDead ?? 0;
  return {
    sendsAttempted,
    sendsProvenDead,
    sendsNoSignal: Math.max(0, sendsAttempted - sendsProvenDead),
    failureSharePercent:
      sendsAttempted === 0
        ? 0
        : Math.round((sendsProvenDead * 100) / sendsAttempted),
    open: isLadderCircuitOpen({
      sendsAttempted,
      sendsProvenDead,
      thresholdPercent: input.thresholdPercent,
      minimumSends: input.minimumSends,
    }),
  };
}

/**
 * Why the ladder did not advance, in the operator's own terms.
 *
 * Kept apart rather than collapsed into "no", because each one asks something
 * different of the operator: a bound is theirs to raise, a suppression is an
 * entry to inspect, an outstanding send is a person who may be holding a message,
 * and an exhausted ladder is the end of the road for this prospect.
 */
export type LadderStopReason =
  | "feature_disabled"
  | "circuit_open"
  | "account_daily_cap"
  | "rung_ceiling"
  | "no_remaining_rung"
  | "all_remaining_suppressed"
  | "undelivered_send_outstanding"
  | "employment_changed"
  | "enrollment_ended"
  | "already_recorded"
  | "unknown_message";

export type LadderAdvanceOutcome =
  | {
      kind: "advanced";
      stepIndex: number;
      normalizedEmail: string;
      ladderRank: number;
    }
  | {
      kind: "not_advanced";
      reason: LadderStopReason;
      /**
       * Whether the caller should write the terminal bounce outcome.
       *
       * The distinction this exists for: a ladder with nothing left on it ends
       * the prospect, and a *bound the operator sets* does not. Treating the two
       * alike meant the third bounce of the day at one company — refused by a cap
       * whose whole purpose is pacing — lost that person as permanently as an
       * exhausted ladder, and raising the cap afterwards brought nobody back.
       */
      endsEnrollment: boolean;
    };

/**
 * Whether this refusal is the end of the prospect or a pause the operator can
 * lift.
 *
 * Every reason on the false side names a number in `/settings`. Everything on the
 * true side is a fact no setting changes: nothing left to try, an address that
 * may already have reached them, an employer that moved, a sequence somebody
 * ended, or the feature deliberately switched off — which is a request to behave
 * exactly as the product did before the ladder existed.
 */
function refusalEndsEnrollment(reason: LadderStopReason): boolean {
  switch (reason) {
    case "circuit_open":
    case "account_daily_cap":
    case "rung_ceiling":
      return false;
    // Another call already decided what happens to this enrollment. Writing a
    // terminal outcome over the top would undo an advance it may have made.
    case "already_recorded":
      return false;
    default:
      return true;
  }
}

/**
 * What the contact's address column should say once the ladder has stopped.
 *
 * The enrollment keeps `hard_bounce` — that is what happened to the sequence, and
 * it is what the send policy keys on. "There is no further address to try" is a
 * statement about the address, so it lives on the contact, where the operator
 * already reads a sentence explaining an unresolved one.
 */
function contactReasonFor(
  reason: LadderStopReason,
):
  | "ladder_exhausted"
  | "ladder_limit_reached"
  | "ladder_earlier_send_unconfirmed"
  | "address_suppressed"
  | "employment_changed"
  | null {
  switch (reason) {
    case "no_remaining_rung":
      return "ladder_exhausted";
    case "all_remaining_suppressed":
      return "address_suppressed";
    case "employment_changed":
      return "employment_changed";
    // Not a bound, and it must not read like one: no setting changes the answer
    // when the person may be holding a message already.
    case "undelivered_send_outstanding":
      return "ladder_earlier_send_unconfirmed";
    case "already_recorded":
    case "unknown_message":
      return null;
    default:
      return "ladder_limit_reached";
  }
}

/**
 * What the ladder writes to the inbound-hold columns when it takes over an
 * enrollment.
 *
 * `inboundHoldCount` is a reference count across every inbound record currently
 * holding this enrollment, and the `inboundHoldPrevious*` columns are the state
 * to restore once the last of them clears. The ladder used to zero all five,
 * which is right only when it is the sole holder — and silently destructive
 * otherwise: another record still in flight would later restore from a wiped
 * snapshot and land the enrollment in `waiting` with no `next_action_at`, where
 * no scheduler would ever look at it again.
 *
 * So the count is left to the inbound path that owns it, and the snapshot is
 * repointed at the state the ladder is about to write. A later release then
 * restores what the ladder decided rather than what the enrollment looked like
 * before any of this happened.
 */
function heldStateSnapshot(enrollment: {
  inboundHoldCount: number;
}): Record<string, unknown> {
  return enrollment.inboundHoldCount > 0
    ? {
        inboundHoldPreviousState: "manual_review" as const,
        inboundHoldPreviousNextActionAt: null,
        inboundHoldPreviousNextActionToken: null,
      }
    : {
        inboundHoldCount: 0,
        inboundHoldAt: null,
        inboundHoldPreviousState: null,
        inboundHoldPreviousNextActionAt: null,
        inboundHoldPreviousNextActionToken: null,
      };
}

/**
 * Turns a proven-dead address into the next attempt, or says why there is not
 * one.
 *
 * Runs inside the caller's transaction, with the enrollment already locked: both
 * callers — an inbound hard bounce and a definite SMTP recipient refusal — are
 * already holding that row, and the decision has to commit atomically with the
 * suppression and the state change that accompany it.
 *
 * What it never does is send. An advance queues the re-addressed message and
 * hands the enrollment back to the operator, because a re-addressed first message
 * is still a first message and no first send in this product may be
 * system-originated. That is also what makes an arbitrarily-ordered tied rung
 * safe to have on the ladder at all.
 */
export async function advanceAddressLadder(
  tx: Transaction,
  input: { messageId: string; now: Date; actor: string },
): Promise<LadderAdvanceOutcome> {
  const [context] = await tx
    .select({
      message: messages,
      enrollment: enrollments,
      contact: contacts,
    })
    .from(messages)
    .innerJoin(enrollments, eq(enrollments.id, messages.enrollmentId))
    .innerJoin(contacts, eq(contacts.id, enrollments.contactId))
    .where(eq(messages.id, input.messageId))
    .limit(1);
  if (!context) {
    return {
      kind: "not_advanced",
      reason: "unknown_message",
      endsEnrollment: true,
    };
  }
  const { contact, enrollment, message } = context;

  // Idempotent by the message's own marker rather than by the caller's care: the
  // inbound path can re-run a record, and a second advance from one death would
  // spend two addresses on one failure.
  const [markedDead] = await tx
    .update(messages)
    .set({ addressDeadAt: input.now })
    .where(and(eq(messages.id, message.id), isNull(messages.addressDeadAt)))
    .returning({ id: messages.id });
  if (!markedDead) {
    // Another call already recorded this death and decided what follows. Saying
    // the enrollment ends here would let a repeated delivery report write a
    // terminal outcome over an advance that has already happened.
    return {
      kind: "not_advanced",
      reason: "already_recorded",
      endsEnrollment: false,
    };
  }

  const settings = await readLadderSettings(tx);
  const [dying] = await tx
    .select({ id: emailCandidates.id, pattern: emailCandidates.pattern })
    .from(emailCandidates)
    .where(
      and(
        eq(emailCandidates.contactId, contact.id),
        eq(emailCandidates.normalizedEmail, message.recipient),
      ),
    )
    .limit(1);
  if (dying) {
    await tx
      .update(emailCandidates)
      .set({
        deadAt: input.now,
        deadMessageId: message.id,
        status: "rejected",
      })
      .where(eq(emailCandidates.id, dying.id));
  }

  /**
   * The company learns from this before the next colleague is offered the same
   * form. Evaluated after the death is recorded so this failure counts.
   *
   * Scoped to the domain and the account the *message* was sent under, never the
   * contact's current ones. A contact who has since changed employer would
   * otherwise carry this failure into the new company's record, where it could
   * demote a convention that company never ran and re-rank colleagues who have
   * nothing to do with it.
   */
  const deadDomain = message.recipient.slice(
    message.recipient.lastIndexOf("@") + 1,
  );
  const demotedPatterns = await readDemotedConventions(tx, {
    domain: deadDomain,
    minimumPeople: settings.demotionMinimumPeople,
    failureSharePercent: settings.demotionFailureSharePercent,
  });
  if (dying?.pattern && demotedPatterns.has(dying.pattern)) {
    await applyConventionDemotion(tx, {
      accountId: message.contactAccountId ?? contact.accountId,
      demotedPatterns,
    });
  }
  await rewriteLadderRanks(tx, { contactId: contact.id, demotedPatterns });

  const refuse = async (
    reason: LadderStopReason,
  ): Promise<LadderAdvanceOutcome> => {
    const endsEnrollment = refusalEndsEnrollment(reason);
    const contactReason = contactReasonFor(reason);
    if (contactReason) {
      await tx
        .update(contacts)
        .set({
          emailResolutionStatus: "unresolved",
          emailResolutionReason: contactReason,
          emailResolutionAttemptedAt: input.now,
        })
        .where(eq(contacts.id, contact.id));
    }
    /**
     * A prospect a raisable bound stopped is parked, not left where they were.
     *
     * Doing nothing would be worse than either alternative: the enrollment would
     * keep whatever schedule it had, and its next due follow-up would look for a
     * previous-step message that is now dead and find none — retrying forever
     * against a step that cannot be satisfied. Parking puts it back at the step
     * that bounced, with no schedule, where the operator can see it and where
     * resolving the company again promotes the surviving rung.
     */
    if (!endsEnrollment && !isTerminalEnrollmentState(enrollment.state)) {
      await tx
        .update(enrollments)
        .set({
          state: "manual_review",
          currentStep: message.stepIndex ?? enrollment.currentStep,
          nextActionAt: null,
          nextActionToken: null,
          stopReason: null,
          stoppedAt: null,
          lastReplyClassification: "bounce",
          ...heldStateSnapshot(enrollment),
          workflowClaimId: null,
          workflowClaimedAt: null,
        })
        .where(eq(enrollments.id, enrollment.id));
      if (enrollment.state !== "manual_review") {
        await tx.insert(stateTransitions).values({
          entityType: "enrollment",
          entityId: enrollment.id,
          fromState: enrollment.state,
          toState: "manual_review",
          reason: `address_ladder_held:${reason}`,
          actor: input.actor,
          metadata: {
            deadAddress: message.recipient,
            stepIndex: message.stepIndex,
          },
        });
      }
    }
    await tx
      .insert(workflowEvents)
      .values({
        entityType: "enrollment",
        entityId: enrollment.id,
        // Named for what happened, not for the one case that used to be the
        // only one: a daily cap is not an exhausted ladder and an audit that
        // called it one could not tell them apart afterwards.
        event: endsEnrollment
          ? "address_ladder.exhausted"
          : "address_ladder.held",
        workflowName: "address_ladder",
        idempotencyKey: `ladder:${message.id}:${endsEnrollment ? "exhausted" : "held"}`,
        status: "skipped",
        completedAt: input.now,
        payload: {
          reason,
          endsEnrollment,
          deadAddress: message.recipient,
          stepIndex: message.stepIndex,
        },
      })
      .onConflictDoNothing();
    return { kind: "not_advanced", reason, endsEnrollment };
  };

  if (
    message.contactAccountId !== contact.accountId ||
    message.employmentVersion !== contact.employmentVersion
  ) {
    return refuse("employment_changed");
  }
  /**
   * A sequence somebody *ended* is never resurrected by a late delivery failure.
   *
   * `completed` is the one terminal state that may advance, and only when it got
   * there by running out of steps: that enrollment was not ended by a decision,
   * it ended because a send succeeded — and this bounce is the proof that the
   * send reached nobody. A one-step campaign lives entirely in that case.
   *
   * Every other terminal state carries a decision or a fact the ladder has no
   * business overturning: a reply, an unsubscribe, a manual stop, an earlier
   * bounce.
   */
  if (
    isTerminalEnrollmentState(enrollment.state) &&
    !(
      enrollment.state === "completed" &&
      enrollment.stopReason === "sequence_complete"
    )
  ) {
    return refuse("enrollment_ended");
  }
  /**
   * A person whose send produced no delivery failure must never be re-addressed:
   * they may well have received it, and a second copy at another address is a
   * duplicate delivery to one human. `delivery_uncertain` counts as outstanding
   * for exactly the same reason.
   *
   * This is what makes the ladder almost entirely a step-zero feature, which is
   * the right shape — a hard bounce at step two on an address that carried step
   * zero says the person left, not that the convention was wrong, and the ladder
   * must not answer a question about employment.
   */
  const [outstanding] = await tx
    .select({ id: messages.id })
    .from(messages)
    .where(
      and(
        eq(messages.enrollmentId, enrollment.id),
        eq(messages.direction, "outbound"),
        ne(messages.id, message.id),
        isNull(messages.addressDeadAt),
        or(
          isNotNull(messages.sendAttemptedAt),
          inArray(messages.status, ["sent", "delivery_uncertain"]),
        ),
      ),
    )
    .limit(1);
  if (outstanding) return refuse("undelivered_send_outstanding");

  if (!settings.enabled) return refuse("feature_disabled");
  const circuit = await readLadderCircuitState(tx, {
    now: input.now,
    thresholdPercent: settings.failureRatePercent,
    minimumSends: settings.failureRateMinimumSends,
  });
  if (circuit.open) return refuse("circuit_open");
  const [advancesToday] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(emailCandidates)
    .innerJoin(contacts, eq(contacts.id, emailCandidates.contactId))
    .where(
      and(
        eq(contacts.accountId, contact.accountId),
        isNotNull(emailCandidates.advancedAt),
        gte(
          emailCandidates.advancedAt,
          new Date(input.now.getTime() - 24 * 60 * 60_000),
        ),
      ),
    );
  if ((advancesToday?.count ?? 0) >= settings.maxAdvancesPerAccountPerDay) {
    return refuse("account_daily_cap");
  }

  const rungs = await tx
    .select({
      normalizedEmail: emailCandidates.normalizedEmail,
      ladderRank: emailCandidates.ladderRank,
      firstAttemptedAt: emailCandidates.firstAttemptedAt,
      deadAt: emailCandidates.deadAt,
    })
    .from(emailCandidates)
    .where(eq(emailCandidates.contactId, contact.id));
  const suppressed = await readSuppressedAddresses(tx, {
    addresses: rungs.map((rung) => rung.normalizedEmail),
    domain: deadDomain,
  });
  const next = chooseNextRung({
    rungs: rungs.map((rung) => ({
      ...rung,
      suppressed: suppressed.has(rung.normalizedEmail),
    })),
    maxRungs: settings.maxRungs,
  });
  if (next.kind === "none") return refuse(next.reason);

  await tx
    .update(emailCandidates)
    .set({ status: "candidate" })
    .where(
      and(
        eq(emailCandidates.contactId, contact.id),
        eq(emailCandidates.status, "accepted"),
      ),
    );
  await tx
    .update(emailCandidates)
    .set({ status: "accepted", advancedAt: input.now })
    .where(
      and(
        eq(emailCandidates.contactId, contact.id),
        eq(emailCandidates.normalizedEmail, next.normalizedEmail),
      ),
    );
  await tx
    .update(contacts)
    .set({
      emailResolutionStatus: "resolved",
      emailResolutionReason: null,
      emailResolutionError: null,
      emailResolutionAttemptedAt: input.now,
      status: "email_resolved",
    })
    .where(eq(contacts.id, contact.id));

  /**
   * Follow-up timing counts from the most recent attempt that was *not* proven
   * dead — never from "the one that landed", which is a fact this product cannot
   * establish. With every attempt dead, there is no last message.
   */
  const [lastLive] = await tx
    .select({ sentAt: messages.sentAt })
    .from(messages)
    .where(
      and(
        eq(messages.enrollmentId, enrollment.id),
        eq(messages.direction, "outbound"),
        isNull(messages.addressDeadAt),
        isNotNull(messages.sentAt),
      ),
    )
    .orderBy(desc(messages.sentAt))
    .limit(1);
  const stepIndex = message.stepIndex ?? enrollment.currentStep;
  await tx
    .update(enrollments)
    .set({
      // Not terminal, and not `ready_for_review` either: the message does not
      // exist yet. Generation moves it on when the queue writes one.
      state: "manual_review",
      // The step is not consumed. A re-addressed first message is still the
      // first message.
      currentStep: stepIndex,
      nextActionAt: null,
      nextActionToken: null,
      stopReason: null,
      stoppedAt: null,
      lastMessageAt: lastLive?.sentAt ?? null,
      lastReplyClassification: "bounce",
      ...heldStateSnapshot(enrollment),
      workflowClaimId: null,
      workflowClaimedAt: null,
    })
    .where(eq(enrollments.id, enrollment.id));
  /**
   * The re-addressed message is queued, not sent.
   *
   * The dedupe key carries the rung, so a second advance on the same step is a
   * new request rather than colliding with the row enrolment wrote for rung one
   * — which is a fixed `enrollment:<id>:generate:0` and would otherwise answer
   * "already queued" forever.
   *
   * No recipient in the payload, deliberately: the queue derives it from the
   * accepted candidate, which is the rung just promoted.
   */
  await tx
    .insert(operatorCommands)
    .values({
      command: "generate-message",
      task: "generate-message",
      payload: { enrollmentId: enrollment.id, stepIndex },
      requestedBy: input.actor,
      dedupeKey: `enrollment:${enrollment.id}:generate:${stepIndex}:rung:${next.ladderRank}`,
    })
    .onConflictDoNothing();
  await tx.insert(stateTransitions).values({
    entityType: "enrollment",
    entityId: enrollment.id,
    fromState: enrollment.state,
    toState: "manual_review",
    reason: "address_ladder_advanced",
    actor: input.actor,
    metadata: {
      deadAddress: message.recipient,
      deadMessageId: message.id,
      nextAddress: next.normalizedEmail,
      ladderRank: next.ladderRank,
      stepIndex,
    },
  });
  await tx
    .insert(workflowEvents)
    .values({
      entityType: "enrollment",
      entityId: enrollment.id,
      event: "address_ladder.advanced",
      workflowName: "address_ladder",
      idempotencyKey: `ladder:${message.id}:advanced`,
      status: "succeeded",
      completedAt: input.now,
      payload: {
        deadAddress: message.recipient,
        nextAddress: next.normalizedEmail,
        ladderRank: next.ladderRank,
        stepIndex,
      },
    })
    .onConflictDoNothing();
  return {
    kind: "advanced",
    stepIndex,
    normalizedEmail: next.normalizedEmail,
    ladderRank: next.ladderRank,
  };
}

/**
 * Moves this company's contacts off a convention its own delivery record has
 * discredited.
 *
 * Only contacts with **no outbound message at all** are touched. A contact who
 * already has a generated message is pinned to that address by it, and silently
 * accepting a different one would leave the send policy refusing that message for
 * a reason the operator was never told about. Those keep their address; their
 * review card says the convention has since been demoted, which is a decision
 * they can act on rather than a state they have to discover.
 *
 * It reorders and never removes: a contact whose only rung uses the demoted
 * convention keeps it, because reordering a one-element ladder is a no-op and
 * rejecting it would spend a reachable prospect for a rule about ordering.
 */
export async function applyConventionDemotion(
  tx: Transaction,
  input: { accountId: string; demotedPatterns: ReadonlySet<string> },
): Promise<{ rerankedContactIds: string[] }> {
  if (input.demotedPatterns.size === 0) return { rerankedContactIds: [] };
  const unwritten = await tx
    .select({ id: contacts.id })
    .from(contacts)
    .where(
      and(
        eq(contacts.accountId, input.accountId),
        sql`not exists (
          select 1
          from messages written
          join enrollments owner on owner.id = written.enrollment_id
          where owner.contact_id = ${contacts.id}
            and written.direction = 'outbound'
        )`,
      ),
    );
  const rerankedContactIds: string[] = [];
  for (const candidateContact of unwritten) {
    /**
     * Re-asked per contact, not trusted from the listing above.
     *
     * That listing took no lock, and a message for one of these contacts can be
     * generated between it and this loop. Moving the accepted address out from
     * under a message that already names it leaves the send policy refusing that
     * message for a reason the operator never asked about — the exact outcome
     * this whole "unwritten only" rule exists to avoid.
     */
    const [written] = await tx
      .select({ id: messages.id })
      .from(messages)
      .innerJoin(enrollments, eq(enrollments.id, messages.enrollmentId))
      .where(
        and(
          eq(enrollments.contactId, candidateContact.id),
          eq(messages.direction, "outbound"),
        ),
      )
      .limit(1);
    if (written) continue;
    await rewriteLadderRanks(tx, {
      contactId: candidateContact.id,
      demotedPatterns: input.demotedPatterns,
    });
    const rows = await tx
      .select({
        normalizedEmail: emailCandidates.normalizedEmail,
        ladderRank: emailCandidates.ladderRank,
        pattern: emailCandidates.pattern,
        status: emailCandidates.status,
        firstAttemptedAt: emailCandidates.firstAttemptedAt,
        deadAt: emailCandidates.deadAt,
      })
      .from(emailCandidates)
      .where(eq(emailCandidates.contactId, candidateContact.id));
    const accepted = rows.find((row) => row.status === "accepted");
    if (!accepted?.pattern || !input.demotedPatterns.has(accepted.pattern)) {
      continue;
    }
    const suppressed = await readSuppressedAddresses(tx, {
      addresses: rows.map((row) => row.normalizedEmail),
      domain: accepted.normalizedEmail.slice(
        accepted.normalizedEmail.lastIndexOf("@") + 1,
      ),
    });
    const replacement = rows
      .filter(
        (row) =>
          row.deadAt === null &&
          row.firstAttemptedAt === null &&
          !suppressed.has(row.normalizedEmail) &&
          (row.pattern === null || !input.demotedPatterns.has(row.pattern)),
      )
      .sort((left, right) => left.ladderRank - right.ladderRank)[0];
    if (!replacement) continue;
    await tx
      .update(emailCandidates)
      .set({ status: "candidate" })
      .where(
        and(
          eq(emailCandidates.contactId, candidateContact.id),
          eq(emailCandidates.status, "accepted"),
        ),
      );
    await tx
      .update(emailCandidates)
      // No `advancedAt`: this is a re-ranking, not an advance. Only a death
      // spends the per-company daily advance bound.
      .set({ status: "accepted" })
      .where(
        and(
          eq(emailCandidates.contactId, candidateContact.id),
          eq(emailCandidates.normalizedEmail, replacement.normalizedEmail),
        ),
      );
    await tx.insert(stateTransitions).values({
      entityType: "contact",
      entityId: candidateContact.id,
      fromState: "email_resolved",
      toState: "email_resolved",
      reason: "address_convention_demoted",
      metadata: {
        demotedPattern: accepted.pattern,
        previousAddress: accepted.normalizedEmail,
        nextAddress: replacement.normalizedEmail,
      },
    });
    rerankedContactIds.push(candidateContact.id);
  }
  return { rerankedContactIds };
}

export type AddressLadderMetrics = {
  /** Prospects whose address in use is the best-evidenced convention. */
  onFirstRung: number;
  /** Prospects reached on rung two or later: the feature's actual yield. */
  advanced: number;
  /** Prospects with no further address to try. */
  exhausted: number;
  /** Prospects an untried address remains for, stopped by a bound. */
  limited: number;
  sendsAttempted: number;
  sendsProvenDead: number;
  sendsNoSignal: number;
  failureSharePercent: number;
  circuitOpen: boolean;
};

/**
 * The yield of the ladder next to its cost, which is the only way either number
 * means anything.
 *
 * `sendsNoSignal` is the number that tests the operator's contested assumption
 * that non-existent recipients are reported back in practice on the domains being
 * targeted. It is deliberately not called "delivered".
 */
export async function readAddressLadderMetrics(
  db: LadderQueryable,
  input: { now: Date },
): Promise<AddressLadderMetrics> {
  const settings = await readLadderSettings(db);
  const circuit = await readLadderCircuitState(db, {
    now: input.now,
    thresholdPercent: settings.failureRatePercent,
    minimumSends: settings.failureRateMinimumSends,
  });
  const [rungs] = await db
    .select({
      onFirstRung: sql<number>`count(case
        when ${emailCandidates.ladderRank} = 1
          and ${emailCandidates.advancedAt} is null then 1 end)::int`,
      advanced: sql<number>`count(case
        when ${emailCandidates.advancedAt} is not null then 1 end)::int`,
    })
    .from(emailCandidates)
    .where(eq(emailCandidates.status, "accepted"));
  const [stopped] = await db
    .select({
      exhausted: sql<number>`count(case
        when ${contacts.emailResolutionReason} = 'ladder_exhausted' then 1 end)::int`,
      limited: sql<number>`count(case
        when ${contacts.emailResolutionReason} = 'ladder_limit_reached' then 1 end)::int`,
    })
    .from(contacts);
  return {
    onFirstRung: rungs?.onFirstRung ?? 0,
    advanced: rungs?.advanced ?? 0,
    exhausted: stopped?.exhausted ?? 0,
    limited: stopped?.limited ?? 0,
    sendsAttempted: circuit.sendsAttempted,
    sendsProvenDead: circuit.sendsProvenDead,
    sendsNoSignal: circuit.sendsNoSignal,
    failureSharePercent: circuit.failureSharePercent,
    circuitOpen: circuit.open,
  };
}

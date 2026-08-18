# Company Address Convention and Attempt Ladder — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to
> implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Make the address convention a property of the company, give every
contact an ordered ladder of evidenced addresses, and let a proven-dead address
advance that ladder instead of ending the prospect.

**Architecture:** `email_candidates` becomes the ladder — one row per (person,
convention) carrying its rank, whether it was attempted, and whether it was
proven dead. A hard bounce marks the address dead, keeps its permanent
suppression, and either promotes the next rung (offering a re-addressed message
through the review queue) or reports an exhausted ladder. A partial unique index
on `messages` — one live outbound message per step, dead ones excluded — is what
lets a step be re-addressed without weakening duplicate-send protection.
Delivery outcomes accumulate per convention per company and can demote a
convention's order without ever rewriting its public-sample confidence.

**Tech Stack:** TypeScript, Next.js App Router (server components, no client JS),
PostgreSQL + Drizzle, Zod, Vitest (unit + PostgreSQL integration), Playwright.

**Spec:** `docs/superpowers/specs/2026-08-17-company-address-convention-design.md`

## Global Constraints

- **No first send may be system-originated.** An advance queues a message and
  stops; the operator's approval is what sends it.
- **An advance is subject to every existing send-policy gate**, unchanged. No
  exemption is added for the ladder.
- **A suppression written for a dead address is permanent and keyed on the
  address alone.** Nothing in this work removes, scopes, or bypasses it.
- **An advance requires that every _attempted_ outbound message on the
  enrollment is proven dead.** `sent` or `delivery_uncertain` without a proven
  death blocks the advance forever. A `proposed`/`cancelled`/`failed`-without-
  hard-bounce message that never left blocks nothing.
- **Outcome evidence may only demote, never confirm.** Every rate has "sends
  attempted" as its denominator, never "delivered".
- **Demotion reorders; it never rescores and never removes.** Public-sample
  confidence and the delivery record stay two visible quantities.
- **No unevidenced rung, ever.** `acceptManualEmail` is the human-originated
  escape hatch.
- Settings defaults: ladder enabled, 3 rungs per contact, 2 advances per company
  per day, circuit breaker at 30% explicit-failure share over a rolling 30 days
  ignored below 20 attempted sends, demotion at ≥2 distinct people and ≥50% of
  that convention's attempts at that company.
- Migrations: `ALTER TYPE … ADD VALUE` is fine (precedent: `drizzle/0014`,
  `0015`) but the new value must not be _used_ in the same migration.
- Every persisted enum value the operator can see needs a sentence in
  `src/modules/presentation/status.ts`.
- Commands: `npm run test -- <file>`, `npm run test:integration -- <file>`,
  `npm run typecheck`, `npm run lint`, `npm run format:check`, `npm run build`.
  Integration tests need `npm run db:up` once.

---

## File Structure

**Created**

| File                                                     | Responsibility                                                                                                   |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `src/modules/email-resolution/ladder.ts`                 | Pure ladder arithmetic: ranking, next-rung selection, demotion rule, circuit-breaker rule. No database.          |
| `src/modules/email-resolution/ladder-service.ts`         | Transaction-scoped ladder effects: advance, demotion application, and the read models for the operator surfaces. |
| `src/modules/email-resolution/account-resolution.ts`     | Which contacts of one account need an address, for the company-level action.                                     |
| `tests/unit/address-ladder.test.ts`                      | The pure rules.                                                                                                  |
| `tests/integration/address-ladder.test.ts`               | Bounce → advance → exhaustion against PostgreSQL.                                                                |
| `tests/integration/account-email-resolution.test.ts`     | One company search covers every contact; queue drains them in one pass.                                          |
| `drizzle/0033_*.sql` + `drizzle/meta/0033_snapshot.json` | Generated migration.                                                                                             |

**Modified**

| File                                                                | Change                                                                                                                                      |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/lib/db/schema.ts`                                              | Ladder columns on `messages`/`email_candidates`, ladder settings, 3 new resolution reasons, partial unique index on live outbound messages. |
| `src/modules/email-resolution/service.ts`                           | Persist ranks, drop the tie refusal, skip suppressed addresses, apply demotion order, never move an address already attempted.              |
| `src/modules/messages/send-service.ts`                              | Stamp `first_attempted_at`; exclude dead messages from `stepAlreadySent`; advance the ladder on a hard SMTP refusal.                        |
| `src/modules/replies/inbound-service.ts`                            | Advance the ladder on a hard bounce; report `terminatesSequence` truthfully.                                                                |
| `src/modules/messages/generation-service.ts`                        | A dead message is not an "existing" message for its step.                                                                                   |
| `src/modules/workflows/follow-up-service.ts`                        | **Bug fix:** the previous-step recipient must not be read from a dead message.                                                              |
| `src/modules/workflows/follow-up-service.ts` (`findDueEnrollments`) | Dead messages do not occupy a step.                                                                                                         |
| `src/modules/workflows/operator-command-queue.ts`                   | Observe whether a command spent an AI turn instead of predicting it.                                                                        |
| `src/modules/workflows/operator-command-preconditions.ts`           | Delete `commandTakesAiTurn` and `usesAi`.                                                                                                   |
| `src/modules/settings/service.ts`                                   | Ladder settings in defaults, schema, update path.                                                                                           |
| `src/modules/presentation/status.ts`                                | Sentences for the new resolution reasons.                                                                                                   |
| `src/app/api/operator/commands/[command]/route.ts`                  | `resolve-account-emails`.                                                                                                                   |
| `src/app/(operator)/prospects/page.tsx`                             | Company-level resolve action with its contact count.                                                                                        |
| `src/app/(operator)/prospects/[contactId]/page.tsx`                 | Ladder table, company conventions with their delivery record.                                                                               |
| `src/app/(operator)/review/page.tsx`                                | Which rung this message addresses, whether the order was a tie, whether the convention is demoted.                                          |
| `src/app/(operator)/outbound/page.tsx`                              | Pipeline ladder metrics and the per-convention failure/no-signal split.                                                                     |
| `src/app/(operator)/settings/page.tsx`                              | Ladder bounds, each beside the measurement it is compared against.                                                                          |
| `tests/integration/relational-integrity.test.ts`                    | The new partial unique index.                                                                                                               |
| `README.md`                                                         | The feature, its bounds, and what it deliberately does not do.                                                                              |

---

### Task 1: Schema and migration

**Files:**

- Modify: `src/lib/db/schema.ts`
- Create: `drizzle/0033_*.sql`, `drizzle/meta/0033_snapshot.json` (generated)
- Test: `tests/integration/relational-integrity.test.ts`

**Interfaces produced:**

- `messages.addressDeadAt: Date | null`
- `emailCandidates.ladderRank: number` (≥1), `.firstAttemptedAt: Date | null`,
  `.deadAt: Date | null`, `.deadMessageId: string | null`,
  `.advancedAt: Date | null`
- `operatorSendingSettings.addressLadderEnabled: boolean`,
  `.addressLadderMaxRungs: number`,
  `.addressLadderMaxAdvancesPerAccountPerDay: number`,
  `.addressLadderFailureRatePercent: number`,
  `.addressLadderFailureRateMinimumSends: number`,
  `.addressLadderDemotionMinimumPeople: number`,
  `.addressLadderDemotionFailureSharePercent: number`
- `email_resolution_reason` gains `ladder_exhausted`, `ladder_limit_reached`,
  `address_suppressed`

- [ ] **Step 1: Write the failing integration assertion**

In `tests/integration/relational-integrity.test.ts`, add a case proving a second
outbound message at the same step is refused while the first is live, and
accepted once the first is marked dead.

```ts
it("permits one live outbound message per step and a successor once the first address is proven dead", async () => {
  // insert campaign/version/step/contact/enrollment fixtures as the file already does
  await db.insert(messages).values({
    ...base,
    stepIndex: 0,
    outreachId: "out_a",
    recipient: "a@acme.test",
    status: "sent",
  });
  await expect(
    db.insert(messages).values({
      ...base,
      stepIndex: 0,
      outreachId: "out_b",
      recipient: "b@acme.test",
      status: "proposed",
    }),
  ).rejects.toThrow();
  await db
    .update(messages)
    .set({ addressDeadAt: new Date() })
    .where(eq(messages.outreachId, "out_a"));
  await expect(
    db.insert(messages).values({
      ...base,
      stepIndex: 0,
      outreachId: "out_b",
      recipient: "b@acme.test",
      status: "proposed",
    }),
  ).resolves.toBeDefined();
});
```

- [ ] **Step 2: Run it and watch it fail**

`npm run test:integration -- tests/integration/relational-integrity.test.ts`
Expected: fail — `addressDeadAt` is not a column.

- [ ] **Step 3: Edit the schema**

`messages`: add `addressDeadAt: timestamp("address_dead_at", { withTimezone: true })`.
Replace the step-uniqueness index with:

```ts
uniqueIndex("messages_enrollment_step_outbound_unique")
  .on(table.enrollmentId, table.stepIndex)
  .where(sql`${table.direction} = 'outbound' and ${table.addressDeadAt} is null`),
index("messages_address_dead_at_idx").on(table.addressDeadAt),
```

`emailCandidates`: add the five columns above, plus
`check("email_candidates_ladder_rank_check", sql\`${table.ladderRank} >= 1\`)`,
`check("email_candidates_dead_message_check", sql\`${table.deadMessageId} is null or ${table.deadAt} is not null\`)`,
and `index("email_candidates_pattern_dead_idx").on(table.pattern, table.deadAt)`.
`deadMessageId`references`messages.id`with`onDelete: "set null"`.

`operatorSendingSettings`: add the seven ladder columns with the defaults from
_Global Constraints_, and one check constraint bounding all of them
(`max_rungs >= 1`, advances `>= 0`, both percentages between 1 and 100,
`minimum_sends >= 1`, `demotion_minimum_people >= 2`).

`emailResolutionReason`: append `"ladder_exhausted"`, `"ladder_limit_reached"`,
`"address_suppressed"`.

- [ ] **Step 4: Generate and apply the migration**

```bash
npm run db:generate
npm run db:migrate
npm run db:check
```

Read the generated SQL and confirm it does not use a new enum value in the same
statement batch that adds it.

- [ ] **Step 5: Run the integration suite**

`npm run test:integration -- tests/integration/relational-integrity.test.ts tests/integration/populated-migrations.test.ts`
Expected: PASS.

---

### Task 2: The pure ladder rules

**Files:**

- Create: `src/modules/email-resolution/ladder.ts`
- Test: `tests/unit/address-ladder.test.ts`

**Interfaces produced:**

```ts
export const LADDER_FAILURE_WINDOW_MS: number; // 30 days

export type LadderRungInput = {
  normalizedEmail: string;
  pattern: string | null;
  confidence: number;
  /** Position in the evidence ordering `inferEmailPatterns` returned. */
  evidenceOrder: number;
};
export function rankLadderRungs(
  rungs: LadderRungInput[],
  demotedPatterns: ReadonlySet<string>,
): Array<LadderRungInput & { ladderRank: number; tiedWithNeighbour: boolean }>;

export type LadderRungState = {
  normalizedEmail: string;
  ladderRank: number;
  firstAttemptedAt: Date | null;
  deadAt: Date | null;
  suppressed: boolean;
};
export type NextRung =
  | { kind: "rung"; normalizedEmail: string; ladderRank: number }
  | {
      kind: "none";
      reason: "rung_ceiling" | "all_remaining_suppressed" | "no_remaining_rung";
    };
export function chooseNextRung(input: {
  rungs: LadderRungState[];
  maxRungs: number;
}): NextRung;

export function isConventionDemoted(input: {
  peopleProvenDead: number;
  peopleAttempted: number;
  minimumPeople: number;
  failureSharePercent: number;
}): boolean;

export function isLadderCircuitOpen(input: {
  sendsAttempted: number;
  sendsProvenDead: number;
  thresholdPercent: number;
  minimumSends: number;
}): boolean;
```

- [ ] **Step 1: Write the failing unit tests**

```ts
describe("rankLadderRungs", () => {
  it("orders by confidence, then by the evidence ordering, never alphabetically", () => {
    const ranked = rankLadderRungs(
      [
        {
          normalizedEmail: "z.a@acme.test",
          pattern: "flast",
          confidence: 0.9,
          evidenceOrder: 1,
        },
        {
          normalizedEmail: "a.z@acme.test",
          pattern: "first.last",
          confidence: 0.9,
          evidenceOrder: 0,
        },
      ],
      new Set(),
    );
    expect(ranked.map((rung) => rung.normalizedEmail)).toEqual([
      "a.z@acme.test",
      "z.a@acme.test",
    ]);
    expect(ranked.map((rung) => rung.ladderRank)).toEqual([1, 2]);
    expect(ranked.every((rung) => rung.tiedWithNeighbour)).toBe(true);
  });

  it("puts a demoted convention behind a better-evidenced one it outranked", () => {
    const ranked = rankLadderRungs(
      [
        {
          normalizedEmail: "best@acme.test",
          pattern: "first.last",
          confidence: 0.97,
          evidenceOrder: 0,
        },
        {
          normalizedEmail: "weak@acme.test",
          pattern: "flast",
          confidence: 0.75,
          evidenceOrder: 1,
        },
      ],
      new Set(["first.last"]),
    );
    expect(ranked.map((rung) => rung.normalizedEmail)).toEqual([
      "weak@acme.test",
      "best@acme.test",
    ]);
  });

  it("does not mark a strictly better-evidenced rung as tied", () => {
    const ranked = rankLadderRungs(
      [
        {
          normalizedEmail: "a@acme.test",
          pattern: "first.last",
          confidence: 0.97,
          evidenceOrder: 0,
        },
        {
          normalizedEmail: "b@acme.test",
          pattern: "flast",
          confidence: 0.75,
          evidenceOrder: 1,
        },
      ],
      new Set(),
    );
    expect(ranked.map((rung) => rung.tiedWithNeighbour)).toEqual([
      false,
      false,
    ]);
  });
});

describe("chooseNextRung", () => {
  const rung = (
    over: Partial<LadderRungState> & {
      normalizedEmail: string;
      ladderRank: number;
    },
  ): LadderRungState => ({
    firstAttemptedAt: null,
    deadAt: null,
    suppressed: false,
    ...over,
  });

  it("returns the lowest-ranked rung that was never attempted", () => {
    expect(
      chooseNextRung({
        rungs: [
          rung({
            normalizedEmail: "one@a.test",
            ladderRank: 1,
            firstAttemptedAt: new Date(),
            deadAt: new Date(),
          }),
          rung({ normalizedEmail: "two@a.test", ladderRank: 2 }),
          rung({ normalizedEmail: "three@a.test", ladderRank: 3 }),
        ],
        maxRungs: 3,
      }),
    ).toEqual({ kind: "rung", normalizedEmail: "two@a.test", ladderRank: 2 });
  });

  it("counts the ceiling in addresses attempted, not advances taken", () => {
    expect(
      chooseNextRung({
        rungs: [
          rung({
            normalizedEmail: "one@a.test",
            ladderRank: 1,
            firstAttemptedAt: new Date(),
            deadAt: new Date(),
          }),
          rung({
            normalizedEmail: "two@a.test",
            ladderRank: 2,
            firstAttemptedAt: new Date(),
            deadAt: new Date(),
          }),
          rung({ normalizedEmail: "three@a.test", ladderRank: 3 }),
        ],
        maxRungs: 2,
      }),
    ).toEqual({ kind: "none", reason: "rung_ceiling" });
  });

  it("distinguishes an exhausted ladder from one blocked by a suppression", () => {
    expect(
      chooseNextRung({
        rungs: [
          rung({
            normalizedEmail: "one@a.test",
            ladderRank: 1,
            firstAttemptedAt: new Date(),
            deadAt: new Date(),
          }),
        ],
        maxRungs: 3,
      }),
    ).toEqual({ kind: "none", reason: "no_remaining_rung" });
    expect(
      chooseNextRung({
        rungs: [
          rung({
            normalizedEmail: "one@a.test",
            ladderRank: 1,
            firstAttemptedAt: new Date(),
            deadAt: new Date(),
          }),
          rung({
            normalizedEmail: "two@a.test",
            ladderRank: 2,
            suppressed: true,
          }),
        ],
        maxRungs: 3,
      }),
    ).toEqual({ kind: "none", reason: "all_remaining_suppressed" });
  });
});

describe("isConventionDemoted", () => {
  it("never demotes on one person, whatever the share", () => {
    expect(
      isConventionDemoted({
        peopleProvenDead: 1,
        peopleAttempted: 1,
        minimumPeople: 2,
        failureSharePercent: 50,
      }),
    ).toBe(false);
  });

  it("does not demote a correct convention at a company with stale contact data", () => {
    expect(
      isConventionDemoted({
        peopleProvenDead: 3,
        peopleAttempted: 10,
        minimumPeople: 2,
        failureSharePercent: 50,
      }),
    ).toBe(false);
  });

  it("demotes a convention that fails for most of the people it was tried on", () => {
    expect(
      isConventionDemoted({
        peopleProvenDead: 3,
        peopleAttempted: 4,
        minimumPeople: 2,
        failureSharePercent: 50,
      }),
    ).toBe(true);
  });
});

describe("isLadderCircuitOpen", () => {
  it("stays closed below the minimum sample, however bad the share", () => {
    expect(
      isLadderCircuitOpen({
        sendsAttempted: 1,
        sendsProvenDead: 1,
        thresholdPercent: 30,
        minimumSends: 20,
      }),
    ).toBe(false);
  });

  it("opens once an adequate sample exceeds the threshold", () => {
    expect(
      isLadderCircuitOpen({
        sendsAttempted: 20,
        sendsProvenDead: 6,
        thresholdPercent: 30,
        minimumSends: 20,
      }),
    ).toBe(true);
    expect(
      isLadderCircuitOpen({
        sendsAttempted: 20,
        sendsProvenDead: 5,
        thresholdPercent: 30,
        minimumSends: 20,
      }),
    ).toBe(false);
  });
});
```

- [ ] **Step 2: Run and watch fail**

`npm run test -- tests/unit/address-ladder.test.ts` — module not found.

- [ ] **Step 3: Implement `ladder.ts`**

Ranking: sort by `(demoted ? 1 : 0)` ascending, then `confidence` descending,
then `evidenceOrder` ascending, then `normalizedEmail` ascending. Assign
`ladderRank` from 1. `tiedWithNeighbour` is true when an adjacent rung shares
both the demotion flag and the confidence.

`chooseNextRung`, `isConventionDemoted` (`peopleProvenDead >= minimumPeople &&
peopleProvenDead * 100 >= peopleAttempted * failureSharePercent`), and
`isLadderCircuitOpen` (`sendsAttempted >= minimumSends && sendsProvenDead * 100

> = sendsAttempted * thresholdPercent`) as specified. Integer arithmetic, no
> floating-point comparisons.

- [ ] **Step 4: Run and watch pass**

`npm run test -- tests/unit/address-ladder.test.ts`

---

### Task 3: Resolution builds a ranked ladder

**Files:**

- Modify: `src/modules/email-resolution/service.ts`
- Test: `tests/unit/email-resolution.test.ts` (extend)

**Interfaces consumed:** Task 2's `rankLadderRungs`, `chooseNextRung`.
**Interfaces produced:** every persisted candidate carries `ladderRank`;
resolution accepts rank 1 among usable rungs; no `candidate_conflict` from a tie.

- [ ] **Step 1: Write the failing tests**

Four behaviours, in `tests/unit/email-resolution.test.ts`:

1. Two conventions with equal sample counts resolve rather than refusing, the
   accepted address is the one the pattern prior ranks first, and both rows carry
   `ladderRank` 1 and 2.
2. An address already in `suppression_entries` is persisted as a candidate but
   never accepted; the next usable rung is accepted instead.
3. Every rung suppressed leaves the contact `unresolved` with reason
   `address_suppressed`.
4. A contact whose accepted candidate has `firstAttemptedAt` set and `deadAt`
   null keeps that accepted address when resolution runs again, even if new
   evidence would rank a different address first.

- [ ] **Step 2: Run and watch them fail**

`npm run test -- tests/unit/email-resolution.test.ts`

- [ ] **Step 3: Implement**

In `resolveContactEmail`:

- Carry the `inferEmailPatterns` index into each candidate as `evidenceOrder`;
  enrichment candidates take an index after every pattern.
- Read the account's demoted conventions (Task 8's `readDemotedConventions`,
  called with the transaction) and the suppression entries matching the generated
  addresses, then call `rankLadderRungs` and persist `ladderRank`.
- Delete the `contested` computation and the `candidate_conflict` status it
  produced. Keep `candidate_conflict` for the surviving case: the accepted
  address belongs to another contact (the global `normalized_email` uniqueness).
- Acceptance walks ranks in order and skips suppressed addresses. With no usable
  rung above the threshold, the status is `manual_review`/`unresolved` with the
  most specific reason: `address_suppressed` when suppression is what removed
  every usable rung, otherwise the existing `insufficient_public_evidence` /
  `low_confidence`.
- Before replacing the accepted candidate, check for an accepted candidate with
  `firstAttemptedAt` not null and `deadAt` null. If there is one, persist the new
  candidates and leave acceptance alone: that address may have reached the person,
  and moving it would both make the live message unsendable and risk a second
  address for one human.

- [ ] **Step 4: Run the unit and integration suites**

```bash
npm run test -- tests/unit/email-resolution.test.ts
npm run test:integration -- tests/integration/research-and-resolution.test.ts
```

---

### Task 4: A send records the attempt on its rung

**Files:**

- Modify: `src/modules/messages/send-service.ts`
- Test: `tests/integration/send-visibility.test.ts` (extend)

**Interfaces produced:** `email_candidates.first_attempted_at` is stamped
whenever a send attempt is durably reserved; `stepAlreadySent` ignores dead
messages.

- [ ] **Step 1: Write the failing test**

An approved message that is sent stamps `first_attempted_at` on the candidate
matching its recipient, and a second send of a _different_ message at the same
step is blocked by `STEP_ALREADY_SENT` only while the first is not dead.

- [ ] **Step 2: Run and watch fail**

- [ ] **Step 3: Implement**

In the final policy transaction, beside `attemptCount: 1, sendAttemptedAt`:

```ts
await tx
  .update(emailCandidates)
  .set({ firstAttemptedAt: finalNow })
  .where(
    and(
      eq(emailCandidates.normalizedEmail, context.message.recipient),
      isNull(emailCandidates.firstAttemptedAt),
    ),
  );
```

`normalized_email` is globally unique, so this addresses exactly one row; the
`isNull` guard keeps it the _first_ attempt. In `evaluateStoredSendPolicy`, add
`isNull(messages.addressDeadAt)` to the `alreadySent` query.

- [ ] **Step 4: Run**

`npm run test:integration -- tests/integration/send-visibility.test.ts tests/integration/scheduled-send.test.ts`

---

### Task 5: The advance itself, from an inbound hard bounce

**Files:**

- Create: `src/modules/email-resolution/ladder-service.ts`
- Modify: `src/modules/replies/inbound-service.ts`
- Test: `tests/integration/address-ladder.test.ts`

**Interfaces produced:**

```ts
export type LadderStopReason =
  | "feature_disabled"
  | "circuit_open"
  | "account_daily_cap"
  | "rung_ceiling"
  | "no_remaining_rung"
  | "all_remaining_suppressed"
  | "undelivered_send_outstanding"
  | "employment_changed";

export type LadderAdvanceOutcome =
  | {
      kind: "advanced";
      stepIndex: number;
      normalizedEmail: string;
      ladderRank: number;
    }
  | { kind: "not_advanced"; reason: LadderStopReason };

export async function advanceAddressLadder(
  tx: Transaction,
  input: { messageId: string; now: Date; actor: string },
): Promise<LadderAdvanceOutcome>;
```

- [ ] **Step 1: Write the failing integration tests**

```
- a hard bounce on rung 1 keeps the suppression, marks the message and the
  candidate dead, accepts rung 2, leaves the enrollment non-terminal at the dead
  message's step with no schedule, and queues a generation for that step
- the re-addressed message is generated to rung 2 and appears for review
- a hard bounce with no rung 2 stops the enrollment exactly as today (state
  `bounced`, stop reason `hard_bounce`) and leaves the contact `unresolved` with
  reason `ladder_exhausted`
- an enrollment holding a `delivery_uncertain` message at an earlier step does
  not advance: reason `undelivered_send_outstanding`
- a rejected proposal that never left does not block an advance
- the rung ceiling, the disabled feature and an open circuit each refuse with
  their own reason and leave the contact reason `ladder_limit_reached`
- a contact whose employment version moved since the dead message does not
  advance
- the reply row records `terminatesSequence: false` when the ladder advanced
- `soft` bounces are untouched by any of this
```

- [ ] **Step 2: Run and watch fail**

`npm run test:integration -- tests/integration/address-ladder.test.ts`

- [ ] **Step 3: Implement `advanceAddressLadder`**

Transaction-scoped, and the caller already holds the enrollment row lock. In
order:

1. Load the message, its enrollment, the contact, the account, and the settings
   row. Return `employment_changed` when the message's `contactAccountId` /
   `employmentVersion` no longer match the contact.
2. Stamp `messages.address_dead_at = now` on this message — always, before any
   decision, because the circuit breaker and the per-convention counters are
   measured from it.
3. Mark the candidate whose `normalized_email` equals the message recipient:
   `deadAt = now`, `deadMessageId = message.id`, `status = 'rejected'`.
4. Evaluate demotion for `(accountId, candidate.pattern)` and, when it newly
   holds, call `applyConventionDemotion` (Task 8).
5. Refuse — `undelivered_send_outstanding` — if any other outbound message on
   this enrollment has `sendAttemptedAt` not null (or status `sent` /
   `delivery_uncertain`) and `address_dead_at` null.
6. Refuse `feature_disabled`, then `circuit_open` (`isLadderCircuitOpen` over the
   30-day window), then `account_daily_cap` (candidates of this account's
   contacts with `advanced_at >= now - 24h`).
7. `chooseNextRung` over this contact's candidates, with `suppressed` computed
   from `suppression_entries` for both scopes.
8. On a rung: accept it (`status = 'accepted'`, `advancedAt = now`); reset the
   enrollment to `state: "manual_review"`, `currentStep: message.stepIndex`,
   null schedule and claim, null `stopReason`/`stoppedAt`, cleared inbound-hold
   columns, and `lastMessageAt` recomputed from the newest _live_ sent message
   (null when there is none); insert the `operator_commands` row for
   `generate-message` with dedupe key
   `enrollment:<id>:generate:<step>:rung:<rank>`; write a `state_transitions` row
   `address_ladder_advanced` and a `workflow_events` row
   `address_ladder.advanced`.
9. On no rung: leave the terminal handling to the caller, set the contact
   `emailResolutionStatus = 'unresolved'` with reason `ladder_exhausted` for
   `no_remaining_rung`/`all_remaining_suppressed` and `ladder_limit_reached`
   otherwise, and write `workflow_events` `address_ladder.exhausted` carrying the
   precise reason.

- [ ] **Step 4: Wire it into `inbound-service`**

Inside the final transaction, after `outcome` is computed and before the reply is
inserted: when `classification.category === "bounce"`, `input.bounceKind ===
"hard"` and `matched.message` exists, lock the enrollment and call
`advanceAddressLadder`. Then

```ts
const advanced = ladder?.kind === "advanced";
const effectiveOutcome = advanced
  ? {
      ...outcome,
      state: "manual_review" as const,
      stopReason: null,
      terminal: false,
    }
  : outcome;
```

and use `effectiveOutcome` for `terminatesSequence` and for the enrollment
update. The advanced branch must not go through the terminal update at all — the
ladder already wrote the enrollment — so skip the enrollment write when
`advanced`, and keep the suppression insert below exactly as it is.

- [ ] **Step 5: Run**

```bash
npm run test:integration -- tests/integration/address-ladder.test.ts
npm run test:integration -- tests/integration/lifecycle.test.ts tests/integration/inbound-downtime-recovery.test.ts
```

---

### Task 6: The advance from a hard SMTP refusal

**Files:**

- Modify: `src/modules/messages/send-service.ts` (`markPermanentlyRejected`)
- Test: `tests/integration/address-ladder.test.ts` (extend)

- [ ] **Step 1: Write the failing test**

A `rejected` reconciliation carrying `hardBounce: true` advances the ladder, and
one carrying `hardBounce: false` does not mark anything dead — the message stays
`failed` and keeps occupying its step.

- [ ] **Step 2: Run and watch fail**

- [ ] **Step 3: Implement**

In `markPermanentlyRejected`, when `rejection.hardBounce` and the enrollment is
non-terminal, call `advanceAddressLadder` after the suppression insert and skip
the terminal enrollment update when it advanced. When it did not advance, keep
today's exact behaviour.

- [ ] **Step 4: Run**

`npm run test:integration -- tests/integration/address-ladder.test.ts tests/integration/send-reliability.test.ts`

---

### Task 7: A dead message occupies nothing

**Files:**

- Modify: `src/modules/messages/generation-service.ts`,
  `src/modules/workflows/follow-up-service.ts`
- Test: `tests/integration/address-ladder.test.ts` (extend)

- [ ] **Step 1: Write the failing test — this is the bug the design review found**

```
- generating the same step after an advance creates a NEW message addressed to
  rung 2, rather than returning the dead one as "existing"
- a follow-up after a rung-2 send addresses rung 2, not the dead rung-1 address
  (today's join would pick either row and a dead pick stops the enrollment as
  `recipient_suppressed`)
- `findDueEnrollments` treats a step whose only message is dead as having none
```

- [ ] **Step 2: Run and watch fail**

- [ ] **Step 3: Implement**

- `generation-service.ts`: add `isNull(messages.addressDeadAt)` to the `existing`
  lookup.
- `follow-up-service.ts`: add `isNull(messages.addressDeadAt)` to the previous-step
  `innerJoin` on `messages`, and order it by `sentAt desc` so the join is
  deterministic rather than incidentally single-rowed.
- `findDueEnrollments`: add `and due_message.address_dead_at is null` to the
  `not exists` sub-select.

- [ ] **Step 4: Run**

```bash
npm run test:integration -- tests/integration/address-ladder.test.ts tests/integration/enrollment-generation.test.ts tests/integration/outbound-today.test.ts
```

---

### Task 8: Demotion

**Files:**

- Modify: `src/modules/email-resolution/ladder-service.ts`
- Test: `tests/integration/address-ladder.test.ts` (extend)

**Interfaces produced:**

```ts
export async function readDemotedConventions(
  db: Queryable,
  input: {
    accountId: string;
    minimumPeople: number;
    failureSharePercent: number;
  },
): Promise<Set<string>>;

export async function applyConventionDemotion(
  tx: Transaction,
  input: {
    accountId: string;
    now: Date;
    minimumPeople: number;
    failureSharePercent: number;
  },
): Promise<{ rerankedContactIds: string[] }>;
```

- [ ] **Step 1: Write the failing tests**

```
- two people proven dead on `first.last` at one company, out of two attempts,
  demotes it: a third contact of that company, with no outbound message at all,
  has its accepted candidate switched to the non-demoted convention and its ranks
  rewritten
- a contact of the same company who already has a generated message keeps the
  demoted address (its ranks may be rewritten; its acceptance is not)
- a contact whose only candidate uses the demoted convention keeps it: demotion
  reorders and never removes
- a company where 3 of 10 attempts on one convention died does not demote it
```

- [ ] **Step 2: Run and watch fail**

- [ ] **Step 3: Implement**

`readDemotedConventions` groups this account's candidates by `pattern`, counting
distinct contacts with `first_attempted_at` not null and distinct contacts with
`dead_at` not null, then applies `isConventionDemoted`. Null patterns are
excluded — an enrichment address is not a convention.

`applyConventionDemotion` recomputes the demoted set, then for each contact of
the account with **no outbound message at all** re-ranks its candidates with
`rankLadderRungs` and, when the accepted candidate's convention is demoted and a
usable non-demoted rung exists, moves acceptance to it (rejecting the old one,
leaving `advanced_at` null — this is a re-rank, not a ladder advance) and writes a
`state_transitions` row `address_convention_demoted`.

- [ ] **Step 4: Run**

`npm run test:integration -- tests/integration/address-ladder.test.ts`

---

### Task 9: Ladder settings

**Files:**

- Modify: `src/modules/settings/service.ts`, `src/app/api/operator/commands/[command]/route.ts`,
  `src/app/(operator)/settings/page.tsx`
- Test: `tests/unit/settings.test.ts` or the existing settings coverage

- [ ] **Step 1: Write the failing test**

The update schema accepts and persists each of the seven ladder fields, refuses a
failure-rate percentage of 0 or 101, and refuses fewer than two demotion people.

- [ ] **Step 2: Run and watch fail**

- [ ] **Step 3: Implement**

Add the fields to `CONSERVATIVE_SENDING_DEFAULTS` and `updateSchema` with the
bounds from _Global Constraints_, read them in the `update-settings` command, and
render them in a **Address ladder** fieldset on `/settings` — each bound beside
the number it is compared against, taking the measured failure share from Task 12's
`readAddressLadderMetrics` so the baseline the spec demands accumulates in view.

- [ ] **Step 4: Run**

`npm run test -- tests/unit` and `npm run test:integration -- tests/integration/relational-integrity.test.ts`

---

### Task 10: The queue observes AI turns instead of predicting them

**Files:**

- Modify: `src/modules/workflows/operator-command-queue.ts`,
  `src/modules/workflows/operator-command-preconditions.ts`
- Test: `tests/integration/operator-command-queue.test.ts` (extend)

**Interfaces produced:** `PreparedCommand` loses `usesAi`;
`commandTakesAiTurn` is deleted. `AI_WORKFLOW_TASKS` stays — it is the data
behind the "no request handler runs an AI task" invariant test and is imported by
the client-provider boundary test.

- [ ] **Step 1: Write the failing test**

Two queued `resolve-email` commands for two contacts of one company, with a
recorded public-address search that both will reuse, drain **in a single pass**.
Under today's prediction the first breaks the pass and the second is left behind.

- [ ] **Step 2: Run and watch fail**

`npm run test:integration -- tests/integration/operator-command-queue.test.ts`

- [ ] **Step 3: Implement**

In `drainOperatorCommands`, replace `if (prepared.usesAi) break;` with an
observation taken after the work:

```ts
// Whether this command reached the AI surface, observed rather than predicted.
// A turn on the operator's single ChatGPT window always writes an `agent_runs`
// row before the provider is called, so a row created since this claim is the
// only honest answer — and it is the right answer for the three cases a
// per-task guess got wrong: a resolution that reused a recorded company search,
// account research that reused a fresh snapshot, and a deterministic
// generation. This bound therefore depends on every AI path calling
// `startAgentRun` before its provider call. Failing the other way is benign:
// a false positive costs one command a minute's wait.
const [spentTurn] = await db
  .select({ id: agentRuns.id })
  .from(agentRuns)
  .where(gte(agentRuns.createdAt, claimedAt))
  .limit(1);
if (spentTurn) break;
```

where `claimedAt` is the instant passed to `claimNextCommand`. Delete
`commandTakesAiTurn` and the `usesAi` field, and the now-unused import of
`AI_WORKFLOW_TASKS` from the preconditions module.

- [ ] **Step 4: Run**

```bash
npm run test:integration -- tests/integration/operator-command-queue.test.ts tests/integration/operator-command-kick.test.ts tests/integration/maintenance-cycle.test.ts
npm run test -- tests/unit/operator-command-policy.test.ts tests/unit/client-provider-boundary.test.ts
```

---

### Task 11: Resolving a company's addresses in one action

**Files:**

- Create: `src/modules/email-resolution/account-resolution.ts`
- Modify: `src/app/api/operator/commands/[command]/route.ts`,
  `src/app/(operator)/prospects/page.tsx`,
  `src/app/(operator)/prospects/[contactId]/page.tsx`
- Test: `tests/integration/account-email-resolution.test.ts`

**Interfaces produced:**

```ts
export async function findAccountContactsNeedingResolution(
  db: AppDatabase,
  input: { accountId: string; includeResolved?: boolean },
): Promise<Array<{ contactId: string }>>;
```

- [ ] **Step 1: Write the failing test**

Three contacts at one company, resolved through the queue, produce **exactly one**
`public_email_evidence` agent run and three accepted addresses. Force re-search
applies to the first queued contact only, so a ten-contact company can never
spend ten searches.

- [ ] **Step 2: Run and watch fail**

- [ ] **Step 3: Implement**

`findAccountContactsNeedingResolution` selects the account's contacts ordered by
`createdAt`: by default those whose `emailResolutionStatus <> 'resolved'`; with
`includeResolved`, every contact that has no accepted candidate with
`first_attempted_at` set and `dead_at` null — a contact already written to must
not have its address moved.

Route command `resolve-account-emails`: read the eligible contacts, enqueue one
`resolve-email` command each with dedupe key
`ui:account-email-resolution:<accountId>:<requestToken>:<contactId>`, set
`forcePublicSearch` on the first only, call `askForMaintenanceNow()`, and return a
notice naming the count and saying one company search covers all of them.

`/prospects`: on each company row, a primary **Resolve addresses (N)** button
with the count of eligible contacts, and the force checkbox. `/prospects/[id]`:
the same action beside the per-contact one, and demote the per-contact button to
secondary — it survives for the exception, not as the normal path.

- [ ] **Step 4: Run**

```bash
npm run test:integration -- tests/integration/account-email-resolution.test.ts
npm run test:e2e
```

---

### Task 12: What the operator can see

**Files:**

- Modify: `src/modules/email-resolution/ladder-service.ts`,
  `src/modules/presentation/status.ts`,
  `src/app/(operator)/prospects/[contactId]/page.tsx`,
  `src/app/(operator)/review/page.tsx`,
  `src/app/(operator)/outbound/page.tsx`
- Test: `tests/integration/address-ladder.test.ts` (extend), `tests/e2e/operator-ui-browser.spec.ts`

**Interfaces produced:**

```ts
export type ConventionOutcome = {
  pattern: string;
  peopleAttempted: number;
  peopleProvenDead: number;
  peopleNoSignal: number;
  demoted: boolean;
};
export async function readConventionOutcomes(
  db: AppDatabase,
  input?: { accountId?: string },
): Promise<ConventionOutcome[]>;

export type AddressLadderMetrics = {
  onFirstRung: number;
  advanced: number;
  exhausted: number;
  limited: number;
  sendsAttempted: number;
  sendsProvenDead: number;
  sendsNoSignal: number;
  failureSharePercent: number;
  circuitOpen: boolean;
};
export async function readAddressLadderMetrics(
  db: AppDatabase,
  input: { now: Date },
): Promise<AddressLadderMetrics>;
```

- [ ] **Step 1: Write the failing test**

`readConventionOutcomes` splits attempted sends into proven-dead and no-signal per
convention and never counts a delivery as a confirmation.
`readAddressLadderMetrics` counts contacts on rung one, advanced, exhausted and
limited, and reports the circuit state.

- [ ] **Step 2: Run and watch fail**

- [ ] **Step 3: Implement**

Add the two read models. Add sentences to `RESOLUTION_REASONS`:

```ts
ladder_exhausted: "every evidenced address for this person has been tried and proven dead",
ladder_limit_reached: "an address remains, but a ladder bound stopped the attempt",
address_suppressed: "every evidenced address for this person is suppressed",
```

`/prospects/[contactId]`: the Email panel becomes the ladder — rung number, the
address, its convention with its evidence count, confidence, MX, status, and for a
dead rung the date it died and the message that proved it. A **Company address
conventions** block shows each convention found with its evidence count, when the
search happened, whether it was fresh or reused, and its delivery record beside
that.

`/review`: the card names which rung the recipient is, says when the order was a
tie, and says when the convention has since been demoted.

`/outbound`: an **Address ladder** panel with the pipeline counts, the
failure/no-signal split, the per-convention table and the circuit state.

- [ ] **Step 4: Run**

```bash
npm run test:integration -- tests/integration/address-ladder.test.ts
RUN_BROWSER_E2E=1 npm run test:e2e
```

---

### Task 13: Documentation and full validation

**Files:**

- Modify: `README.md`, `docs/superpowers/specs/2026-08-17-company-address-convention-design.md`

- [ ] **Step 1: Document the feature in `README.md`**

In the discovery/resolution section: the company is the unit of resolution; the
ladder and what a rung may be; that only a hard delivery failure advances it and
silence is never a signal; that the suppression is permanent and address-keyed
and a suppressed rung is skipped and said so; the four bounds and their defaults;
that outcome evidence only ever demotes; and the measurements that say whether
the feature earns its risk.

- [ ] **Step 2: Run every gate**

```bash
npm run format:check && npm run lint && npm run typecheck
npm run test && npm run test:integration && npm run eval && npm run build
PLAYWRIGHT_BROWSERS_PATH=/private/tmp/hyperoutreach-playwright npm run test:e2e
```

- [ ] **Step 3: Benchmark the new aggregates**

Time `readAddressLadderMetrics`, `readConventionOutcomes` and the `/prospects`
company query against a populated database, and confirm none of them regresses a
page load. Record the numbers.

---

## Self-Review

**Spec coverage.** Direction: account as the unit → Task 11; ordered ladder →
Tasks 1-3; proven-dead advances → Tasks 5-6. Ladder contents (evidence only,
evidence-count ordering, ties) → Tasks 2-3. Signals (hard only, identity-matched,
silence is not a signal) → Task 5 reuses the existing bounce classification and
adds nothing that reads silence. Learning from delivery outcomes, the confound,
failure-only, what re-ranking may touch → Tasks 4, 8, 12. Enrollment-state
consequences (suppression kept, no step consumed, follow-up timing from the last
non-dead attempt, same terminal state when exhausted, offered not automatic) →
Tasks 5, 7. Operator visibility (company, contact, exhaustion, pipeline) → Task 12. Bounds (rungs, per-company, breaker, emergency pause) → Tasks 5, 9; the pause
is obeyed because an advance originates no send. Interactions: delays → Task 5
(none exempted); tie refusal removed → Task 3; employer moves → Task 5;
review queue → Task 5; confidence vs demotion → Tasks 8, 12 as two quantities;
suppression keying → Task 3 skip + Task 12 sentence; accepted-address history →
Task 12's ladder table. "How we would know it works" → Task 12. Non-goals: none
of the tasks probe SMTP, add a provider, guess an unevidenced address, verify
without sending, or change how the convention is discovered.

**Placeholders.** None: every step names its files, its assertion and its command.

**Type consistency.** `rankLadderRungs`/`chooseNextRung`/`isConventionDemoted`/
`isLadderCircuitOpen` are used in Tasks 3, 5 and 8 under the names Task 2
defines. `advanceAddressLadder` is called with the same `{messageId, now, actor}`
shape from Tasks 5 and 6. `readDemotedConventions` is consumed by Task 3 and
defined in Task 8 — Task 3 must not be finished before Task 8's function exists,
so Task 3 introduces it as a stub returning an empty set and Task 8 fills it in.
Column names are `address_dead_at` on `messages` and `ladder_rank`,
`first_attempted_at`, `dead_at`, `dead_message_id`, `advanced_at` on
`email_candidates` throughout.

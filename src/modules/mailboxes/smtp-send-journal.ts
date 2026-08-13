import { createHash } from "node:crypto";

import { eq } from "drizzle-orm";

import { workflowEvents } from "@/lib/db/schema";
import type { AppDatabase } from "@/lib/db/types";
import type {
  SendJournal,
  SmtpRejectionDetails,
} from "@/modules/mailboxes/smtp-imap-mail-provider";

const ATTEMPT_PREFIX = "smtp-send-attempted";
const ACCEPTANCE_PREFIX = "smtp-accepted";
const REJECTION_PREFIX = "smtp-permanently-rejected";
const ATTEMPT_EVENT = "smtp.send_attempted";
const ACCEPTANCE_EVENT = "smtp.accepted";
const REJECTION_EVENT = "smtp.rejected";
const WORKFLOW_NAME = "smtp_imap_provider";
const ENTITY_TYPE = "smtp_send";

/**
 * Derives a deterministic, RFC-4122-shaped UUID from an arbitrary string
 * key, for `workflow_events.entity_id` — a `NOT NULL uuid` column — when
 * the caller (this journal) has nothing but a `messageKey` and no
 * underlying `messages` row to point at the way
 * `DatabaseMockMailProvider` does (`entityId: message.id`, found via a
 * `messages` lookup this journal has no reason to duplicate: `SendJournal`
 * only ever hands it a string key). Same value for the same key, every
 * process, forever — never random, matching the deterministic-Message-ID
 * rationale the rest of this provider is built on. The idempotency
 * guarantee below comes entirely from `idempotency_key`'s unique index,
 * not from this value, so a hash-derived id is sufficient: nothing here
 * queries `workflow_events` by `entity_id`.
 */
function deterministicUuid(key: string): string {
  const bytes = createHash("sha256").update(key).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50; // version 5 (name-based) nibble
  bytes[8] = (bytes[8]! & 0x3f) | 0x80; // RFC 4122 variant bits
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * `SendJournal` backed by `workflowEvents`, modeled on
 * `DatabaseMockMailProvider.sendDraft`/`reconcile`
 * (`mock-mail-provider.ts:145-194`): `onConflictDoNothing` against the
 * unique `idempotency_key` index is the entire idempotency mechanism — no
 * application-level locking, no read-then-write race, the same pattern
 * already proven there.
 *
 * Two properties are load-bearing for the no-double-send guarantee this
 * journal exists to provide, both called out explicitly because a
 * plausible-looking "simplification" of either one reintroduces a double
 * send:
 *
 * - `hasAcceptance` never swallows a read failure into `false`. A
 *   `catch { return false }` here would misreport "not yet sent" on a
 *   transient DB error and let `sendDraft` submit a second time — the
 *   same defect fixed on `ImapClient.status`/`searchByMessageId` in
 *   Task 7's fix round 1. A failed read here must fail the whole
 *   `sendDraft` call, not silently permit a resend.
 * - `recordAttempt`/`recordAcceptance` run directly against the injected
 *   `AppDatabase` — never inside a `db.transaction(...)` opened by this
 *   class itself — so each `INSERT` is committed the moment its `await`
 *   resolves, never left open for a caller to still roll back.
 *
 * `recordAttempt` additionally reports whether *this* call was the one
 * that created the attempt row (see its own doc) — the TOCTOU-hardening
 * `sendDraft` relies on to refuse a second submit instead of guessing.
 *
 * `recordRejection` is the one exception to the "no internal transaction"
 * rule above, and deliberately so: when it releases the attempt (a `4xx`),
 * the audit-log `INSERT` and the attempt-row `DELETE` must commit or fail
 * together. Split across two independent statements, a crash between them
 * could either release the attempt with no record of why (an unexplained
 * reopened key) or log a rejection that was never actually released (a
 * `4xx` that behaves like a `5xx`) — both are silent corruptions of the
 * audit trail this method exists to create. Wrapping them in one
 * `db.transaction` means a failure rolls back to the pre-rejection state:
 * attempt row still present, no rejection logged — the same safe default
 * as an ambiguous `smtp.submit` failure that never called this method at
 * all.
 */
export class WorkflowEventsSendJournal implements SendJournal {
  constructor(private readonly db: AppDatabase) {}

  async hasAttempt(messageKey: string): Promise<boolean> {
    return this.exists(`${ATTEMPT_PREFIX}:${messageKey}`);
  }

  async hasAcceptance(messageKey: string): Promise<boolean> {
    return this.exists(`${ACCEPTANCE_PREFIX}:${messageKey}`);
  }

  async getPermanentRejection(
    messageKey: string,
  ): Promise<SmtpRejectionDetails | null> {
    const [row] = await this.db
      .select({ payload: workflowEvents.payload })
      .from(workflowEvents)
      .where(
        eq(workflowEvents.idempotencyKey, `${REJECTION_PREFIX}:${messageKey}`),
      )
      .limit(1);
    if (!row) return null;
    const payload = row.payload as Record<string, unknown>;
    return {
      responseCode: Number(payload.responseCode),
      ...(typeof payload.response === "string"
        ? { response: payload.response }
        : {}),
      ...(typeof payload.smtpErrorCode === "string"
        ? { smtpErrorCode: payload.smtpErrorCode }
        : {}),
      releaseAttempt: false,
    };
  }

  /**
   * Returns `true` only when this call is the one that inserted the
   * attempt row — the `onConflictDoNothing` insert's own `returning()`
   * already knows this (an empty result means some other row already held
   * the same `idempotency_key`), so exposing it costs nothing extra.
   * `sendDraft` uses `false` to detect that some other attempt —
   * concurrent, or an earlier crashed run — already exists for this key
   * with no matching acceptance yet, and refuses to submit a second time
   * rather than assume it is safe to retry.
   */
  async recordAttempt(messageKey: string): Promise<boolean> {
    return this.record(messageKey, ATTEMPT_PREFIX, ATTEMPT_EVENT);
  }

  async recordAcceptance(messageKey: string): Promise<void> {
    await this.record(messageKey, ACCEPTANCE_PREFIX, ACCEPTANCE_EVENT);
  }

  /**
   * Logs a definite SMTP rejection and, only when `releaseAttempt` is
   * `true`, deletes the outstanding `smtp-send-attempted:<messageKey>` row
   * so a later `recordAttempt` for the same key can insert a fresh one and
   * report "first attempt" again — see the class doc for why both
   * statements run inside one transaction.
   *
   * The rejection row itself carries no `idempotencyKey` (left `null`,
   * which the partial unique index on that column ignores entirely — see
   * the migration) — unlike `recordAttempt`/`recordAcceptance`, this row is
   * not a mutex, only a permanent audit entry, and a message can be
   * legitimately rejected more than once over its lifetime (e.g.
   * greylisted, retried, greylisted again). It is never read back by this
   * class; `hasAttempt`/`hasAcceptance` only ever look at the attempt and
   * acceptance idempotency keys.
   */
  async recordRejection(
    messageKey: string,
    rejection: SmtpRejectionDetails,
  ): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx
        .insert(workflowEvents)
        .values({
          entityType: ENTITY_TYPE,
          entityId: deterministicUuid(messageKey),
          event: REJECTION_EVENT,
          workflowName: WORKFLOW_NAME,
          idempotencyKey: rejection.releaseAttempt
            ? null
            : `${REJECTION_PREFIX}:${messageKey}`,
          status: "failed",
          completedAt: new Date(),
          error: rejection.response ?? `SMTP ${rejection.responseCode}`,
          payload: {
            messageKey,
            responseCode: rejection.responseCode,
            response: rejection.response ?? null,
            smtpErrorCode: rejection.smtpErrorCode ?? null,
            released: rejection.releaseAttempt,
          },
        })
        .onConflictDoNothing();
      if (rejection.releaseAttempt) {
        await tx
          .delete(workflowEvents)
          .where(
            eq(
              workflowEvents.idempotencyKey,
              `${ATTEMPT_PREFIX}:${messageKey}`,
            ),
          );
      }
    });
  }

  /** Deliberately no `try/catch`: a failed read must propagate, never
   * degrade to `false` (see the class doc). */
  private async exists(idempotencyKey: string): Promise<boolean> {
    const [row] = await this.db
      .select({ id: workflowEvents.id })
      .from(workflowEvents)
      .where(eq(workflowEvents.idempotencyKey, idempotencyKey))
      .limit(1);
    return Boolean(row);
  }

  private async record(
    messageKey: string,
    prefix: string,
    event: string,
  ): Promise<boolean> {
    const idempotencyKey = `${prefix}:${messageKey}`;
    const inserted = await this.db
      .insert(workflowEvents)
      .values({
        entityType: ENTITY_TYPE,
        entityId: deterministicUuid(messageKey),
        event,
        workflowName: WORKFLOW_NAME,
        idempotencyKey,
        status: "succeeded",
        completedAt: new Date(),
        payload: { messageKey },
      })
      .onConflictDoNothing()
      .returning({ id: workflowEvents.id });
    return inserted.length > 0;
  }
}

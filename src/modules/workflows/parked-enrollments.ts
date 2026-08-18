import { and, asc, eq, isNull, sql } from "drizzle-orm";

import { accounts, campaigns, contacts, enrollments } from "@/lib/db/schema";
import type { AppDatabase } from "@/lib/db/types";

export type ParkedEnrollment = {
  enrollmentId: string;
  currentStep: number;
  contactId: string;
  contactName: string;
  accountName: string;
  campaignName: string;
  resolutionReason: string | null;
};

/**
 * Prospects waiting on the operator that no screen would otherwise show.
 *
 * `manual_review` means a human has to act, and the enrollment carries no
 * schedule by design — so if it has no message in the review queue and no
 * command queued to write one, nothing in the system will ever move it again.
 * The address ladder creates these deliberately when a bound it cannot raise
 * stops an advance, and any failure to queue work lands here too. Invisible, a
 * parked prospect is indistinguishable from a forgotten one.
 *
 * Lives here rather than in the page because it states an invariant about the
 * workflow — "nothing will move this" — and an invariant that cannot be tested
 * is one nobody can rely on.
 */
export async function readParkedEnrollments(
  db: AppDatabase,
): Promise<ParkedEnrollment[]> {
  return db
    .select({
      enrollmentId: enrollments.id,
      currentStep: enrollments.currentStep,
      contactId: contacts.id,
      contactName: contacts.fullName,
      accountName: accounts.name,
      campaignName: campaigns.name,
      resolutionReason: contacts.emailResolutionReason,
    })
    .from(enrollments)
    .innerJoin(contacts, eq(contacts.id, enrollments.contactId))
    .innerJoin(accounts, eq(accounts.id, contacts.accountId))
    .innerJoin(campaigns, eq(campaigns.id, enrollments.campaignId))
    .where(
      and(
        eq(enrollments.state, "manual_review"),
        isNull(enrollments.nextActionAt),
        // Written out rather than interpolated: Drizzle renders an interpolated
        // column unqualified inside a raw fragment, and an unqualified `id`
        // binds to the subquery's own table — a correlation that silently
        // compares a row with itself and is always false.
        sql`not exists (
          select 1 from messages waiting_on_review
          where waiting_on_review.enrollment_id = enrollments.id
            and waiting_on_review.direction = 'outbound'
            and waiting_on_review.address_dead_at is null
            and waiting_on_review.status in (
              'proposed', 'approved', 'draft_creating', 'drafted', 'sending'
            ))`,
        sql`not exists (
          select 1 from operator_commands pending_command
          where pending_command.status in ('queued', 'waiting', 'running')
            and pending_command.payload->>'enrollmentId'
              = enrollments.id::text)`,
      ),
    )
    .orderBy(asc(accounts.name), asc(contacts.fullName));
}

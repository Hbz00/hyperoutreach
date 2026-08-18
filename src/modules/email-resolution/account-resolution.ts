import { and, asc, eq, ne, sql } from "drizzle-orm";

import { contacts, emailCandidates } from "@/lib/db/schema";
import type { AppDatabase } from "@/lib/db/types";

/**
 * The contacts of one company whose address the operator is asking for.
 *
 * The convention belongs to the company, so resolving addresses is an action on
 * the company and its contacts inherit the result: the first of these spends one
 * web search and every other reuses it. This function is what turns "resolve
 * this company" into the list of per-contact work, and its order matters — the
 * forced re-search rides on the first row and on no other, so a ten-person
 * company can never spend ten live searches.
 *
 * Two contacts are never offered, in either mode:
 *
 * - one whose accepted address has already been written to and was not proven
 *   dead. They may be holding that message; re-resolving could move the accepted
 *   address, which would make the message unsendable and could end with two
 *   addresses used for one human.
 * - by default, one that is already resolved. `includeResolved` is what a forced
 *   company re-search passes, because new evidence is exactly what should reach a
 *   contact resolved from a weaker draw — as long as nothing has been sent yet.
 */
export async function findAccountContactsNeedingResolution(
  db: AppDatabase,
  input: { accountId: string; includeResolved?: boolean },
): Promise<Array<{ contactId: string }>> {
  const rows = await db
    .select({ contactId: contacts.id })
    .from(contacts)
    .where(
      and(
        eq(contacts.accountId, input.accountId),
        input.includeResolved
          ? undefined
          : ne(contacts.emailResolutionStatus, "resolved"),
        sql`not exists (
          select 1
          from ${emailCandidates} written
          where written.contact_id = ${contacts.id}
            and written.status = 'accepted'
            and written.first_attempted_at is not null
            and written.dead_at is null
        )`,
      ),
    )
    // Stable, and stable across calls: the row that carries the forced search
    // has to be the same one every time or a repeated click spends a second.
    .orderBy(asc(contacts.createdAt), asc(contacts.id));
  return rows;
}

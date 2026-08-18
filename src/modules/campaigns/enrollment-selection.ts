import { and, asc, eq, gte, ilike, sql, type SQL } from "drizzle-orm";

import {
  accounts,
  contacts,
  emailCandidates,
  enrollments,
  mailboxConnections,
  suppressionEntries,
} from "@/lib/db/schema";
import type { AppDatabase } from "@/lib/db/types";
import { enrollContact } from "@/modules/campaigns/service";

/**
 * How many eligible rows the enrollment screen renders.
 *
 * Not pagination, and it deliberately does not pretend to be: the escape hatch
 * is a narrower filter or the button that enrolls every eligible row, which
 * re-derives its own list server-side and is therefore not bounded by this.
 */
export const ENROLLMENT_CANDIDATE_DISPLAY_LIMIT = 100;

/**
 * How many enrollments one request will write.
 *
 * Each is its own transaction, so an unbounded selection would hold a request
 * open for as long as the operator's database takes to write it. The ceiling
 * is reported when it truncates rather than applied in silence.
 */
export const MAXIMUM_ENROLLMENTS_PER_REQUEST = 500;

/**
 * Why a contact with an accepted address is still not offered.
 *
 * The list is deliberately short, and the rule that keeps it short is: exclude
 * only what can never become sendable. Being enrolled here already is
 * structural — the unique constraint makes a second enrollment a no-op. A
 * suppressed address is permanent and global — no amount of waiting turns it
 * into a message that goes out.
 *
 * Anything transient stays out of this list, and that is a deliberate refusal
 * rather than an omission. A prospect running a sequence in another campaign,
 * or one contacted too recently, is a *pacing* question, and pacing belongs to
 * the send policy: it owns `CONTACT_MINIMUM_DELAY` and
 * `RECENT_CONTACT_COOLDOWN`, and it applies them at the moment they can
 * actually be judged. Re-deciding any of that here would put a second, staler
 * copy of a send rule inside a page — and would refuse an operator the
 * ordinary act of queueing somebody for the campaign that comes next.
 *
 * The known cost, stated because it is not yet paid: when such a send is
 * refused, the review card names the reason — but only once the message has
 * been approved, because that is the point at which the queue computes a
 * verdict. So the operator learns about a cooldown later than they should.
 * That gap belongs to the review queue rather than here, and it is not closed
 * by running the send policy for every proposed card: this feature makes
 * `proposed` the dominant status, and that queue is unbounded.
 */
export type EnrollmentIneligibility = "already_enrolled" | "suppressed";

export type EnrollmentFilters = {
  company?: string;
  role?: string;
  minConfidence?: number;
};

export type EnrollmentCandidate = {
  contactId: string;
  fullName: string;
  company: string;
  jobTitle: string | null;
  email: string;
  confidence: number;
  ineligibility: EnrollmentIneligibility | null;
};

/**
 * One value from a query parameter that may legally arrive repeated.
 *
 * `?company=a&company=b` is a valid URL and Next hands it over as an array, so
 * a signature promising `string` is a promise the framework never made. Reading
 * the first entry keeps the page answering: this is a filter, and the worst a
 * duplicated one can honestly do is pick a side.
 */
function single(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Turns a query string into filters, dropping what it cannot read.
 *
 * A filter that cannot be parsed is removed rather than refused. The values
 * arrive from a URL an operator may have edited or a link they may have kept,
 * and a page that answers "invalid confidence" instead of listing prospects
 * turns a typo into a dead end. The same reasoning covers a repeated
 * parameter, which used to throw before the page ever rendered.
 */
export function parseEnrollmentFilters(raw: {
  company?: string | string[];
  role?: string | string[];
  minConfidence?: string | string[];
}): EnrollmentFilters {
  const company = single(raw.company)?.trim();
  const role = single(raw.role)?.trim();
  const rawConfidence = single(raw.minConfidence);
  const confidence = Number(rawConfidence);
  return {
    ...(company ? { company } : {}),
    ...(role ? { role } : {}),
    ...(rawConfidence?.trim() &&
    Number.isFinite(confidence) &&
    confidence >= 0 &&
    confidence <= 1
      ? { minConfidence: confidence }
      : {}),
  };
}

/**
 * Splits one labelled result set into what the screen offers and what it
 * explains.
 *
 * Pure, and fed by the same rows the enrolling action reads, which is the
 * point: the count in the heading and the work the button does come from one
 * query.
 */
export function partitionCandidates(rows: EnrollmentCandidate[]): {
  eligible: EnrollmentCandidate[];
  excluded: Record<EnrollmentIneligibility, number>;
} {
  const excluded: Record<EnrollmentIneligibility, number> = {
    already_enrolled: 0,
    suppressed: 0,
  };
  const eligible: EnrollmentCandidate[] = [];
  for (const row of rows) {
    if (row.ineligibility) excluded[row.ineligibility] += 1;
    else eligible.push(row);
  }
  return { eligible, excluded };
}

/**
 * Escapes what LIKE would otherwise read as a wildcard.
 *
 * An operator typing "100%" into the company box means the characters, not
 * "anything at all" — and a filter that silently widens is worse than one that
 * finds nothing, because the operator acts on the result. Backslash is in the
 * class because it is PostgreSQL's own LIKE escape character, so a literal one
 * has to be doubled; the single pass reads the original string throughout, so
 * no replacement can be escaped twice.
 */
function likePattern(value: string): string {
  return `%${value.replace(/[\\%_]/g, (character) => `\\${character}`)}%`;
}

/**
 * Every contact with an accepted address that matches the filter, each labelled
 * with the reason it is not offered — or null when it is.
 *
 * One statement rather than a list query beside three count queries, because
 * the screen's heading and the enrolling action must never be able to disagree:
 * they read this, and the action re-reads it rather than trusting what came
 * back from the browser.
 *
 * The two `case` arms are ordered, and the order is the precedence. Already
 * being enrolled *here* comes first, because it is the answer to the question
 * this screen is asking — can I tick this person for this campaign — and the
 * enrollments table below names the rest.
 */
export async function readEnrollmentCandidates(
  db: AppDatabase,
  input: { campaignId: string; filters: EnrollmentFilters },
): Promise<EnrollmentCandidate[]> {
  const alreadyEnrolled = sql`exists (
    select 1 from ${enrollments}
    where ${enrollments.contactId} = ${contacts.id}
      and ${enrollments.campaignId} = ${input.campaignId}::uuid
  )`;
  // The same two scopes the send policy checks, read the same way, so a
  // prospect this screen offers is not one the send would refuse.
  const suppressed = sql`exists (
    select 1 from ${suppressionEntries}
    where (${suppressionEntries.scope} = 'email'
            and ${suppressionEntries.normalizedValue} = ${emailCandidates.normalizedEmail})
       or (${suppressionEntries.scope} = 'domain'
            and ${suppressionEntries.normalizedValue}
                = split_part(${emailCandidates.normalizedEmail}, '@', 2))
  )`;

  const conditions: Array<SQL | undefined> = [
    eq(emailCandidates.status, "accepted"),
    input.filters.company
      ? ilike(accounts.name, likePattern(input.filters.company))
      : undefined,
    input.filters.role
      ? ilike(contacts.jobTitle, likePattern(input.filters.role))
      : undefined,
    input.filters.minConfidence !== undefined
      ? gte(emailCandidates.confidence, input.filters.minConfidence.toString())
      : undefined,
  ];

  const rows = await db
    .select({
      contactId: contacts.id,
      fullName: contacts.fullName,
      company: accounts.name,
      jobTitle: contacts.jobTitle,
      email: emailCandidates.normalizedEmail,
      confidence: emailCandidates.confidence,
      ineligibility: sql<EnrollmentIneligibility | null>`case
        when ${alreadyEnrolled} then 'already_enrolled'
        when ${suppressed} then 'suppressed'
        else null
      end`,
    })
    .from(contacts)
    .innerJoin(accounts, eq(accounts.id, contacts.accountId))
    // At most one accepted candidate exists per contact
    // (`email_candidates_one_accepted_per_contact_unique`), so this join
    // selects rather than multiplies.
    .innerJoin(emailCandidates, eq(emailCandidates.contactId, contacts.id))
    .where(and(...conditions))
    .orderBy(asc(accounts.name), asc(contacts.fullName));

  // `confidence` is `numeric` and arrives as a string; the column is NOT NULL,
  // so there is no absent case to carry through the rest of the feature.
  return rows.map((row) => ({ ...row, confidence: Number(row.confidence) }));
}

export type EnrollmentSelectionOutcome = {
  /** Enrollments this request created. */
  enrolled: number;
  /** Asked for, and an enrollment already existed. */
  alreadyEnrolled: number;
  /** Asked for, and not eligible when the server looked. */
  ignored: number;
  /** Eligible, and beyond this request's ceiling. */
  truncated: number;
  /** Attempted, and the write did not succeed. */
  failed: number;
};

export type EnrollmentSelectionResult =
  | ({ ok: true } & EnrollmentSelectionOutcome)
  | {
      ok: false;
      code: "VERSION_NOT_PUBLISHED" | "MAILBOX_UNAVAILABLE";
      message: string;
    };

/**
 * Enrolls a cohort, deciding for itself who is in it.
 *
 * `contactIds` says what the operator asked for and never what is permitted:
 * the eligible set is re-read here, and only its intersection with the request
 * is enrolled. Anything else would make every rule in
 * `readEnrollmentCandidates` advisory — a page rendered before a suppression
 * existed, or a hand-written POST, would walk straight past all of them.
 * Omitting `contactIds` means "every eligible row", which is the second button
 * on the screen and is likewise derived here rather than sent.
 *
 * The loop is one `enrollContact` per contact rather than a single wider
 * transaction, deliberately: that function already owns what an enrollment is,
 * and half a cohort enrolled is a valid state the unique constraint lets the
 * operator finish by pressing the button again.
 */
export async function enrollSelection(
  db: AppDatabase,
  input: {
    campaignId: string;
    campaignVersionId: string;
    mailboxId: string;
    filters: EnrollmentFilters;
    contactIds?: string[];
  },
): Promise<EnrollmentSelectionResult> {
  // The mailbox is re-read here for the same reason the candidates are: the
  // page offered only available ones, and a page is a photograph. A token that
  // expired since it was rendered would otherwise be written onto every row of
  // a large cohort — and `MAILBOX_UNAVAILABLE` is not a transient send block,
  // so each of those messages would be generated, approved, and then refused
  // for good. Checked before anything is written, so the refusal costs nothing.
  const [mailbox] = await db
    .select({ id: mailboxConnections.id })
    .from(mailboxConnections)
    .where(
      and(
        eq(mailboxConnections.id, input.mailboxId),
        eq(mailboxConnections.status, "available"),
      ),
    )
    .limit(1);
  if (!mailbox) {
    return {
      ok: false,
      code: "MAILBOX_UNAVAILABLE",
      message:
        "That mailbox is no longer available to send from — reconnect it in Settings, then enroll again",
    };
  }

  const candidates = await readEnrollmentCandidates(db, {
    campaignId: input.campaignId,
    filters: input.filters,
  });
  const eligible = candidates.filter((row) => row.ineligibility === null);
  const requested = input.contactIds ? new Set(input.contactIds) : null;
  const wanted = requested
    ? eligible.filter((row) => requested.has(row.contactId))
    : eligible;
  /**
   * Asked for, and an enrollment already covers them.
   *
   * Read from the labelled rows rather than from `enrollContact`'s `existing`
   * disposition, which this path almost never reaches: eligibility drops these
   * before the loop, so counting only the disposition would leave a repeated
   * click reported as "no longer eligible" — true, and the least useful of the
   * true things that could be said. The loop still adds to it for the race
   * where somebody is enrolled between the read and the write.
   *
   * Zero when no selection was given: "enroll everything eligible" did not ask
   * for the already-enrolled, and the screen already counts them separately.
   */
  const alreadyEnrolled = requested
    ? candidates.filter(
        (row) =>
          row.ineligibility === "already_enrolled" &&
          requested.has(row.contactId),
      ).length
    : 0;
  const outcome: EnrollmentSelectionOutcome = {
    enrolled: 0,
    alreadyEnrolled,
    // Both a stale identifier and one that was never offered land here, which
    // is the same fact from the server's side: it is not enrolling this. They
    // are deliberately not told apart, because separating them would answer
    // whether a given identifier exists.
    ignored: requested ? requested.size - wanted.length - alreadyEnrolled : 0,
    truncated: Math.max(0, wanted.length - MAXIMUM_ENROLLMENTS_PER_REQUEST),
    failed: 0,
  };

  for (const row of wanted.slice(0, MAXIMUM_ENROLLMENTS_PER_REQUEST)) {
    const result = await enrollContact(db, {
      campaignId: input.campaignId,
      campaignVersionId: input.campaignVersionId,
      contactId: row.contactId,
      mailboxId: input.mailboxId,
    });
    if (!result.ok) {
      // The one refusal that is about the campaign rather than this contact:
      // it will be identical for every remaining row, so reporting it once and
      // stopping beats writing the same failure a hundred times.
      if (result.code === "VERSION_NOT_PUBLISHED") {
        return { ok: false, code: result.code, message: result.message };
      }
      outcome.failed += 1;
      continue;
    }
    if (result.disposition === "created") outcome.enrolled += 1;
    else outcome.alreadyEnrolled += 1;
  }

  return { ok: true, ...outcome };
}

/**
 * The notice, built from the outcome rather than from the intent.
 *
 * Only non-zero facts are said. An operator who selected forty and enrolled
 * thirty-eight needs the two to be named, and an operator whose selection went
 * through cleanly should not have to read four zeroes to find that out.
 */
export function describeEnrollmentSelection(
  outcome: EnrollmentSelectionOutcome,
): string {
  const parts: string[] = [
    outcome.enrolled === 0
      ? "Nothing enrolled"
      : outcome.enrolled === 1
        ? "1 prospect enrolled — their first message is queued"
        : `${outcome.enrolled} prospects enrolled — their first messages are queued`,
  ];
  if (outcome.alreadyEnrolled > 0) {
    parts.push(`${outcome.alreadyEnrolled} already enrolled`);
  }
  if (outcome.ignored > 0) {
    parts.push(`${outcome.ignored} no longer eligible`);
  }
  if (outcome.truncated > 0) {
    parts.push(
      `${outcome.truncated} beyond this request's ceiling of ${MAXIMUM_ENROLLMENTS_PER_REQUEST}, run it again`,
    );
  }
  if (outcome.failed > 0) {
    parts.push(`${outcome.failed} could not be enrolled`);
  }
  return parts.join(" · ");
}

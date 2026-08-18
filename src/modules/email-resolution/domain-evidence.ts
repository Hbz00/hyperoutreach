import { sql, type SQL } from "drizzle-orm";

import { evidenceSources } from "@/lib/db/schema";

/**
 * The `supports` tag an evidence source carries when it ties a domain to a
 * company.
 */
export const DOMAIN_EVIDENCE_SUPPORT = "domain";

/**
 * Whether these evidence rows tie a domain to the company.
 *
 * This is the rule `resolveContactEmail` applies before it will resolve anybody:
 * without such a source it refuses with `domain_not_evidenced`, having spent a
 * queued command per contact to say so. The screens that offer that action read
 * the same rule from here, so an enabled button and a refusal cannot disagree.
 *
 * Deliberately not "has the company been researched": research records whatever
 * `supports` the model declared, so a researched company can still lack the
 * domain tie. Only the tie counts.
 */
export function hasDomainEvidence(
  sources: readonly { supports: string[] }[],
): boolean {
  return sources.some((source) =>
    source.supports.includes(DOMAIN_EVIDENCE_SUPPORT),
  );
}

/**
 * The same question asked of the database, for a list that cannot load every
 * company's evidence rows.
 *
 * Correlated to the outer `accounts` table **by name**, so it belongs only in a
 * query selecting from `accounts` unaliased — the subquery aliases its own copy
 * of `evidence_sources` as `tie` for that reason, and Drizzle qualifies a column
 * inside a `where` fragment but not inside a select projection, where the bare
 * name would bind to the subquery instead.
 *
 * Two forms of one rule is a cost worth naming: `tests/integration/domain-evidence.test.ts`
 * asserts they answer identically over the same rows, which is what keeps this
 * from becoming the third copy it replaced.
 */
export function accountHasDomainEvidence(): SQL<boolean> {
  return sql<boolean>`exists (
    select 1 from ${evidenceSources} tie
    where tie.account_id = accounts.id
      and tie.supports @> ${JSON.stringify([DOMAIN_EVIDENCE_SUPPORT])}::jsonb
  )`;
}

/**
 * What to tell an operator whose company has no evidenced domain.
 *
 * The sentence lives beside the rule rather than in the pages that print it,
 * because it is a promise about what fixes the situation — "account research is
 * what records it" has to stay true if the rule ever changes, and two copies in
 * two pages is how that stops being checked. It also says what *records* the
 * tie rather than promising that researching will produce one, which would be a
 * different and sometimes false claim.
 */
export const DOMAIN_EVIDENCE_BLOCKER =
  "No evidence ties a domain to this company yet. Account research is what records it.";

const NO_CONTACTS_BLOCKER =
  "Discover contacts first — there is nobody to resolve an address for.";

/**
 * Why address resolution cannot run for this company, or null when it can.
 *
 * Takes `hasDomainEvidence` already answered rather than the rows themselves:
 * the company list gets it from `accountHasDomainEvidence()` in one query, and
 * the prospect page from `hasDomainEvidence()` over rows it already holds.
 * Making this function load them would cost the list one query per company.
 */
export function domainEvidenceBlocker(account: {
  domain: string | null;
  hasDomainEvidence: boolean;
}): string | null {
  return !account.domain || !account.hasDomainEvidence
    ? DOMAIN_EVIDENCE_BLOCKER
    : null;
}

/**
 * The company-level version, which has one more way of being unable to start.
 *
 * The contact question is asked first because it is the more useful answer: a
 * company nobody has discovered contacts for has nobody to resolve an address
 * for, whatever its evidence says.
 */
export function addressResolutionBlocker(account: {
  contactCount: number;
  domain: string | null;
  hasDomainEvidence: boolean;
}): string | null {
  if (account.contactCount === 0) return NO_CONTACTS_BLOCKER;
  return domainEvidenceBlocker(account);
}

/**
 * Whether a company's public-address search can be reused for another of its
 * contacts.
 *
 * The searched question is the company's convention, not the person: the model
 * is asked what named addresses exist on a domain, and deterministic code then
 * applies the convention it reveals to one contact's name. Ten colleagues at
 * the same company therefore asked the same question ten times, each spending a
 * web search from a budget that silently runs out.
 *
 * An empty result is never reused, and that is the point of the rule rather
 * than an edge case: the same prompt on the same domain returned zero, then
 * one, then two addresses on three consecutive attempts. Caching "found
 * nothing" would freeze the worst draw of a variable process and quietly retire
 * a company that a second look would have resolved.
 */
export const DEFAULT_PUBLIC_EVIDENCE_TTL_MS = 30 * 24 * 60 * 60 * 1_000;

export function shouldReusePublicEmailEvidence(input: {
  sampleCount: number;
  foundAt: Date | null;
  /** The prompt that produced the record, and the one asking now. */
  recordedPromptVersion: string | null;
  currentPromptVersion: string;
  now: Date;
  ttlMs: number;
  force: boolean;
}): boolean {
  // A record made by an older prompt is not an answer to the current question.
  // Without this, improving the prompt would change nothing for a month on
  // every company already searched — precisely the companies worth improving.
  // Keying on the version also means no future prompt change has to remember
  // to invalidate anything.
  if (input.recordedPromptVersion !== input.currentPromptVersion) return false;
  if (
    input.force ||
    input.sampleCount <= 0 ||
    !input.foundAt ||
    !Number.isFinite(input.ttlMs) ||
    input.ttlMs < 0
  ) {
    return false;
  }
  const age = input.now.getTime() - input.foundAt.getTime();
  return age >= 0 && age <= input.ttlMs;
}

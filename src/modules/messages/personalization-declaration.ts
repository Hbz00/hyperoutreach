import type { PersonalizationDeclaration } from "@/modules/campaigns/input";

/**
 * What a sequence step asks an agent to write, read from the jsonb column that
 * stores it.
 *
 * Three callers need this answer and each needs it for a different reason: the
 * generator, to decide whether to call an agent at all; the command queue, to
 * decide whether draining this row will spend the operator's single ChatGPT
 * window; and the follow-up path, to decide whether it may generate inline or
 * must hand the work to the queue. They were drifting towards three private
 * copies of the same shape check, which is how one of them ends up disagreeing
 * with the others about what "declared" means.
 *
 * Stored configuration is never re-validated through zod — a published version
 * is immutable and was validated when it was written — so this reads
 * defensively and treats anything malformed as "declares nothing", which is
 * the safe direction: it produces a deterministic message instead of an agent
 * call nobody asked for.
 */
export function readPersonalizationDeclaration(
  value: unknown,
): PersonalizationDeclaration | null {
  if (!value || typeof value !== "object") return null;
  const record = value as { fields?: unknown; minConfidence?: unknown };
  if (!Array.isArray(record.fields) || record.fields.length === 0) return null;
  return {
    fields: record.fields as PersonalizationDeclaration["fields"],
    // The default is 0.5 because the in-tree deterministic agent returns
    // exactly that. Raising it is an operator decision, and a test pins the
    // coupling so that raising it cannot happen by accident.
    minConfidence:
      typeof record.minConfidence === "number" ? record.minConfidence : 0.5,
  };
}

/** Whether this step needs an agent turn before a message can be written. */
export function stepDeclaresPersonalization(value: unknown): boolean {
  return readPersonalizationDeclaration(value) !== null;
}

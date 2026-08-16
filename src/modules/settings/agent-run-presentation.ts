/** How long a run took, or that it has not finished. */
export function agentRunDuration(
  startedAt: Date | null,
  completedAt: Date | null,
): string {
  if (!startedAt) return "—";
  if (!completedAt) return "running";
  const seconds = Math.round(
    (completedAt.getTime() - startedAt.getTime()) / 1_000,
  );
  return `${seconds} s`;
}

/**
 * What a run cost, or the honest admission that this surface cannot say.
 *
 * The ChatGPT desktop app reports neither token usage nor cost, and the
 * provider persists `costAvailability: "unavailable"` rather than a zero for
 * exactly that reason. Rendering `$0.00` would turn "we do not know" into
 * "it was free" — a claim nobody made.
 */
export function agentRunCost(
  availability: "available" | "unavailable" | null,
  costUsd: string | null,
): string {
  if (availability !== "available" || costUsd === null) return "unavailable";
  const amount = Number(costUsd);
  return Number.isFinite(amount) ? `$${amount.toFixed(4)}` : "unavailable";
}

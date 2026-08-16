/**
 * Which lane a run belonged to: the model, and the effort that distinguishes
 * one lane from the other.
 *
 * Both lanes run the same model on this transport, so the model alone tells
 * you nothing about whether the run had ten minutes and the web or two minutes
 * and neither — which is the first thing you want when it failed on its
 * deadline. A run with no recorded effort (a mock, or a row written before the
 * column existed) shows the model alone rather than an invented lane.
 */
export function agentRunLane(model: string, effort: string | null): string {
  return effort ? `${model} · ${effort}` : model;
}

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

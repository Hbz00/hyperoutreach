export const DEFAULT_RESEARCH_TTL_MS = 30 * 24 * 60 * 60 * 1_000;

export function shouldReuseResearch(input: {
  snapshot: Record<string, unknown> | null;
  researchedAt: Date | null;
  now: Date;
  ttlMs: number;
  force: boolean;
}): boolean {
  if (
    input.force ||
    !input.snapshot ||
    !input.researchedAt ||
    !Number.isFinite(input.ttlMs) ||
    input.ttlMs < 0
  ) {
    return false;
  }
  const age = input.now.getTime() - input.researchedAt.getTime();
  return age >= 0 && age <= input.ttlMs;
}

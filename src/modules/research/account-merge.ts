export type AccountMergeDecision =
  | { action: "use_existing"; accountId: string }
  | { action: "enrich_fallback"; accountId: string }
  | { action: "create" };

export function decideAccountMerge(input: {
  incomingDomain: string | null;
  strongDomainAccountId: string | null;
  domainlessNameAccountId: string | null;
  sameNameDomainAccountId: string | null;
}): AccountMergeDecision {
  if (input.incomingDomain && input.strongDomainAccountId) {
    return { action: "use_existing", accountId: input.strongDomainAccountId };
  }
  if (input.incomingDomain && input.domainlessNameAccountId) {
    return {
      action: "enrich_fallback",
      accountId: input.domainlessNameAccountId,
    };
  }
  if (!input.incomingDomain && input.domainlessNameAccountId) {
    return { action: "use_existing", accountId: input.domainlessNameAccountId };
  }
  if (!input.incomingDomain && input.sameNameDomainAccountId) {
    return {
      action: "use_existing",
      accountId: input.sameNameDomainAccountId,
    };
  }
  return { action: "create" };
}

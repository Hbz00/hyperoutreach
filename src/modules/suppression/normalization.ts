import {
  normalizeDomain,
  normalizeEmail,
} from "@/modules/prospects/normalization";

export type SuppressionScope = "email" | "domain";

export function normalizeSuppressionTarget(
  scope: SuppressionScope,
  value: string,
): string {
  if (scope === "email") return normalizeEmail(value);
  if (value.includes("@")) throw new Error("Invalid suppression domain");
  return normalizeDomain(value);
}

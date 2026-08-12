import { z } from "zod";

import {
  normalizeCompanyName,
  normalizeDomain,
} from "@/modules/prospects/normalization";

const optionalTrimmedString = z.preprocess(
  (value) => (typeof value === "string" && value.trim() ? value.trim() : null),
  z.string().nullable(),
);

const httpUrl = z.url().refine((value) => {
  const protocol = new URL(value).protocol;
  return protocol === "http:" || protocol === "https:";
}, "URL must use HTTP or HTTPS");

const accountInputSchema = z
  .object({
    name: z.string().trim().min(1).max(300),
    domain: optionalTrimmedString,
    website: optionalTrimmedString.pipe(httpUrl.nullable()),
  })
  .transform((input, context) => {
    try {
      return {
        name: input.name,
        normalizedName: normalizeCompanyName(input.name),
        domain: input.domain ? normalizeDomain(input.domain) : null,
        website: input.website,
      };
    } catch (error) {
      context.addIssue({
        code: "custom",
        message: error instanceof Error ? error.message : "Invalid account",
      });
      return z.NEVER;
    }
  });

export type AccountInput = z.infer<typeof accountInputSchema>;

export function parseAccountInput(value: unknown): AccountInput {
  return accountInputSchema.parse(value);
}

export function resolveAccountIdentity(
  input: AccountInput,
):
  | { kind: "domain"; value: string }
  | { kind: "normalized_name"; value: string } {
  return input.domain
    ? { kind: "domain", value: input.domain }
    : { kind: "normalized_name", value: input.normalizedName };
}

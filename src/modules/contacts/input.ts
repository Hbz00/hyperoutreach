import { z } from "zod";

import { normalizePersonName } from "@/modules/prospects/normalization";

function normalizeLinkedInUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("Invalid LinkedIn URL");
  }
  const hostname = parsed.hostname.toLowerCase().replace(/^www\./, "");
  const pathSegments = parsed.pathname.split("/").filter(Boolean);
  const profileSlug = pathSegments[1]?.toLowerCase();
  if (
    parsed.protocol !== "https:" ||
    hostname !== "linkedin.com" ||
    pathSegments[0]?.toLowerCase() !== "in" ||
    !profileSlug ||
    !/^[a-z0-9_%.-]+$/.test(profileSlug) ||
    parsed.username ||
    parsed.password ||
    parsed.port
  ) {
    throw new Error("Invalid LinkedIn URL");
  }
  return `https://www.linkedin.com/in/${profileSlug}`;
}

const optionalTrimmedString = z.preprocess(
  (value) => (typeof value === "string" && value.trim() ? value.trim() : null),
  z.string().nullable(),
);

const contactInputSchema = z
  .object({
    accountId: z.uuid(),
    firstName: z.string().trim().min(1).max(200),
    lastName: z.string().trim().min(1).max(200),
    jobTitle: optionalTrimmedString,
    linkedinUrl: optionalTrimmedString,
    professionalRelevance: z
      .record(z.string(), z.unknown())
      .nullable()
      .optional(),
  })
  .transform((input, context) => {
    const fullName = `${input.firstName} ${input.lastName}`;
    try {
      return {
        ...input,
        fullName,
        normalizedFullName: normalizePersonName(fullName),
        linkedinUrl: input.linkedinUrl
          ? normalizeLinkedInUrl(input.linkedinUrl)
          : null,
      };
    } catch (error) {
      context.addIssue({
        code: "custom",
        message: error instanceof Error ? error.message : "Invalid contact",
      });
      return z.NEVER;
    }
  });

export type ContactInput = z.infer<typeof contactInputSchema>;

export function parseContactInput(value: unknown): ContactInput {
  return contactInputSchema.parse(value);
}

export function resolveContactIdentity(
  input: ContactInput,
):
  | { kind: "linkedin"; value: string }
  | { kind: "account_name"; accountId: string; normalizedFullName: string } {
  return input.linkedinUrl
    ? { kind: "linkedin", value: input.linkedinUrl }
    : {
        kind: "account_name",
        accountId: input.accountId,
        normalizedFullName: input.normalizedFullName,
      };
}

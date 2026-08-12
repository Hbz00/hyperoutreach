import { z } from "zod";

const nullableString = z.string().trim().min(1).max(1_000).nullable();
const httpUrl = z.url().refine((value) => {
  const protocol = new URL(value).protocol;
  return protocol === "http:" || protocol === "https:";
}, "URL must use HTTP or HTTPS");
const nullableUrl = httpUrl.nullable();

export const evidenceSupportSchema = z.enum([
  "identity",
  "domain",
  "industry",
  "country",
  "employee_range",
  "fact",
  "signal",
  "employment",
  "job_title",
  "personalization",
]);

export const agentEvidenceSchema = z
  .object({
    url: httpUrl,
    title: nullableString,
    supports: z.array(evidenceSupportSchema).min(1),
    retrievedAt: z.iso.datetime({ offset: true }).nullable(),
  })
  .strict();

export const accountDiscoveryInputSchema = z
  .object({
    icp: z.string().trim().min(10).max(10_000),
    limit: z.number().int().min(1).max(100),
    countries: z.array(z.string().trim().min(2).max(100)).max(30).default([]),
    industries: z.array(z.string().trim().min(1).max(200)).max(30).default([]),
    requiredSignals: z
      .array(z.string().trim().min(1).max(500))
      .max(30)
      .default([]),
  })
  .strict();

export const accountDiscoveryOutputSchema = z
  .object({
    candidates: z
      .array(
        z
          .object({
            name: z.string().trim().min(1).max(300),
            domain: nullableString,
            website: nullableUrl,
            industry: nullableString,
            employeeRange: nullableString,
            country: nullableString,
            confidence: z.number().min(0).max(1),
            sources: z.array(agentEvidenceSchema).min(1),
          })
          .strict()
          .superRefine((candidate, context) => {
            const supported = new Set(
              candidate.sources.flatMap((source) => source.supports),
            );
            if (!supported.has("identity")) {
              context.addIssue({
                code: "custom",
                message: "Account candidate requires identity evidence",
                path: ["sources"],
              });
            }
            if (candidate.domain && !supported.has("domain")) {
              context.addIssue({
                code: "custom",
                message: "Account candidate requires domain evidence",
                path: ["sources"],
              });
            }
          }),
      )
      .max(100),
  })
  .strict();

export const accountRefSchema = z
  .object({
    id: z.uuid(),
    name: z.string().trim().min(1).max(300),
    domain: nullableString,
  })
  .strict();

export const accountResearchInputSchema = z
  .object({ account: accountRefSchema })
  .strict();

export const accountResearchOutputSchema = z
  .object({
    facts: z
      .object({
        summary: z.string().trim().min(1).max(10_000),
        industry: nullableString,
        employeeRange: nullableString,
        country: nullableString,
        website: nullableUrl,
      })
      .strict(),
    signals: z
      .array(
        z
          .object({
            name: z.string().trim().min(1).max(300),
            description: z.string().trim().min(1).max(2_000),
            observedAt: z.iso.datetime({ offset: true }).nullable(),
            confidence: z.number().min(0).max(1),
            sourceUrls: z.array(httpUrl).min(1),
          })
          .strict(),
      )
      .max(50),
    sources: z.array(agentEvidenceSchema).min(1),
    confidence: z.number().min(0).max(1),
    researchedAt: z.iso.datetime({ offset: true }),
  })
  .strict();

export const contactDiscoveryInputSchema = z
  .object({
    account: accountRefSchema,
    roles: z.array(z.string().trim().min(2).max(300)).min(1).max(50),
    limit: z.number().int().min(1).max(100),
  })
  .strict();

const contactEvidenceSchema = agentEvidenceSchema.extend({
  supports: z.array(z.enum(["employment", "job_title"])).min(1),
});

const discoveredContactSchema = z
  .object({
    firstName: z.string().trim().min(1).max(200),
    lastName: z.string().trim().min(1).max(200),
    jobTitle: z.string().trim().min(1).max(500),
    linkedinUrl: nullableUrl,
    confidence: z.number().min(0).max(1),
    evidence: z.array(contactEvidenceSchema).min(1),
  })
  .strict()
  .superRefine((contact, context) => {
    const supported = new Set(
      contact.evidence.flatMap((source) => source.supports),
    );
    for (const required of ["employment", "job_title"] as const) {
      if (!supported.has(required)) {
        context.addIssue({
          code: "custom",
          message: `Contact evidence must support ${required}`,
          path: ["evidence"],
        });
      }
    }
  });

export const contactDiscoveryOutputSchema = z
  .object({ contacts: z.array(discoveredContactSchema).max(100) })
  .strict();

export const reasoningFieldSchema = z.enum([
  "company_relevance",
  "personalized_opening",
]);

export const personalizationInputSchema = z
  .object({
    declaredFields: z.array(reasoningFieldSchema).min(1).max(2),
    trustedSourceUrls: z.array(httpUrl).min(1).max(100),
    context: z
      .object({
        company: z.string().trim().min(1).max(300),
        firstName: z.string().trim().min(1).max(200),
        jobTitle: z.string().trim().min(1).max(500),
        research: z.record(z.string(), z.unknown()),
      })
      .strict(),
  })
  .strict();

export const personalizationOutputSchema = z
  .object({
    fields: z
      .array(
        z
          .object({
            name: reasoningFieldSchema,
            value: z.string().trim().min(1).max(1_000),
            confidence: z.number().min(0).max(1),
            sourceUrls: z.array(httpUrl).min(1).max(20),
          })
          .strict(),
      )
      .min(1)
      .max(2),
    sources: z.array(agentEvidenceSchema).min(1).max(30),
  })
  .strict()
  .superRefine((personalization, context) => {
    const evidenceUrls = new Set(
      personalization.sources.map((source) => source.url),
    );
    for (const [fieldIndex, field] of personalization.fields.entries()) {
      for (const sourceUrl of field.sourceUrls) {
        if (!evidenceUrls.has(sourceUrl)) {
          context.addIssue({
            code: "custom",
            message: "Personalization field source must have evidence metadata",
            path: ["fields", fieldIndex, "sourceUrls"],
          });
        }
      }
    }
  });

export type AccountDiscoveryInput = z.input<typeof accountDiscoveryInputSchema>;
export type AccountDiscoveryOutput = z.infer<
  typeof accountDiscoveryOutputSchema
>;
export type AccountResearchInput = z.input<typeof accountResearchInputSchema>;
export type AccountResearchOutput = z.infer<typeof accountResearchOutputSchema>;
export type ContactDiscoveryInput = z.input<typeof contactDiscoveryInputSchema>;
export type ContactDiscoveryOutput = z.infer<
  typeof contactDiscoveryOutputSchema
>;
export type PersonalizationInput = z.input<typeof personalizationInputSchema>;
export type PersonalizationOutput = z.infer<typeof personalizationOutputSchema>;

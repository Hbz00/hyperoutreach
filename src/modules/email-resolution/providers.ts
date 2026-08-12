import { z } from "zod";

const httpUrl = z.url().refine((value) => {
  const protocol = new URL(value).protocol;
  return protocol === "http:" || protocol === "https:";
}, "URL must use HTTP or HTTPS");

const enrichmentCandidateSchema = z
  .object({
    email: z.email(),
    confidence: z.number().min(0).max(1),
    source: z.string().trim().min(1).max(200),
    evidenceUrls: z.array(httpUrl).max(50),
  })
  .strict();

export type EmailEnrichmentInput = {
  firstName: string;
  lastName: string;
  companyDomain: string;
};
export type EmailEnrichmentCandidate = z.infer<
  typeof enrichmentCandidateSchema
>;

export interface EmailEnrichmentProvider {
  readonly name: string;
  resolve(
    input: EmailEnrichmentInput,
    options?: { signal?: AbortSignal },
  ): Promise<EmailEnrichmentCandidate[]>;
}

export class EmailEnrichmentTransientError extends Error {
  override readonly name = "EmailEnrichmentTransientError";
}

export class StaticEmailEnrichmentProvider implements EmailEnrichmentProvider {
  readonly name = "static-fixture";
  private readonly candidates: EmailEnrichmentCandidate[];

  constructor(candidates: EmailEnrichmentCandidate[]) {
    this.candidates = z.array(enrichmentCandidateSchema).parse(candidates);
  }

  async resolve(
    input: EmailEnrichmentInput,
    options: { signal?: AbortSignal } = {},
  ): Promise<EmailEnrichmentCandidate[]> {
    void input;
    options.signal?.throwIfAborted();
    return structuredClone(this.candidates);
  }
}

export class NoResultEmailEnrichmentProvider implements EmailEnrichmentProvider {
  readonly name = "no-result";

  async resolve(
    input: EmailEnrichmentInput,
    options: { signal?: AbortSignal } = {},
  ): Promise<EmailEnrichmentCandidate[]> {
    void input;
    options.signal?.throwIfAborted();
    return [];
  }
}

export class TransientEmailEnrichmentProvider implements EmailEnrichmentProvider {
  readonly name = "transient-failure";

  async resolve(
    input: EmailEnrichmentInput,
    options: { signal?: AbortSignal } = {},
  ): Promise<EmailEnrichmentCandidate[]> {
    void input;
    options.signal?.throwIfAborted();
    throw new EmailEnrichmentTransientError(
      "Email enrichment provider is temporarily unavailable",
    );
  }
}

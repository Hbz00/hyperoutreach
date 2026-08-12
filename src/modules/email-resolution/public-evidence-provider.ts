import { z } from "zod";

import type { ObservableAgent } from "@/modules/agents/contracts";
import type { StructuredAIProvider } from "@/modules/agents/openai-agents";
import { normalizeProvenanceUrl } from "@/modules/agents/provenance";
import type { AgentResult } from "@/modules/agents/types";

const httpUrl = z.url().refine((value) => {
  const protocol = new URL(value).protocol;
  return protocol === "http:" || protocol === "https:";
}, "URL must use HTTP or HTTPS");

export const publicEmailSampleSchema = z
  .object({
    firstName: z.string().trim().min(1).max(200),
    lastName: z.string().trim().min(1).max(200),
    email: z.email(),
    sourceUrl: httpUrl,
  })
  .strict();

const publicEmailEvidenceOutputSchema = z
  .object({ samples: z.array(publicEmailSampleSchema).max(100) })
  .strict();
type PublicEmailEvidenceOutput = z.infer<
  typeof publicEmailEvidenceOutputSchema
>;

export type PublicEmailSample = z.infer<typeof publicEmailSampleSchema>;
export type PublicEmailEvidenceInput = { companyDomain: string };
export type PublicEmailEvidenceResult = {
  samples: PublicEmailSample[];
  sourceUrls: string[];
};

export interface PublicEmailEvidenceProvider {
  readonly name: string;
  find(
    input: PublicEmailEvidenceInput,
    options?: { signal?: AbortSignal },
  ): Promise<PublicEmailEvidenceResult>;
}

export interface ObservablePublicEmailEvidenceProvider extends PublicEmailEvidenceProvider {
  readonly auditDescriptor: ObservableAgent;
  findWithAgentResult(
    input: PublicEmailEvidenceInput,
    options?: { signal?: AbortSignal },
  ): Promise<{
    evidence: PublicEmailEvidenceResult;
    agentResult: AgentResult<PublicEmailEvidenceOutput>;
  }>;
}

export function isObservablePublicEmailEvidenceProvider(
  provider: PublicEmailEvidenceProvider,
): provider is ObservablePublicEmailEvidenceProvider {
  const candidate = provider as Partial<ObservablePublicEmailEvidenceProvider>;
  return (
    candidate.auditDescriptor !== undefined &&
    typeof candidate.findWithAgentResult === "function"
  );
}

export class PublicEmailEvidenceError extends Error {
  override readonly name = "PublicEmailEvidenceError";
}

export class StaticPublicEmailEvidenceProvider implements PublicEmailEvidenceProvider {
  readonly name = "static-public-email-evidence";
  private readonly samples: PublicEmailSample[];

  constructor(samples: PublicEmailSample[]) {
    this.samples = z.array(publicEmailSampleSchema).max(100).parse(samples);
  }

  async find(
    input: PublicEmailEvidenceInput,
    options: { signal?: AbortSignal } = {},
  ): Promise<PublicEmailEvidenceResult> {
    void input;
    options.signal?.throwIfAborted();
    return {
      samples: structuredClone(this.samples),
      sourceUrls: [...new Set(this.samples.map((sample) => sample.sourceUrl))],
    };
  }
}

export class OpenAIPublicEmailEvidenceProvider implements ObservablePublicEmailEvidenceProvider {
  readonly name = "openai-public-email-evidence";
  readonly auditDescriptor: ObservableAgent;

  constructor(
    private readonly provider: StructuredAIProvider,
    private readonly model: string,
  ) {
    this.auditDescriptor = {
      name: "public_email_evidence",
      model,
      promptVersion: "public-email-evidence-prompt-v1",
      schemaVersion: "public-email-evidence-schema-v1",
    };
  }

  async find(
    input: PublicEmailEvidenceInput,
    options: { signal?: AbortSignal } = {},
  ): Promise<PublicEmailEvidenceResult> {
    return (await this.findWithAgentResult(input, options)).evidence;
  }

  async findWithAgentResult(
    input: PublicEmailEvidenceInput,
    options: { signal?: AbortSignal } = {},
  ): Promise<{
    evidence: PublicEmailEvidenceResult;
    agentResult: AgentResult<PublicEmailEvidenceOutput>;
  }> {
    options.signal?.throwIfAborted();
    const result = await this.provider.run({
      agent: this.auditDescriptor.name,
      model: this.model,
      instructions:
        "Search public web sources for named employee email addresses on the exact company domain. Return only addresses visibly supported by the cited page. Do not infer or generate addresses.",
      input,
      outputSchema: publicEmailEvidenceOutputSchema,
      outputName: this.auditDescriptor.schemaVersion,
      useWebSearch: true,
    });
    options.signal?.throwIfAborted();
    const output = publicEmailEvidenceOutputSchema.parse(result.output);
    const agentResult = { ...result, output };
    const actualSources = new Set(
      result.sources.map((source) => normalizeProvenanceUrl(source.url)),
    );
    for (const sample of output.samples) {
      if (!actualSources.has(normalizeProvenanceUrl(sample.sourceUrl))) {
        throw new PublicEmailEvidenceError(
          "Public email sample was absent from provider web-search sources",
        );
      }
    }
    return {
      evidence: {
        samples: output.samples,
        sourceUrls: [
          ...new Set(output.samples.map((sample) => sample.sourceUrl)),
        ],
      },
      agentResult,
    };
  }
}

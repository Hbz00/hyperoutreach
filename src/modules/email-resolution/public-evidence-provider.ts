import { z } from "zod";

import type { ObservableAgent } from "@/modules/agents/contracts";
import type { StructuredAIProvider } from "@/modules/agents/structured-agents";
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

/**
 * Exported so a probe can measure a candidate prompt against the contract the
 * production path actually enforces, rather than against a copy of it that can
 * drift and quietly invalidate the measurement.
 */
export const publicEmailEvidenceOutputSchema = z
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

/**
 * What the research lane is asked, and why each clause is there.
 *
 * The question is the company's convention, never one person's address: the
 * model reports named addresses it can see on a domain, and deterministic code
 * infers the pattern and applies it to a contact. That split is what keeps a
 * guessed address out of the database.
 *
 * v2 changed three things, each answering something a ten-domain comparison
 * against real French carriers showed:
 *
 * - v1 never asked for more than one address, and the model stopped at the
 *   first it found — while the scoring needs two unambiguous samples to clear
 *   the default threshold. A company with one findable address could not
 *   resolve, however well the search had gone.
 * - v1 said "public web sources" without saying which. Companies that publish
 *   no address on their own site still appear in files written by other
 *   people: the only address this installation ever surfaced for a mid-sized
 *   carrier came from a third party's training-programme PDF.
 * - v1 named no source family at all, and the omission survived one draft of
 *   this comment for a bad reason worth recording: an early comparison counted
 *   every contact-database citation against the search, because the verifier
 *   used to score it is an ordinary HTTP client and those sites answer it 403.
 *   The app that actually runs these searches reads them — which is why this
 *   installation uses the app rather than an API — so the sources were sound
 *   and the measurement was not. They earn their place explicitly, paired with
 *   the masked-address rule below, because a partial preview is the one real
 *   hazard they carry.
 * - The two prohibitions below are operational, not restatements. The general
 *   "do not infer" clause was already there in v1 and did not stop the model
 *   from reading a name off a press release and citing that page for an
 *   address it never contained, nor from copying a contact site's masked
 *   preview as though it were a whole address. Naming the two behaviours is
 *   what a model can actually check itself against.
 */
/** Bumped whenever the instructions below change; keys the reuse of results. */
export const PUBLIC_EMAIL_EVIDENCE_PROMPT_VERSION =
  "public-email-evidence-prompt-v2";

export const PUBLIC_EMAIL_EVIDENCE_INSTRUCTIONS = [
  "Search public web sources for named employee email addresses on the exact company domain.",
  "Find as many distinct named addresses as you can, not just the first one: two or more belonging to different people are far more useful than one.",
  'Search documents as well as web pages, because companies that publish no address on their own site still appear in files written by others: PDFs (event and training programmes, press kits, tender documents, meeting minutes), press releases, legal notices, conference programmes, job adverts, and association or trade-body publications. The literal query "@<domain>" is an effective way to find these.',
  "Contact, prospecting and people-search databases are legitimate sources too, alongside the company's own material: cite them when the address is fully visible on the page you read.",
  "Report only addresses of named individuals; skip role and department mailboxes such as contact@, info@ or sales@.",
  "If a page names a person but does not visibly show their address, do not report that person at all.",
  "If a page shows an address partially hidden, masked or truncated, do not report it: a masked address is not an address.",
  "Return only addresses visibly supported by the cited page. Do not infer or generate addresses.",
].join(" ");

/**
 * The instructions for one company.
 *
 * The template carries a `<domain>` placeholder and production used to send it
 * unsubstituted, so the model was told to try the literal query `"@<domain>"`
 * while the probe measuring that same prompt substituted the real domain — the
 * measured prompt was not the shipped one. Both now call this, so they cannot
 * differ again.
 */
export function publicEmailEvidenceInstructions(companyDomain: string): string {
  return PUBLIC_EMAIL_EVIDENCE_INSTRUCTIONS.replaceAll(
    "<domain>",
    companyDomain,
  );
}

export class StructuredPublicEmailEvidenceProvider implements ObservablePublicEmailEvidenceProvider {
  readonly name = "structured-public-email-evidence";
  readonly auditDescriptor: ObservableAgent;

  constructor(
    private readonly provider: StructuredAIProvider,
    private readonly model: string,
    effort?: string,
  ) {
    this.auditDescriptor = {
      name: "public_email_evidence",
      model,
      // This runs on the research lane, and the research lane is only
      // distinguishable from the fast one by its effort — both are the same
      // model. Optional because the mock bundle has no lane at all.
      effort,
      promptVersion: PUBLIC_EMAIL_EVIDENCE_PROMPT_VERSION,
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
      instructions: publicEmailEvidenceInstructions(input.companyDomain),
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
          "Public email sample was absent from provider-declared sources",
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

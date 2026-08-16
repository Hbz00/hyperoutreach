import type { z } from "zod";

import type {
  StructuredAIProvider,
  StructuredResponseResult,
} from "@/lib/ai/providers/types";
export type { StructuredAIProvider } from "@/lib/ai/providers/types";
import type {
  AccountDiscoveryAgent,
  AccountResearchAgent,
  ContactDiscoveryAgent,
  PersonalizationAgent,
} from "@/modules/agents/contracts";
import {
  accountDiscoveryInputSchema,
  accountDiscoveryOutputSchema,
  accountResearchInputSchema,
  accountResearchOutputSchema,
  contactDiscoveryInputSchema,
  contactDiscoveryOutputSchema,
  personalizationInputSchema,
  personalizationOutputSchema,
  type AccountDiscoveryInput,
  type AccountDiscoveryOutput,
  type AccountResearchInput,
  type AccountResearchOutput,
  type ContactDiscoveryInput,
  type ContactDiscoveryOutput,
  type PersonalizationInput,
  type PersonalizationOutput,
} from "@/modules/agents/schemas";
import type { AgentResult } from "@/modules/agents/types";
import {
  validateAccountDiscoveryProvenance,
  validateAccountResearchProvenance,
  validateContactDiscoveryProvenance,
  validatePersonalizationPostconditions,
} from "@/modules/agents/provenance";
import {
  replyClassificationSchema,
  validateReplyClassification,
  type ReplyClassification,
  type ReplyClassifier,
  type ReplyClassifierInput,
} from "@/modules/replies/reply-classifier";

function validatedResult<T>(
  result: StructuredResponseResult<T>,
  schema: z.ZodType<T>,
): AgentResult<T> {
  return { ...result, output: schema.parse(result.output) };
}

abstract class BaseStructuredAgent {
  abstract readonly name: string;
  abstract readonly promptVersion: string;
  abstract readonly schemaVersion: string;

  constructor(
    protected readonly provider: StructuredAIProvider,
    readonly model: string,
    readonly effort?: string,
  ) {}
}

export class StructuredAccountDiscoveryAgent
  extends BaseStructuredAgent
  implements AccountDiscoveryAgent
{
  readonly name = "account_discovery";
  readonly promptVersion = "account-discovery-prompt-v1";
  readonly schemaVersion = "account-discovery-schema-v1";

  async discover(
    rawInput: AccountDiscoveryInput,
  ): Promise<AgentResult<AccountDiscoveryOutput>> {
    const input = accountDiscoveryInputSchema.parse(rawInput);
    const result = await this.provider.run({
      agent: this.name,
      model: this.model,
      instructions:
        "Find companies matching the ICP. Return only companies supported by current public web evidence. Do not guess domains. Every candidate needs sources supporting identity and relevant facts.",
      input,
      outputSchema: accountDiscoveryOutputSchema,
      outputName: this.schemaVersion,
      useWebSearch: true,
    });
    const validated = validatedResult(result, accountDiscoveryOutputSchema);
    validateAccountDiscoveryProvenance(validated);
    return validated;
  }
}

export class StructuredAccountResearchAgent
  extends BaseStructuredAgent
  implements AccountResearchAgent
{
  readonly name = "account_research";
  readonly promptVersion = "account-research-prompt-v1";
  readonly schemaVersion = "account-research-schema-v1";

  async research(
    rawInput: AccountResearchInput,
  ): Promise<AgentResult<AccountResearchOutput>> {
    const input = accountResearchInputSchema.parse(rawInput);
    const result = await this.provider.run({
      agent: this.name,
      model: this.model,
      instructions:
        "Research this company once for reuse across all of its contacts. Return concise current facts, relevant signals, source URLs, retrieval time, and calibrated confidence. Do not infer unsupported facts.",
      input,
      outputSchema: accountResearchOutputSchema,
      outputName: this.schemaVersion,
      useWebSearch: true,
    });
    const validated = validatedResult(result, accountResearchOutputSchema);
    validateAccountResearchProvenance(validated);
    return validated;
  }
}

export class StructuredContactDiscoveryAgent
  extends BaseStructuredAgent
  implements ContactDiscoveryAgent
{
  readonly name = "contact_discovery";
  readonly promptVersion = "contact-discovery-prompt-v1";
  readonly schemaVersion = "contact-discovery-schema-v1";

  async discover(
    rawInput: ContactDiscoveryInput,
  ): Promise<AgentResult<ContactDiscoveryOutput>> {
    const input = contactDiscoveryInputSchema.parse(rawInput);
    const result = await this.provider.run({
      agent: this.name,
      model: this.model,
      instructions:
        "Find current employees matching the requested roles. Each contact must include public evidence collectively supporting both current employment and current job title. Never invent a profile or stale role.",
      input,
      outputSchema: contactDiscoveryOutputSchema,
      outputName: this.schemaVersion,
      useWebSearch: true,
    });
    const validated = validatedResult(result, contactDiscoveryOutputSchema);
    validateContactDiscoveryProvenance(validated);
    return validated;
  }
}

export class StructuredPersonalizationAgent
  extends BaseStructuredAgent
  implements PersonalizationAgent
{
  readonly name = "personalization";
  readonly promptVersion = "personalization-prompt-v1";
  readonly schemaVersion = "personalization-schema-v1";

  async personalize(
    rawInput: PersonalizationInput,
  ): Promise<AgentResult<PersonalizationOutput>> {
    const input = personalizationInputSchema.parse(rawInput);
    const result = validatedResult(
      await this.provider.run({
        agent: this.name,
        model: this.model,
        instructions:
          "Fill only the declared reasoning placeholders from the supplied research. Do not generate a whole message and do not emit deterministic fields such as names, company, or title.",
        input,
        outputSchema: personalizationOutputSchema,
        outputName: this.schemaVersion,
        useWebSearch: false,
      }),
      personalizationOutputSchema,
    );
    validatePersonalizationPostconditions(input, result);
    return result;
  }
}

export class StructuredReplyClassifier implements ReplyClassifier {
  readonly promptVersion = "reply-classifier-prompt-v1";
  readonly schemaVersion = "reply-classifier-schema-v1";

  constructor(
    private readonly provider: StructuredAIProvider,
    readonly model: string,
    // `replies.classifier` persists this string. Every caller passes the
    // surface-specific identity; the fallback stays provider-neutral so a
    // caller that forgets cannot stamp a row with a provider that never ran it.
    readonly name = "structured-reply-v1",
    readonly effort?: string,
  ) {}

  async classifyObserved(
    input: ReplyClassifierInput,
  ): Promise<AgentResult<ReplyClassification>> {
    const result = await this.provider.run({
      agent: "reply_classifier",
      model: this.model,
      instructions:
        "Classify the inbound email into exactly one allowed outreach reply category. Give calibrated confidence and a short evidence-based reason.",
      input,
      outputSchema: replyClassificationSchema,
      outputName: this.schemaVersion,
      useWebSearch: false,
    });
    return {
      ...result,
      output: validateReplyClassification(result.output),
    };
  }

  async classify(input: ReplyClassifierInput): Promise<ReplyClassification> {
    return (await this.classifyObserved(input)).output;
  }
}

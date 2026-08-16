import { createProductionAIProviderBundle } from "@/lib/ai/production-provider-bundle";
import type { AIProviderBundle } from "@/lib/ai/provider-bundle";
import type {
  AccountDiscoveryAgent,
  AccountResearchAgent,
  ContactDiscoveryAgent,
  PersonalizationAgent,
} from "@/modules/agents/contracts";
import {
  MockAccountDiscoveryAgent,
  MockAccountResearchAgent,
  MockContactDiscoveryAgent,
} from "@/modules/agents/mock-agents";
import {
  StructuredAccountDiscoveryAgent,
  StructuredAccountResearchAgent,
  StructuredContactDiscoveryAgent,
  StructuredPersonalizationAgent,
} from "@/modules/agents/structured-agents";
import type {
  PersonalizationInput,
  PersonalizationOutput,
} from "@/modules/agents/schemas";
import type { AgentResult } from "@/modules/agents/types";

class DeterministicPersonalizationAgent implements PersonalizationAgent {
  readonly name = "personalization";
  readonly model = "deterministic-mock";
  readonly promptVersion = "personalization-mock-v1";
  readonly schemaVersion = "personalization-schema-v1";

  async personalize(
    input: PersonalizationInput,
  ): Promise<AgentResult<PersonalizationOutput>> {
    const sourceUrl = input.trustedSourceUrls[0]!;
    const output: PersonalizationOutput = {
      fields: input.declaredFields.map((name) => ({
        name,
        value:
          name === "company_relevance"
            ? `${input.context.company} matches the supplied research context.`
            : `Your work as ${input.context.jobTitle} stood out in the supplied research.`,
        confidence: 0.5,
        sourceUrls: [sourceUrl],
      })),
      sources: [
        {
          url: sourceUrl,
          title: "Caller-supplied research",
          supports: ["personalization"],
          retrievedAt: null,
        },
      ],
    };
    return {
      responseId: `mock_personalization_${crypto.randomUUID()}`,
      model: this.model,
      output,
      sources: [{ url: sourceUrl }],
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      costUsd: 0,
    };
  }
}

export type AgentSet = {
  accountDiscovery: AccountDiscoveryAgent;
  accountResearch: AccountResearchAgent;
  contactDiscovery: ContactDiscoveryAgent;
  personalization: PersonalizationAgent;
};

export function createAgentSetFromBundle(bundle: AIProviderBundle): AgentSet {
  if (bundle.usesRealInfrastructure) {
    return {
      accountDiscovery: new StructuredAccountDiscoveryAgent(
        bundle.research.provider,
        bundle.research.model,
        bundle.research.effort,
      ),
      accountResearch: new StructuredAccountResearchAgent(
        bundle.research.provider,
        bundle.research.model,
        bundle.research.effort,
      ),
      contactDiscovery: new StructuredContactDiscoveryAgent(
        bundle.research.provider,
        bundle.research.model,
        bundle.research.effort,
      ),
      personalization: new StructuredPersonalizationAgent(
        bundle.nonWeb.provider,
        bundle.nonWeb.model,
        bundle.nonWeb.effort,
      ),
    };
  }
  const sourceUrl = "https://example.invalid/hyperoutreach-mock-research";
  return {
    accountDiscovery: new MockAccountDiscoveryAgent({ candidates: [] }),
    accountResearch: new MockAccountResearchAgent({
      facts: {
        summary: "Deterministic local research fixture",
        industry: null,
        employeeRange: null,
        country: null,
        website: null,
      },
      signals: [],
      sources: [
        {
          url: sourceUrl,
          title: "Deterministic local fixture",
          supports: ["fact"],
          retrievedAt: null,
        },
      ],
      confidence: 0.25,
      researchedAt: new Date().toISOString(),
    }),
    contactDiscovery: new MockContactDiscoveryAgent({ contacts: [] }),
    personalization: new DeterministicPersonalizationAgent(),
  };
}

export function createAgentSet(
  environment: Record<string, string | undefined> = process.env,
): AgentSet {
  return createAgentSetFromBundle(
    createProductionAIProviderBundle(environment),
  );
}

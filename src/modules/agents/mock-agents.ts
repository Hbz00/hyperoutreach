import type {
  AccountDiscoveryAgent,
  AccountResearchAgent,
  ContactDiscoveryAgent,
  PersonalizationAgent,
} from "@/modules/agents/contracts";
import type {
  AccountDiscoveryInput,
  AccountDiscoveryOutput,
  AccountResearchInput,
  AccountResearchOutput,
  ContactDiscoveryInput,
  ContactDiscoveryOutput,
  PersonalizationInput,
  PersonalizationOutput,
} from "@/modules/agents/schemas";
import {
  accountDiscoveryOutputSchema,
  accountResearchOutputSchema,
  contactDiscoveryOutputSchema,
  personalizationOutputSchema,
} from "@/modules/agents/schemas";
import type { AgentResult } from "@/modules/agents/types";
import {
  validateAccountDiscoveryProvenance,
  validateAccountResearchProvenance,
  validateContactDiscoveryProvenance,
  validatePersonalizationPostconditions,
} from "@/modules/agents/provenance";

function fixtureSources(
  output: unknown,
): Array<{ url: string; title?: string }> {
  const sources = new Map<string, { url: string; title?: string }>();
  function visit(value: unknown): void {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (!value || typeof value !== "object") return;
    const item = value as Record<string, unknown>;
    if (typeof item.url === "string") {
      sources.set(item.url, {
        url: item.url,
        ...(typeof item.title === "string" ? { title: item.title } : {}),
      });
    }
    if (Array.isArray(item.sourceUrls)) {
      for (const url of item.sourceUrls) {
        if (typeof url === "string") sources.set(url, { url });
      }
    }
    Object.values(item).forEach(visit);
  }
  visit(output);
  return [...sources.values()];
}

function mockResult<T>(
  output: T,
  model: string,
  responseId: string,
): AgentResult<T> {
  return {
    responseId,
    model,
    output: structuredClone(output),
    sources: fixtureSources(output),
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    costUsd: 0,
  };
}

abstract class StaticAgent<T> {
  readonly model = "deterministic-mock";
  abstract readonly name: string;
  abstract readonly promptVersion: string;
  abstract readonly schemaVersion: string;
  calls = 0;

  constructor(private readonly fixture: T) {}

  protected result(): AgentResult<T> {
    this.calls += 1;
    return mockResult(
      this.fixture,
      this.model,
      `mock_${this.name}_${this.calls}`,
    );
  }
}

export class MockAccountDiscoveryAgent
  extends StaticAgent<AccountDiscoveryOutput>
  implements AccountDiscoveryAgent
{
  readonly name = "account_discovery";
  readonly promptVersion = "account-discovery-mock-v1";
  readonly schemaVersion = "account-discovery-schema-v1";
  constructor(fixture: AccountDiscoveryOutput) {
    super(accountDiscoveryOutputSchema.parse(fixture));
  }
  async discover(input: AccountDiscoveryInput) {
    void input;
    const result = this.result();
    validateAccountDiscoveryProvenance(result);
    return result;
  }
}

export class MockAccountResearchAgent
  extends StaticAgent<AccountResearchOutput>
  implements AccountResearchAgent
{
  readonly name = "account_research";
  readonly promptVersion = "account-research-mock-v1";
  readonly schemaVersion = "account-research-schema-v1";
  constructor(fixture: AccountResearchOutput) {
    super(accountResearchOutputSchema.parse(fixture));
  }
  async research(input: AccountResearchInput) {
    void input;
    const result = this.result();
    validateAccountResearchProvenance(result);
    return result;
  }
}

export class MockContactDiscoveryAgent
  extends StaticAgent<ContactDiscoveryOutput>
  implements ContactDiscoveryAgent
{
  readonly name = "contact_discovery";
  readonly promptVersion = "contact-discovery-mock-v1";
  readonly schemaVersion = "contact-discovery-schema-v1";
  constructor(fixture: ContactDiscoveryOutput) {
    super(contactDiscoveryOutputSchema.parse(fixture));
  }
  async discover(input: ContactDiscoveryInput) {
    void input;
    const result = this.result();
    validateContactDiscoveryProvenance(result);
    return result;
  }
}

export class MockPersonalizationAgent
  extends StaticAgent<PersonalizationOutput>
  implements PersonalizationAgent
{
  readonly name = "personalization";
  readonly promptVersion = "personalization-mock-v1";
  readonly schemaVersion = "personalization-schema-v1";
  constructor(fixture: PersonalizationOutput) {
    super(personalizationOutputSchema.parse(fixture));
  }
  async personalize(input: PersonalizationInput) {
    const result = this.result();
    validatePersonalizationPostconditions(input, result);
    return result;
  }
}

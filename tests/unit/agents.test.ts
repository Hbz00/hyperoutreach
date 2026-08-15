import { describe, expect, it, vi } from "vitest";

import {
  StructuredAccountDiscoveryAgent,
  StructuredAccountResearchAgent,
  StructuredContactDiscoveryAgent,
  StructuredPersonalizationAgent,
  StructuredReplyClassifier,
  type StructuredAIProvider,
} from "@/modules/agents/structured-agents";
import { MockAccountDiscoveryAgent } from "@/modules/agents/mock-agents";

function providerReturning(
  output: unknown,
  sourceOverride?: Array<{ url: string }>,
) {
  const sourceUrls = new Set<string>();
  function visit(value: unknown): void {
    if (Array.isArray(value)) return value.forEach(visit);
    if (!value || typeof value !== "object") return;
    const item = value as Record<string, unknown>;
    if (typeof item.url === "string") sourceUrls.add(item.url);
    if (Array.isArray(item.sourceUrls)) {
      item.sourceUrls.forEach((url) => {
        if (typeof url === "string") sourceUrls.add(url);
      });
    }
    Object.values(item).forEach(visit);
  }
  visit(output);
  const run = vi.fn().mockResolvedValue({
    responseId: "resp_mock",
    model: "mock-model",
    output,
    sources: sourceOverride ?? [...sourceUrls].map((url) => ({ url })),
    usage: null,
    costUsd: null,
  });
  return { provider: { run } as unknown as StructuredAIProvider, run };
}

describe("narrow OpenAI agent contracts", () => {
  it("provides deterministic credential-free mock agents through the same contract", async () => {
    const agent = new MockAccountDiscoveryAgent({ candidates: [] });
    const input = {
      icp: "A sufficiently precise customer profile for deterministic tests",
      limit: 5,
      countries: [],
      industries: [],
      requiredSignals: [],
    };
    await expect(agent.discover(input)).resolves.toMatchObject({
      responseId: "mock_account_discovery_1",
      output: { candidates: [] },
    });
    await expect(agent.discover(input)).resolves.toMatchObject({
      responseId: "mock_account_discovery_2",
    });
    expect(
      () =>
        new MockAccountDiscoveryAgent({
          candidates: [{ name: "unvalidated" }],
        } as never),
    ).toThrow();
  });

  it("validates account discovery input and returns evidence-backed candidates", async () => {
    const { provider, run } = providerReturning({
      candidates: [
        {
          name: "Acme",
          domain: "acme.example",
          website: "https://acme.example",
          industry: "Software",
          employeeRange: "51-200",
          country: "FR",
          confidence: 0.92,
          sources: [
            {
              url: "https://acme.example/about",
              title: "About Acme",
              supports: [
                "identity",
                "domain",
                "industry",
                "employee_range",
                "country",
              ],
              retrievedAt: null,
            },
          ],
        },
      ],
    });
    const agent = new StructuredAccountDiscoveryAgent(
      provider,
      "research-model",
    );

    const result = await agent.discover({
      icp: "French B2B software companies selling to finance teams",
      limit: 10,
      countries: ["FR"],
      industries: ["Software"],
    });

    expect(result.output.candidates[0]).toMatchObject({
      name: "Acme",
      confidence: 0.92,
    });
    expect(run.mock.calls[0]?.[0]).toMatchObject({
      agent: "account_discovery",
      model: "research-model",
      useWebSearch: true,
    });
    await expect(agent.discover({ icp: " ", limit: 0 })).rejects.toThrow();

    const unsupportedDomain = providerReturning({
      candidates: [
        {
          name: "Unsupported",
          domain: "unsupported.example",
          website: null,
          industry: null,
          employeeRange: null,
          country: null,
          confidence: 0.7,
          sources: [
            {
              url: "https://directory.example/unsupported",
              title: null,
              supports: ["identity"],
              retrievedAt: null,
            },
          ],
        },
      ],
    });
    await expect(
      new StructuredAccountDiscoveryAgent(
        unsupportedDomain.provider,
        "research-model",
      ).discover({ icp: "A precise ICP that is long enough", limit: 5 }),
    ).rejects.toThrow("domain evidence");
  });

  it("returns one reusable account snapshot with facts, signals, freshness, and confidence", async () => {
    const researchedAt = "2026-08-12T00:00:00.000Z";
    const { provider } = providerReturning({
      facts: {
        summary: "Acme builds finance automation software.",
        industry: "Software",
        employeeRange: "51-200",
        country: "FR",
        website: "https://acme.example",
      },
      signals: [
        {
          name: "Hiring",
          description: "Acme is hiring sales staff.",
          observedAt: researchedAt,
          confidence: 0.86,
          sourceUrls: ["https://acme.example/jobs"],
        },
      ],
      sources: [
        {
          url: "https://acme.example/jobs",
          title: "Jobs",
          supports: [
            "fact",
            "domain",
            "industry",
            "employee_range",
            "country",
            "signal",
          ],
          retrievedAt: researchedAt,
        },
      ],
      confidence: 0.9,
      researchedAt,
    });

    const result = await new StructuredAccountResearchAgent(
      provider,
      "research-model",
    ).research({
      account: {
        id: "27ecb44c-c619-4af9-b409-12d1a805dc0c",
        name: "Acme",
        domain: "acme.example",
      },
    });

    expect(result.output.researchedAt).toBe(researchedAt);
    expect(result.output.sources[0]?.supports).toContain("signal");
  });

  it("requires employment and title evidence for discovered contacts", async () => {
    const { provider } = providerReturning({
      contacts: [
        {
          firstName: "Alice",
          lastName: "Martin",
          jobTitle: "VP Sales",
          linkedinUrl: "https://www.linkedin.com/in/alice-martin",
          confidence: 0.93,
          evidence: [
            {
              url: "https://acme.example/team/alice",
              title: "Team",
              supports: ["employment", "job_title"],
              retrievedAt: null,
            },
          ],
        },
      ],
    });

    const result = await new StructuredContactDiscoveryAgent(
      provider,
      "research-model",
    ).discover({
      account: {
        id: "27ecb44c-c619-4af9-b409-12d1a805dc0c",
        name: "Acme",
        domain: "acme.example",
      },
      roles: ["VP Sales", "Head of Sales"],
      limit: 5,
    });
    expect(result.output.contacts[0]?.evidence[0]?.supports).toEqual([
      "employment",
      "job_title",
    ]);

    const invalid = providerReturning({
      contacts: [
        {
          firstName: "Alice",
          lastName: "Martin",
          jobTitle: "VP Sales",
          confidence: 0.8,
          evidence: [
            {
              url: "https://example.com",
              title: null,
              supports: ["employment"],
              retrievedAt: null,
            },
          ],
        },
      ],
    });
    await expect(
      new StructuredContactDiscoveryAgent(
        invalid.provider,
        "research-model",
      ).discover({
        account: {
          id: "27ecb44c-c619-4af9-b409-12d1a805dc0c",
          name: "Acme",
          domain: "acme.example",
        },
        roles: ["VP Sales"],
        limit: 5,
      }),
    ).rejects.toThrow();
  });

  it("personalizes only declared reasoning fields", async () => {
    const { provider } = providerReturning(
      {
        fields: [
          {
            name: "company_relevance",
            value: "Acme is expanding its finance product.",
            confidence: 0.87,
            sourceUrls: ["https://acme.example/news"],
          },
        ],
        sources: [
          {
            url: "https://acme.example/news",
            title: "News",
            supports: ["personalization"],
            retrievedAt: null,
          },
        ],
      },
      [],
    );
    const agent = new StructuredPersonalizationAgent(provider, "fast-model");
    const result = await agent.personalize({
      declaredFields: ["company_relevance"],
      trustedSourceUrls: ["https://acme.example/news"],
      context: {
        company: "Acme",
        firstName: "Alice",
        jobTitle: "VP Sales",
        research: { summary: "Finance product expansion" },
      },
    });
    expect(result.output.fields).toHaveLength(1);

    const unsupported = providerReturning({
      fields: [
        {
          name: "company_relevance",
          value: "Unsupported claim.",
          confidence: 0.8,
          sourceUrls: [],
        },
      ],
      sources: [],
    });
    await expect(
      new StructuredPersonalizationAgent(
        unsupported.provider,
        "fast-model",
      ).personalize({
        declaredFields: ["company_relevance"],
        trustedSourceUrls: ["https://acme.example/news"],
        context: {
          company: "Acme",
          firstName: "Alice",
          jobTitle: "VP Sales",
          research: {},
        },
      }),
    ).rejects.toThrow();

    const undeclared = providerReturning({
      fields: [
        {
          name: "personalized_opening",
          value: "Hello Alice",
          confidence: 0.8,
          sourceUrls: ["https://acme.example/about"],
        },
      ],
      sources: [
        {
          url: "https://acme.example/about",
          title: null,
          supports: ["personalization"],
          retrievedAt: null,
        },
      ],
    });
    await expect(
      new StructuredPersonalizationAgent(
        undeclared.provider,
        "fast-model",
      ).personalize({
        declaredFields: ["company_relevance"],
        trustedSourceUrls: ["https://acme.example/about"],
        context: {
          company: "Acme",
          firstName: "Alice",
          jobTitle: "VP Sales",
          research: {},
        },
      }),
    ).rejects.toThrow("undeclared reasoning field");
  });

  it("maps the strict reply classifier output to the existing boundary", async () => {
    const { provider } = providerReturning({
      category: "positive",
      confidence: 0.94,
      reason: "The recipient asks to schedule a call.",
    });
    const classifier = new StructuredReplyClassifier(provider, "fast-model");
    await expect(
      classifier.classify({
        sender: "alice@acme.example",
        subject: "Re: intro",
        body: "Yes, let's schedule a call.",
      }),
    ).resolves.toEqual({
      category: "positive",
      confidence: 0.94,
      reason: "The recipient asks to schedule a call.",
    });
    await expect(
      classifier.classifyObserved({
        sender: "alice@acme.example",
        subject: "Re: intro",
        body: "Yes, let's schedule a call.",
      }),
    ).resolves.toMatchObject({
      responseId: "resp_mock",
      output: { category: "positive", confidence: 0.94 },
    });

    const invalid = providerReturning({
      category: "maybe",
      confidence: 3,
      reason: "invalid",
    });
    await expect(
      new StructuredReplyClassifier(invalid.provider, "fast-model").classify({
        sender: "alice@acme.example",
        subject: "Re: intro",
        body: "Maybe.",
      }),
    ).rejects.toThrow();
  });
});

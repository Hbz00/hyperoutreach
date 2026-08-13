import { describe, expect, it, vi } from "vitest";

import type { StructuredAIProvider } from "@/lib/openai/providers/types";

vi.mock("server-only", () => ({}));

const { createAgentSetFromBundle } = await import("@/modules/agents/factory");
const { OpenAIPersonalizationAgent } =
  await import("@/modules/agents/openai-agents");

function providerReturning(output: unknown) {
  const run = vi.fn().mockResolvedValue({
    responseId: "response-id",
    model: "provider-model",
    output,
    sources: [],
    usage: null,
    toolUsage: { webSearchCalls: 0 },
    costUsd: null,
    costAvailability: "unavailable",
  });
  return { provider: { run }, run };
}

describe("agent provider routing", () => {
  it("uses one Codex provider for sourced research and non-web personalization", async () => {
    const run = vi.fn(async (request: { agent: string }) => ({
      responseId: "response-id",
      model: "provider-model",
      output:
        request.agent === "personalization"
          ? {
              fields: [
                {
                  name: "company_relevance",
                  value: "Acme matches the supplied research.",
                  confidence: 0.9,
                  sourceUrls: ["https://example.com/research"],
                },
              ],
              sources: [
                {
                  url: "https://example.com/research",
                  title: "Research",
                  supports: ["personalization"],
                  retrievedAt: null,
                },
              ],
            }
          : { candidates: [] },
      sources: [],
      usage: null,
      toolUsage: {
        webSearchCalls: request.agent === "personalization" ? 0 : 1,
      },
      costUsd: null,
      costAvailability: "unavailable" as const,
    }));
    const codex = {
      provider: { run } as unknown as StructuredAIProvider,
      run,
    };
    const agents = createAgentSetFromBundle({
      mode: "codex",
      usesRealInfrastructure: true,
      research: {
        provider: codex.provider,
        model: "codex-cli:codex-research",
      },
      nonWeb: {
        provider: codex.provider,
        model: "codex-cli:codex-model",
      },
    });

    expect(agents.accountDiscovery.model).toBe("codex-cli:codex-research");
    expect(agents.personalization).toBeInstanceOf(OpenAIPersonalizationAgent);
    expect(agents.personalization.model).toBe("codex-cli:codex-model");

    await agents.accountDiscovery.discover({
      icp: "European B2B software companies with a growing sales team",
      limit: 1,
      countries: [],
      industries: [],
      requiredSignals: [],
    });
    expect(codex.run).toHaveBeenCalledWith(
      expect.objectContaining({
        useWebSearch: true,
        model: "codex-cli:codex-research",
      }),
    );

    await agents.personalization.personalize({
      declaredFields: ["company_relevance"],
      trustedSourceUrls: ["https://example.com/research"],
      context: {
        company: "Acme",
        firstName: "Ada",
        jobTitle: "VP Sales",
        research: {},
      },
    });
    expect(codex.run).toHaveBeenCalledWith(
      expect.objectContaining({
        useWebSearch: false,
        model: "codex-cli:codex-model",
      }),
    );
    expect(codex.run).toHaveBeenCalledTimes(2);
  });

  it("uses the two configured lanes in OpenAI mode", () => {
    const responses = providerReturning({});
    const agents = createAgentSetFromBundle({
      mode: "openai",
      usesRealInfrastructure: true,
      research: { provider: responses.provider, model: "research-model" },
      nonWeb: { provider: responses.provider, model: "fast-model" },
    });

    expect(agents.accountDiscovery.model).toBe("research-model");
    expect(agents.accountResearch.model).toBe("research-model");
    expect(agents.contactDiscovery.model).toBe("research-model");
    expect(agents.personalization.model).toBe("fast-model");
  });

  it("keeps deterministic agents in mock mode", () => {
    const agents = createAgentSetFromBundle({
      mode: "mock",
      usesRealInfrastructure: false,
    });

    expect(agents.accountDiscovery.model).toBe("deterministic-mock");
    expect(agents.accountResearch.model).toBe("deterministic-mock");
    expect(agents.contactDiscovery.model).toBe("deterministic-mock");
    expect(agents.personalization.model).toBe("deterministic-mock");
  });
});

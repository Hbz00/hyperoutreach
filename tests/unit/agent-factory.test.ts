import { describe, expect, it, vi } from "vitest";

import type { StructuredAIProvider } from "@/lib/ai/providers/types";

vi.mock("server-only", () => ({}));

const { createAgentSetFromBundle } = await import("@/modules/agents/factory");
const { StructuredPersonalizationAgent } =
  await import("@/modules/agents/structured-agents");

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
    const desktop = {
      provider: { run } as unknown as StructuredAIProvider,
      run,
    };
    const agents = createAgentSetFromBundle({
      mode: "chatgpt_desktop",
      usesRealInfrastructure: true,
      research: {
        provider: desktop.provider,
        model: "chatgpt-desktop:GPT-5.6 Sol",
        operationTimeoutMs: 120_000,
      },
      nonWeb: {
        provider: desktop.provider,
        model: "chatgpt-desktop:GPT-5.6 Sol",
      },
    });

    expect(agents.accountDiscovery.model).toBe("chatgpt-desktop:GPT-5.6 Sol");
    expect(agents.personalization).toBeInstanceOf(
      StructuredPersonalizationAgent,
    );
    expect(agents.personalization.model).toBe("chatgpt-desktop:GPT-5.6 Sol");

    await agents.accountDiscovery.discover({
      icp: "European B2B software companies with a growing sales team",
      limit: 1,
      countries: [],
      industries: [],
      requiredSignals: [],
    });
    expect(desktop.run).toHaveBeenCalledWith(
      expect.objectContaining({
        useWebSearch: true,
        model: "chatgpt-desktop:GPT-5.6 Sol",
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
    expect(desktop.run).toHaveBeenCalledWith(
      expect.objectContaining({
        useWebSearch: false,
        model: "chatgpt-desktop:GPT-5.6 Sol",
      }),
    );
    expect(desktop.run).toHaveBeenCalledTimes(2);
  });

  it("routes each agent to the lane its work belongs to", () => {
    const surface = providerReturning({});
    const agents = createAgentSetFromBundle({
      mode: "chatgpt_desktop",
      usesRealInfrastructure: true,
      research: {
        provider: surface.provider,
        model: "chatgpt-desktop:research-lane",
        operationTimeoutMs: 600_000,
      },
      nonWeb: {
        provider: surface.provider,
        model: "chatgpt-desktop:fast-lane",
      },
    });

    expect(agents.accountDiscovery.model).toBe("chatgpt-desktop:research-lane");
    expect(agents.accountResearch.model).toBe("chatgpt-desktop:research-lane");
    expect(agents.contactDiscovery.model).toBe("chatgpt-desktop:research-lane");
    expect(agents.personalization.model).toBe("chatgpt-desktop:fast-lane");
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

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AppDatabase } from "@/lib/db/types";
import type { AIProviderBundle } from "@/lib/openai/provider-bundle";
import type { StructuredAIProvider } from "@/lib/openai/providers/types";
import type { DnsMxResolver } from "@/modules/email-resolution/dns";
import {
  composeEmailResolutionProviders,
  createWorkflowTaskServices,
} from "@/modules/workflows/service-factory";

function databaseWriterDouble(): AppDatabase {
  const db = {
    insert: vi.fn(() => ({
      values: () => ({ returning: async () => [{ id: "run-id" }] }),
    })),
    update: vi.fn(() => ({
      set: () => ({ where: async () => undefined }),
    })),
    transaction: vi.fn(async (operation: (tx: unknown) => unknown) =>
      operation(db),
    ),
  };
  return db as unknown as AppDatabase;
}

function providerDouble(
  implementation: (request: { agent: string }) => unknown,
): StructuredAIProvider & { run: ReturnType<typeof vi.fn> } {
  return {
    run: vi.fn(async (request: { agent: string }) => ({
      responseId: `response-${request.agent}`,
      model: "provider-model",
      output: implementation(request),
      sources: [],
      usage: null,
      toolUsage: {
        webSearchCalls: request.agent === "personalization" ? 0 : 1,
      },
      costUsd: null,
      costAvailability: "unavailable" as const,
    })),
  } as unknown as StructuredAIProvider & { run: ReturnType<typeof vi.fn> };
}

function dnsDouble(): DnsMxResolver {
  return { resolve: vi.fn().mockResolvedValue({ hasMx: true, records: [] }) };
}

function dependencies(bundle: AIProviderBundle) {
  const realDns = dnsDouble();
  const mockDns = dnsDouble();
  return {
    createBundle: vi.fn(() => bundle),
    createRealDns: vi.fn(() => realDns),
    createMockDns: vi.fn(() => mockDns),
    realDns,
    mockDns,
  };
}

describe("workflow service provider composition", () => {
  beforeEach(() => vi.clearAllMocks());

  it("shares one Codex provider across research and non-web lanes", async () => {
    const codex = providerDouble((request) =>
      request.agent === "public_email_evidence"
        ? { samples: [] }
        : request.agent === "personalization"
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
    );
    const bundle: AIProviderBundle = {
      mode: "codex",
      usesRealInfrastructure: true,
      research: { provider: codex, model: "codex-cli:research" },
      nonWeb: { provider: codex, model: "codex-cli:fast" },
    };
    const injected = dependencies(bundle);
    const db = databaseWriterDouble();
    const services = createWorkflowTaskServices(
      db,
      { OPENAI_PROVIDER: "codex" },
      injected,
    );

    expect(injected.createBundle).toHaveBeenCalledOnce();
    expect(injected.createBundle).toHaveBeenCalledWith({
      OPENAI_PROVIDER: "codex",
    });

    await expect(
      services["account-discovery"]({
        icp: "European B2B software companies with a growing sales team",
        limit: 1,
        countries: [],
        industries: [],
        requiredSignals: [],
      }),
    ).resolves.toMatchObject({ ok: true });
    await expect(
      services["personalize-message"]({
        declaredFields: ["company_relevance"],
        trustedSourceUrls: ["https://example.com/research"],
        context: {
          company: "Acme",
          firstName: "Ada",
          jobTitle: "VP Sales",
          research: {},
        },
      }),
    ).resolves.toMatchObject({ ok: true });

    expect(codex.run).toHaveBeenCalledWith(
      expect.objectContaining({
        useWebSearch: true,
        model: "codex-cli:research",
      }),
    );
    expect(codex.run).toHaveBeenCalledWith(
      expect.objectContaining({ useWebSearch: false, model: "codex-cli:fast" }),
    );

    const emailProviders = composeEmailResolutionProviders(bundle, injected);
    await emailProviders.dns.resolve("example.com");
    await emailProviders.publicEvidence.find({ companyDomain: "example.com" });
    expect(injected.createRealDns).toHaveBeenCalledOnce();
    expect(injected.createMockDns).not.toHaveBeenCalled();
    expect(injected.realDns.resolve).toHaveBeenCalledWith("example.com");
    expect(injected.mockDns.resolve).not.toHaveBeenCalled();
    expect(codex.run).toHaveBeenCalledWith(
      expect.objectContaining({
        agent: "public_email_evidence",
        model: "codex-cli:research",
        useWebSearch: true,
      }),
    );
    expect(codex.run).toHaveBeenCalledTimes(3);
  });

  it("selects real DNS and the Responses research lane in OpenAI mode", async () => {
    const responses = providerDouble((request) =>
      request.agent === "public_email_evidence"
        ? { samples: [] }
        : { candidates: [] },
    );
    const bundle: AIProviderBundle = {
      mode: "openai",
      usesRealInfrastructure: true,
      research: { provider: responses, model: "research-model" },
      nonWeb: { provider: responses, model: "fast-model" },
    };
    const injected = dependencies(bundle);
    const services = createWorkflowTaskServices(
      databaseWriterDouble(),
      { OPENAI_PROVIDER: "openai", OPENAI_API_KEY: "unused" },
      injected,
    );

    await services["account-discovery"]({
      icp: "European B2B software companies with a growing sales team",
      limit: 1,
      countries: [],
      industries: [],
      requiredSignals: [],
    });
    const emailProviders = composeEmailResolutionProviders(bundle, injected);
    await emailProviders.dns.resolve("example.com");
    await emailProviders.publicEvidence.find({ companyDomain: "example.com" });

    expect(injected.createBundle).toHaveBeenCalledOnce();
    expect(responses.run).toHaveBeenCalledWith(
      expect.objectContaining({ useWebSearch: true, model: "research-model" }),
    );
    expect(injected.createRealDns).toHaveBeenCalledOnce();
    expect(injected.createMockDns).not.toHaveBeenCalled();
    expect(injected.realDns.resolve).toHaveBeenCalledWith("example.com");
    expect(injected.mockDns.resolve).not.toHaveBeenCalled();
  });

  it("keeps mock-only DNS infrastructure in mock mode", async () => {
    const bundle: AIProviderBundle = {
      mode: "mock",
      usesRealInfrastructure: false,
    };
    const injected = dependencies(bundle);
    createWorkflowTaskServices(
      databaseWriterDouble(),
      { OPENAI_PROVIDER: "mock" },
      injected,
    );

    const emailProviders = composeEmailResolutionProviders(bundle, injected);
    await emailProviders.dns.resolve("example.com");
    await expect(
      emailProviders.publicEvidence.find({ companyDomain: "example.com" }),
    ).resolves.toEqual({ samples: [], sourceUrls: [] });

    expect(injected.createBundle).toHaveBeenCalledOnce();
    expect(injected.createMockDns).toHaveBeenCalledOnce();
    expect(injected.createRealDns).not.toHaveBeenCalled();
    expect(injected.mockDns.resolve).toHaveBeenCalledWith("example.com");
    expect(injected.realDns.resolve).not.toHaveBeenCalled();
  });
});

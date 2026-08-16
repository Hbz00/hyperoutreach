import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AppDatabase } from "@/lib/db/types";
import type { AIProviderBundle } from "@/lib/ai/provider-bundle";
import type { StructuredAIProvider } from "@/lib/ai/providers/types";
import type { DnsMxResolver } from "@/modules/email-resolution/dns";
import {
  assertInboundBatchSucceeded,
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

  it("shares one desktop provider across research and non-web lanes", async () => {
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
      mode: "chatgpt_desktop",
      usesRealInfrastructure: true,
      research: {
        provider: codex,
        model: "chatgpt-desktop:GPT-5.6 Sol",
        effort: "High",
        operationTimeoutMs: 120_000,
      },
      nonWeb: {
        provider: codex,
        model: "chatgpt-desktop:GPT-5.6 Sol",
        effort: "Instant",
      },
    };
    const injected = dependencies(bundle);
    const db = databaseWriterDouble();
    const services = createWorkflowTaskServices(db, {}, injected);

    expect(injected.createBundle).toHaveBeenCalledOnce();
    expect(injected.createBundle).toHaveBeenCalledWith({});

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
        model: "chatgpt-desktop:GPT-5.6 Sol",
      }),
    );
    expect(codex.run).toHaveBeenCalledWith(
      expect.objectContaining({
        useWebSearch: false,
        model: "chatgpt-desktop:GPT-5.6 Sol",
      }),
    );

    const emailProviders = composeEmailResolutionProviders(bundle, injected);
    expect(emailProviders.publicEvidenceOperationTimeoutMs).toBe(120_000);
    await emailProviders.dns.resolve("example.com");
    await emailProviders.publicEvidence.find({ companyDomain: "example.com" });
    expect(injected.createRealDns).toHaveBeenCalledOnce();
    expect(injected.createMockDns).not.toHaveBeenCalled();
    expect(injected.realDns.resolve).toHaveBeenCalledWith("example.com");
    expect(injected.mockDns.resolve).not.toHaveBeenCalled();
    expect(codex.run).toHaveBeenCalledWith(
      expect.objectContaining({
        agent: "public_email_evidence",
        model: "chatgpt-desktop:GPT-5.6 Sol",
        useWebSearch: true,
      }),
    );
    expect(codex.run).toHaveBeenCalledTimes(3);
  });

  it("selects real DNS and the research lane whenever the surface is live", async () => {
    const surface = providerDouble((request) =>
      request.agent === "public_email_evidence"
        ? { samples: [] }
        : { candidates: [] },
    );
    const bundle: AIProviderBundle = {
      mode: "chatgpt_desktop",
      usesRealInfrastructure: true,
      research: {
        provider: surface,
        model: "chatgpt-desktop:research-lane",
        effort: "High",
        operationTimeoutMs: 600_000,
      },
      nonWeb: {
        provider: surface,
        model: "chatgpt-desktop:fast-lane",
        effort: "Instant",
      },
    };
    const injected = dependencies(bundle);
    const services = createWorkflowTaskServices(
      databaseWriterDouble(),
      {},
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
    // Public email evidence is web research, so it inherits the research
    // deadline rather than a short operation timeout.
    expect(emailProviders.publicEvidenceOperationTimeoutMs).toBe(600_000);
    await emailProviders.dns.resolve("example.com");
    await emailProviders.publicEvidence.find({ companyDomain: "example.com" });

    expect(injected.createBundle).toHaveBeenCalledOnce();
    expect(surface.run).toHaveBeenCalledWith(
      expect.objectContaining({
        useWebSearch: true,
        model: "chatgpt-desktop:research-lane",
      }),
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
      { AI_PROVIDER: "mock" },
      injected,
    );

    const emailProviders = composeEmailResolutionProviders(bundle, injected);
    expect(emailProviders.publicEvidenceOperationTimeoutMs).toBe(10_000);
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

describe("inbound maintenance safety", () => {
  it("fails the batch when any SMTP/IMAP mailbox reconciliation failed", () => {
    expect(() =>
      assertInboundBatchSucceeded([
        { mailboxId: "mailbox-ok", result: { processed: 1 } },
        { mailboxId: "mailbox-failed", error: "Connection refused" },
      ]),
    ).toThrow("Inbound mailbox reconciliation failed");
  });

  it("accepts an empty or fully successful batch", () => {
    expect(() => assertInboundBatchSucceeded([])).not.toThrow();
    expect(() =>
      assertInboundBatchSucceeded([
        { mailboxId: "mailbox-ok", result: { processed: 1 } },
      ]),
    ).not.toThrow();
  });
});

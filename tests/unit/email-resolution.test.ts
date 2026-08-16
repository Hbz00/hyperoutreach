import { describe, expect, it } from "vitest";

import {
  generateCandidateAddress,
  inferEmailPatterns,
  normalizeEmailNamePart,
  scoreEmailCandidate,
} from "@/modules/email-resolution/patterns";
import {
  EmailEnrichmentTransientError,
  NoResultEmailEnrichmentProvider,
  StaticEmailEnrichmentProvider,
  TransientEmailEnrichmentProvider,
} from "@/modules/email-resolution/providers";
import {
  MockDnsMxResolver,
  NodeDnsMxResolver,
} from "@/modules/email-resolution/dns";
import {
  StructuredPublicEmailEvidenceProvider,
  StaticPublicEmailEvidenceProvider,
} from "@/modules/email-resolution/public-evidence-provider";

describe("deterministic email pattern resolution", () => {
  it("infers a pattern from exact-domain public samples and ignores wrong domains", () => {
    const patterns = inferEmailPatterns(
      [
        {
          firstName: "Marie",
          lastName: "Dupont",
          email: "marie.dupont@acme.example",
          sourceUrl: "https://acme.example/press",
        },
        {
          firstName: "John",
          lastName: "Smith",
          email: "john.smith@acme.example",
          sourceUrl: "https://acme.example/team",
        },
        {
          firstName: "Mallory",
          lastName: "Wrong",
          email: "mallory.wrong@other.example",
          sourceUrl: "https://other.example",
        },
      ],
      "acme.example",
    );

    expect(patterns).toEqual([
      {
        pattern: "first.last",
        sampleCount: 2,
        sourceUrls: ["https://acme.example/press", "https://acme.example/team"],
      },
    ]);
  });

  it("counts distinct public email samples even when one page evidences several addresses", () => {
    expect(
      inferEmailPatterns(
        [
          {
            firstName: "Marie",
            lastName: "Dupont",
            email: "marie.dupont@acme.example",
            sourceUrl: "https://acme.example/team",
          },
          {
            firstName: "John",
            lastName: "Smith",
            email: "john.smith@acme.example",
            sourceUrl: "https://acme.example/team",
          },
        ],
        "acme.example",
      ),
    ).toEqual([
      {
        pattern: "first.last",
        sampleCount: 2,
        sourceUrls: ["https://acme.example/team"],
      },
    ]);
  });

  it("does not count samples that are ambiguous between patterns as independent confirmations", () => {
    expect(
      inferEmailPatterns(
        [
          {
            firstName: "J",
            lastName: "Smith",
            email: "j.smith@acme.example",
            sourceUrl: "https://acme.example/team/j-smith",
          },
          {
            firstName: "A",
            lastName: "Doe",
            email: "a.doe@acme.example",
            sourceUrl: "https://acme.example/team/a-doe",
          },
        ],
        "acme.example",
      ),
    ).toEqual([]);
  });

  it("normalizes Unicode, particles, apostrophes, and hyphens deterministically", () => {
    expect(normalizeEmailNamePart(" José María ")).toBe("josemaria");
    expect(normalizeEmailNamePart(" de la Cruz ")).toBe("delacruz");
    expect(normalizeEmailNamePart(" D’Angelo-Smith ")).toBe("dangelosmith");
    expect(normalizeEmailNamePart(" Jørgen Weiß ")).toBe("jorgenweiss");
    expect(
      generateCandidateAddress({
        firstName: "José María",
        lastName: "de la Cruz",
        domain: "acme.example",
        pattern: "first.last",
      }),
    ).toBe("josemaria.delacruz@acme.example");
  });

  it("scores multiple consistent samples above one sample while MX alone proves nothing", () => {
    expect(scoreEmailCandidate({ sampleCount: 1, mxValid: true })).toBe(0.75);
    expect(scoreEmailCandidate({ sampleCount: 2, mxValid: true })).toBe(0.9);
    expect(scoreEmailCandidate({ sampleCount: 3, mxValid: true })).toBe(0.97);
    expect(scoreEmailCandidate({ sampleCount: 2, mxValid: false })).toBe(0.4);
    expect(scoreEmailCandidate({ sampleCount: 0, mxValid: true })).toBe(0);
  });

  it("returns no inferred candidate without a consistent evidenced sample", () => {
    expect(
      inferEmailPatterns(
        [
          {
            firstName: "Unknown",
            lastName: "Person",
            email: "support@acme.example",
            sourceUrl: "https://acme.example/contact",
          },
        ],
        "acme.example",
      ),
    ).toEqual([]);
  });
});

describe("replaceable email enrichment providers", () => {
  const input = {
    firstName: "Alice",
    lastName: "Martin",
    companyDomain: "acme.example",
  };

  it("supports deterministic success and explicit no-result providers", async () => {
    await expect(
      new StaticEmailEnrichmentProvider([
        {
          email: "alice.martin@acme.example",
          confidence: 0.88,
          source: "fixture",
          evidenceUrls: ["https://provider.example/result"],
        },
      ]).resolve(input),
    ).resolves.toHaveLength(1);
    await expect(
      new NoResultEmailEnrichmentProvider().resolve(input),
    ).resolves.toEqual([]);
  });

  it("represents transient provider failure without fabricating a result", async () => {
    await expect(
      new TransientEmailEnrichmentProvider().resolve(input),
    ).rejects.toBeInstanceOf(EmailEnrichmentTransientError);
  });
});

describe("public email evidence providers", () => {
  it("validates static evidence as provenance-bearing HTTP sources", async () => {
    const provider = new StaticPublicEmailEvidenceProvider([
      {
        firstName: "Alice",
        lastName: "Martin",
        email: "alice.martin@acme.example",
        sourceUrl: "https://acme.example/team",
      },
    ]);
    await expect(
      provider.find({ companyDomain: "acme.example" }),
    ).resolves.toEqual({
      samples: [
        expect.objectContaining({ email: "alice.martin@acme.example" }),
      ],
      sourceUrls: ["https://acme.example/team"],
    });
    expect(
      () =>
        new StaticPublicEmailEvidenceProvider([
          {
            firstName: "Alice",
            lastName: "Martin",
            email: "alice.martin@acme.example",
            sourceUrl: "javascript:alert(1)",
          },
        ]),
    ).toThrow();
  });

  it("binds structured samples to provider-declared sources", async () => {
    const provider = new StructuredPublicEmailEvidenceProvider(
      {
        run: async () => ({
          responseId: "resp_public_email",
          model: "research-model",
          output: {
            samples: [
              {
                firstName: "Alice",
                lastName: "Martin",
                email: "alice.martin@acme.example",
                sourceUrl: "https://acme.example/team",
              },
            ],
          },
          sources: [{ url: "https://search.example/unrelated" }],
          usage: null,
          toolUsage: { webSearchCalls: 1 },
          costUsd: null,
          costAvailability: "unavailable",
        }),
      } as never,
      "research-model",
    );
    await expect(
      provider.find({ companyDomain: "acme.example" }),
    ).rejects.toThrow(
      "Public email sample was absent from provider-declared sources",
    );
  });

  it("requests web search through the real structured provider contract", async () => {
    let request: Record<string, unknown> | undefined;
    const provider = new StructuredPublicEmailEvidenceProvider(
      {
        run: async (input: Record<string, unknown>) => {
          request = input;
          return {
            responseId: "resp_public_email",
            model: "research-model",
            output: { samples: [] },
            sources: [],
            usage: null,
            toolUsage: { webSearchCalls: 1 },
            costUsd: null,
            costAvailability: "unavailable",
          };
        },
      } as never,
      "research-model",
    );
    await provider.find({ companyDomain: "acme.example" });
    expect(request).toMatchObject({
      agent: "public_email_evidence",
      model: "research-model",
      useWebSearch: true,
      input: { companyDomain: "acme.example" },
    });
  });

  // This provider runs on the research lane, and on this transport the two
  // lanes are the same model — the effort is the only thing that tells them
  // apart. The descriptor is hand-written rather than the agent itself, which
  // is exactly how a lane goes unrecorded without anybody noticing.
  it("records which lane it ran on", () => {
    const withLane = new StructuredPublicEmailEvidenceProvider(
      {} as never,
      "research-model",
      "High",
    );
    expect(withLane.auditDescriptor).toMatchObject({
      name: "public_email_evidence",
      model: "research-model",
      effort: "High",
    });
    // A mock bundle has no lane, and an invented one would be worse than the
    // blank.
    expect(
      new StructuredPublicEmailEvidenceProvider({} as never, "research-model")
        .auditDescriptor.effort,
    ).toBeUndefined();
  });
});

describe("MX resolver boundary", () => {
  it("normalizes the domain and deterministically sorts real resolver records", async () => {
    const resolver = new NodeDnsMxResolver(async (domain) => {
      expect(domain).toBe("acme.example");
      return [
        { exchange: "mx2.acme.example", priority: 20 },
        { exchange: "mx1.acme.example", priority: 10 },
      ];
    });
    await expect(resolver.resolve("WWW.Acme.Example")).resolves.toEqual({
      hasMx: true,
      records: [
        { exchange: "mx1.acme.example", priority: 10 },
        { exchange: "mx2.acme.example", priority: 20 },
      ],
    });
  });

  it("recognizes RFC null MX as an explicit no-mail domain", async () => {
    const resolver = new NodeDnsMxResolver(async () => [
      { exchange: ".", priority: 0 },
    ]);
    await expect(resolver.resolve("acme.example")).resolves.toEqual({
      hasMx: false,
      records: [],
    });
  });

  it("supports deterministic MX and no-MX fixtures", async () => {
    await expect(
      new MockDnsMxResolver(true).resolve("acme.example"),
    ).resolves.toMatchObject({
      hasMx: true,
    });
    await expect(
      new MockDnsMxResolver(false).resolve("acme.example"),
    ).resolves.toEqual({
      hasMx: false,
      records: [],
    });
  });
});

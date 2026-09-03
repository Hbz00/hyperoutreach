import { describe, expect, it } from "vitest";

import {
  generateCandidateAddress,
  inferEmailPatterns,
  collapsedEmailNamePart,
  normalizeEmailNamePart,
  scoreEmailCandidate,
  unusedPublicSamples,
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

  /**
   * A hyphen in a first name is kept; a space is not.
   *
   * The one verified data point says a compound French first name keeps its
   * hyphen at fedex.com. Nothing anywhere says a multi-word surname gains a
   * separator it never had, so "Le Roué" still collapses — the rule preserves
   * what the name contains rather than inventing punctuation.
   */
  describe("name renderings", () => {
    it.each([
      [" Pierre-Yves ", "pierre-yves", "pierreyves"],
      [" Jean-Luc ", "jean-luc", "jeanluc"],
      // A space is not a hyphen: both renderings collapse it.
      [" Le Roué ", "leroue", "leroue"],
      [" de la Cruz ", "delacruz", "delacruz"],
      // An apostrophe is deliberately out of scope and still dropped.
      [" O’Brien ", "obrien", "obrien"],
      // Names with nothing inside them must render identically, or every
      // ordinary contact grows a second rung for no reason.
      [" Müller ", "muller", "muller"],
      [" José María ", "josemaria", "josemaria"],
      [" Smith ", "smith", "smith"],
    ])("renders %s", (raw, canonical, collapsed) => {
      expect(normalizeEmailNamePart(raw)).toBe(canonical);
      expect(collapsedEmailNamePart(raw)).toBe(collapsed);
    });
  });

  describe("a compound name confirms a convention either way it is written", () => {
    const source = "https://fedex.example/leadership";

    it("counts a hyphenated public sample", () => {
      // Before this, the sample matched no pattern and was discarded in
      // silence: the correct address of the very contact the resolver got
      // wrong contributed nothing.
      expect(
        inferEmailPatterns(
          [
            {
              firstName: "Pierre-yves",
              lastName: "Gudefin",
              email: "pierre-yves.gudefin@fedex.example",
              sourceUrl: source,
            },
          ],
          "fedex.example",
        ),
      ).toEqual([
        {
          pattern: "first.last",
          sampleCount: 1,
          sourceUrls: [source],
          preferredRendering: "hyphenated",
        },
      ]);
    });

    it("counts a collapsed public sample at a company that collapses", () => {
      expect(
        inferEmailPatterns(
          [
            {
              firstName: "Pierre-yves",
              lastName: "Gudefin",
              email: "pierreyves.gudefin@fedex.example",
              sourceUrl: source,
            },
          ],
          "fedex.example",
        ),
      ).toEqual([
        {
          pattern: "first.last",
          sampleCount: 1,
          sourceUrls: [source],
          preferredRendering: "collapsed",
        },
      ]);
    });
  });

  /**
   * When the corpus itself settles how this company writes a compound name.
   *
   * A sample whose own name contains a hyphen is the only kind that can answer
   * the question, and answering it from evidence beats guessing and paying a
   * bounce to find out. A sample with nothing inside its name says nothing
   * either way, and must not be read as agreement.
   */
  describe("the rendering a company's own samples proved", () => {
    const source = "https://acme.example/team";
    const sample = (firstName: string, email: string) => ({
      firstName,
      lastName: "Gudefin",
      email,
      sourceUrl: source,
    });

    it("prefers the collapsed spelling when a sample wrote it that way", () => {
      expect(
        inferEmailPatterns(
          [sample("Pierre-yves", "pierreyves.gudefin@acme.example")],
          "acme.example",
        )[0]?.preferredRendering,
      ).toBe("collapsed");
    });

    it("prefers the hyphenated spelling when a sample kept it", () => {
      expect(
        inferEmailPatterns(
          [sample("Pierre-yves", "pierre-yves.gudefin@acme.example")],
          "acme.example",
        )[0]?.preferredRendering,
      ).toBe("hyphenated");
    });

    it("stays silent when no sample had a compound name to settle it", () => {
      expect(
        inferEmailPatterns(
          [sample("Nora", "nora.gudefin@acme.example")],
          "acme.example",
        )[0]?.preferredRendering,
      ).toBeUndefined();
    });
  });

  /**
   * The samples the inference could not read.
   *
   * `inferEmailPatterns` drops a sample that names no convention, or more than
   * one, by continuing past it. That silence is what let a real run accept
   * `first.last` at 0.970 on five samples while seven others — every one of
   * them a real address at the same company — said something the code has no
   * pattern for. The count is the honest denominator behind a confidence, so
   * it has to be answerable.
   */
  describe("public samples the inference could not use", () => {
    // The recorded fedex.com evidence run, trimmed to the shapes that matter:
    // two the code reads, two it cannot.
    const fedex = [
      {
        firstName: "Patrick",
        lastName: "Fitzgerald",
        email: "patrick.fitzgerald@fedex.com",
        sourceUrl: "https://www.sec.gov/a",
      },
      {
        firstName: "Raj",
        lastName: "Subramaniam",
        email: "rsubramaniam@fedex.com",
        sourceUrl: "https://www.elliott.org/b",
      },
      {
        firstName: "Frederick",
        lastName: "Smith",
        email: "fwsmith@fedex.com",
        sourceUrl: "https://www.sec.gov/a",
      },
      {
        firstName: "David",
        lastName: "Bronczek",
        email: "djbronczek@fedex.com",
        sourceUrl: "https://www.sec.gov/a",
      },
    ];

    it("reports the on-domain samples no convention explains", () => {
      expect(
        unusedPublicSamples(fedex, "fedex.com").map((sample) => sample.email),
      ).toEqual(["fwsmith@fedex.com", "djbronczek@fedex.com"]);
    });

    it("says nothing about a sample from another company", () => {
      // Not evidence about this domain at all, so it is not evidence the
      // inference failed to read. Counting it would inflate the number that
      // exists to say "look here".
      expect(
        unusedPublicSamples(
          [
            {
              firstName: "Mallory",
              lastName: "Wrong",
              email: "mallory.wrong@other.example",
              sourceUrl: "https://other.example",
            },
          ],
          "fedex.com",
        ),
      ).toEqual([]);
    });

    it("reports a sample that names more than one convention", () => {
      // `j.smith` is both `first.last` and `f.last`. `inferEmailPatterns`
      // already refuses to let it confirm either, and the reason it was
      // dropped belongs in the same count as the ones nothing matched.
      expect(
        unusedPublicSamples(
          [
            {
              firstName: "J",
              lastName: "Smith",
              email: "j.smith@acme.example",
              sourceUrl: "https://acme.example/team/j-smith",
            },
          ],
          "acme.example",
        ).map((sample) => sample.email),
      ).toEqual(["j.smith@acme.example"]);
    });

    it("is empty when every sample was read", () => {
      expect(unusedPublicSamples(fedex.slice(0, 2), "fedex.com")).toEqual([]);
    });
  });

  it("normalizes Unicode, particles, apostrophes, and hyphens deterministically", () => {
    expect(normalizeEmailNamePart(" José María ")).toBe("josemaria");
    expect(normalizeEmailNamePart(" de la Cruz ")).toBe("delacruz");
    // Reversed deliberately, and this line is the record of it. Collapsing the
    // hyphen was an explicit choice here until delivery disproved it: the real
    // address of a real contact is `pierre-yves.gudefin@fedex.com`, verified by
    // the operator against Apollo, and Hyperoutreach had accepted
    // `pierreyves.gudefin@fedex.com` at 0.970. A hyphen inside a name is
    // information, and dropping it was never evidenced — it was the default
    // nobody had had a reason to question. The collapsed form is not lost: it
    // becomes the next rung of the ladder.
    expect(normalizeEmailNamePart(" D’Angelo-Smith ")).toBe("dangelo-smith");
    expect(collapsedEmailNamePart(" D’Angelo-Smith ")).toBe("dangelosmith");
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

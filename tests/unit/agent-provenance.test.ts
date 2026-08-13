import { describe, expect, it } from "vitest";

import {
  AgentProvenanceError,
  normalizeProvenanceUrl,
  validateAccountDiscoveryProvenance,
  validateAccountResearchProvenance,
  validateContactDiscoveryProvenance,
  validatePersonalizationProvenance,
} from "@/modules/agents/provenance";
import type { AgentResult } from "@/modules/agents/types";
import type {
  AccountDiscoveryOutput,
  AccountResearchOutput,
  ContactDiscoveryOutput,
  PersonalizationOutput,
  PersonalizationInput,
} from "@/modules/agents/schemas";

function result<T>(output: T, sources: Array<{ url: string }>): AgentResult<T> {
  return {
    responseId: "resp_provenance",
    model: "test-model",
    output,
    sources,
    usage: null,
    costUsd: null,
  };
}

const retrievedAt = "2026-08-12T00:00:00.000Z";

describe("agent web-search provenance", () => {
  it("normalizes provider URLs without fragments or default ports", () => {
    expect(normalizeProvenanceUrl("HTTPS://Example.COM:443/path/#claim")).toBe(
      "https://example.com/path",
    );
  });

  it("rejects account evidence absent from provider-declared sources", () => {
    const output: AccountDiscoveryOutput = {
      candidates: [
        {
          name: "Acme",
          domain: "acme.example",
          website: "https://acme.example",
          industry: null,
          employeeRange: null,
          country: null,
          confidence: 0.9,
          sources: [
            {
              url: "https://acme.example/about",
              title: "About",
              supports: ["identity", "domain"],
              retrievedAt,
            },
          ],
        },
      ],
    };
    expect(() =>
      validateAccountDiscoveryProvenance(
        result(output, [{ url: "https://search.example/unrelated" }]),
      ),
    ).toThrow(
      "Structured evidence URL was absent from provider-declared sources",
    );
    expect(() =>
      validateAccountDiscoveryProvenance(
        result(output, [{ url: "https://acme.example/about#result" }]),
      ),
    ).not.toThrow();
  });

  it("rejects a domain claim supported only by a different domain", () => {
    const output: AccountDiscoveryOutput = {
      candidates: [
        {
          name: "Acme",
          domain: "acme.example",
          website: null,
          industry: null,
          employeeRange: null,
          country: null,
          confidence: 0.8,
          sources: [
            {
              url: "https://other.example/directory/acme",
              title: "Directory",
              supports: ["identity", "domain"],
              retrievedAt,
            },
          ],
        },
      ],
    };
    expect(() =>
      validateAccountDiscoveryProvenance(
        result(output, [{ url: "https://other.example/directory/acme" }]),
      ),
    ).toThrow("domain claim");
  });

  it("rejects populated account fields without fact-level supports", () => {
    const output: AccountDiscoveryOutput = {
      candidates: [
        {
          name: "Acme",
          domain: "acme.example",
          website: "https://acme.example",
          industry: "Software",
          employeeRange: "51-200",
          country: "FR",
          confidence: 0.9,
          sources: [
            {
              url: "https://acme.example/about",
              title: "About",
              supports: ["identity", "domain"],
              retrievedAt,
            },
          ],
        },
      ],
    };
    expect(() =>
      validateAccountDiscoveryProvenance(
        result(output, [{ url: "https://acme.example/about" }]),
      ),
    ).toThrow("industry");
  });

  it.each([
    ["industry", { industry: "Software" }],
    ["country", { country: "FR" }],
    ["employee range", { employeeRange: "51-200" }],
    ["website", { website: "https://directory.example/acme" }],
  ] as const)(
    "rejects a domainless account with an unsupported %s claim",
    (claim, populatedField) => {
      const output: AccountDiscoveryOutput = {
        candidates: [
          {
            name: "Acme",
            domain: null,
            website: null,
            industry: null,
            employeeRange: null,
            country: null,
            confidence: 0.7,
            sources: [
              {
                url: "https://directory.example/acme",
                title: "Directory",
                supports: ["identity"],
                retrievedAt,
              },
            ],
            ...populatedField,
          },
        ],
      };

      expect(() =>
        validateAccountDiscoveryProvenance(
          result(output, [{ url: "https://directory.example/acme" }]),
        ),
      ).toThrow(claim);
    },
  );

  it("requires every research signal URL in evidence with signal support", () => {
    const output: AccountResearchOutput = {
      facts: {
        summary: "Acme is expanding.",
        industry: null,
        employeeRange: null,
        country: null,
        website: null,
      },
      signals: [
        {
          name: "Expansion",
          description: "Acme opened a new office.",
          observedAt: retrievedAt,
          confidence: 0.9,
          sourceUrls: ["https://acme.example/news"],
        },
      ],
      sources: [
        {
          url: "https://acme.example/about",
          title: "About",
          supports: ["fact"],
          retrievedAt,
        },
      ],
      confidence: 0.9,
      researchedAt: retrievedAt,
    };
    expect(() =>
      validateAccountResearchProvenance(
        result(output, [
          { url: "https://acme.example/news" },
          { url: "https://acme.example/about" },
        ]),
      ),
    ).toThrow("signal evidence");
  });

  it("requires every populated research fact to have matching support", () => {
    const output: AccountResearchOutput = {
      facts: {
        summary: "Acme is a software company in France.",
        industry: "Software",
        employeeRange: "51-200",
        country: "FR",
        website: "https://acme.example",
      },
      signals: [],
      sources: [
        {
          url: "https://acme.example/about",
          title: "About",
          supports: ["fact", "domain"],
          retrievedAt,
        },
      ],
      confidence: 0.9,
      researchedAt: retrievedAt,
    };
    expect(() =>
      validateAccountResearchProvenance(
        result(output, [{ url: "https://acme.example/about" }]),
      ),
    ).toThrow("industry");
  });

  it("rejects non-HTTP provenance URLs", () => {
    expect(() => normalizeProvenanceUrl("javascript:alert(1)")).toThrow(
      "HTTP or HTTPS",
    );
  });

  it("rejects contact URLs absent from provider-declared sources", () => {
    const contacts: ContactDiscoveryOutput = {
      contacts: [
        {
          firstName: "Alice",
          lastName: "Martin",
          jobTitle: "VP Sales",
          linkedinUrl: "https://www.linkedin.com/in/alice-martin",
          confidence: 0.9,
          evidence: [
            {
              url: "https://acme.example/team/alice",
              title: "Team",
              supports: ["employment", "job_title"],
              retrievedAt,
            },
          ],
        },
      ],
    };
    expect(() =>
      validateContactDiscoveryProvenance(
        result(contacts, [{ url: "https://example.com/wrong" }]),
      ),
    ).toThrow(AgentProvenanceError);
  });

  it("accepts personalization evidence from trusted input without web search and rejects hallucinations", () => {
    const personalization: PersonalizationOutput = {
      fields: [
        {
          name: "company_relevance",
          value: "Acme is expanding.",
          confidence: 0.9,
          sourceUrls: ["https://acme.example/news"],
        },
      ],
      sources: [
        {
          url: "https://acme.example/news",
          title: "News",
          supports: ["personalization"],
          retrievedAt,
        },
      ],
    };
    const input: PersonalizationInput = {
      declaredFields: ["company_relevance"],
      trustedSourceUrls: ["https://acme.example/news"],
      context: {
        company: "Acme",
        firstName: "Alice",
        jobTitle: "VP Sales",
        research: {},
      },
    };
    expect(() =>
      validatePersonalizationProvenance(input, result(personalization, [])),
    ).not.toThrow();
    expect(() =>
      validatePersonalizationProvenance(
        { ...input, trustedSourceUrls: ["https://acme.example/about"] },
        result(personalization, []),
      ),
    ).toThrow(AgentProvenanceError);
  });
});

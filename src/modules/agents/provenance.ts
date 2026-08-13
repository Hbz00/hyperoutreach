import type {
  AccountDiscoveryOutput,
  AccountResearchOutput,
  ContactDiscoveryOutput,
  PersonalizationOutput,
  PersonalizationInput,
} from "@/modules/agents/schemas";
import type { AgentResult } from "@/modules/agents/types";
import { normalizeDomain } from "@/modules/prospects/normalization";

export class AgentProvenanceError extends Error {
  override readonly name = "AgentProvenanceError";
}

export function normalizeProvenanceUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new AgentProvenanceError("Agent evidence URL is invalid");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new AgentProvenanceError("Agent evidence URL must use HTTP or HTTPS");
  }
  parsed.hash = "";
  parsed.hostname = parsed.hostname.toLocaleLowerCase("en-US");
  if (
    (parsed.protocol === "https:" && parsed.port === "443") ||
    (parsed.protocol === "http:" && parsed.port === "80")
  ) {
    parsed.port = "";
  }
  if (parsed.pathname !== "/")
    parsed.pathname = parsed.pathname.replace(/\/+$/, "");
  return parsed.toString().replace(/\/$/, "");
}

function actualSourceUrls(result: AgentResult<unknown>): Set<string> {
  return new Set(
    result.sources.map((source) => normalizeProvenanceUrl(source.url)),
  );
}

function requireActualSources(
  result: AgentResult<unknown>,
  urls: Iterable<string>,
): void {
  const actual = actualSourceUrls(result);
  for (const url of urls) {
    if (!actual.has(normalizeProvenanceUrl(url))) {
      throw new AgentProvenanceError(
        "Structured evidence URL was absent from provider-declared sources",
      );
    }
  }
}

function hostSupportsDomain(url: string, domain: string): boolean {
  const hostname = new URL(normalizeProvenanceUrl(url)).hostname;
  const normalizedDomain = normalizeDomain(domain);
  return (
    hostname === normalizedDomain || hostname.endsWith(`.${normalizedDomain}`)
  );
}

function requireClaimSupport(
  claim: string,
  value: unknown,
  sources: Array<{ supports: string[] }>,
  support: string,
): void {
  if (value === null || value === undefined) return;
  if (!sources.some((source) => source.supports.includes(support))) {
    throw new AgentProvenanceError(
      `Account ${claim} claim requires matching ${support} evidence`,
    );
  }
}

export function validateAccountDiscoveryProvenance(
  result: AgentResult<AccountDiscoveryOutput>,
): void {
  const urls = result.output.candidates.flatMap((candidate) =>
    candidate.sources.map((source) => source.url),
  );
  requireActualSources(result, urls);
  for (const candidate of result.output.candidates) {
    if (candidate.domain) {
      const supported = candidate.sources.some(
        (source) =>
          source.supports.includes("domain") &&
          hostSupportsDomain(source.url, candidate.domain!),
      );
      if (!supported) {
        throw new AgentProvenanceError(
          "Account domain claim requires a source on the claimed domain",
        );
      }
    }
    requireClaimSupport(
      "industry",
      candidate.industry,
      candidate.sources,
      "industry",
    );
    requireClaimSupport(
      "country",
      candidate.country,
      candidate.sources,
      "country",
    );
    requireClaimSupport(
      "employee range",
      candidate.employeeRange,
      candidate.sources,
      "employee_range",
    );
    requireClaimSupport(
      "website",
      candidate.website,
      candidate.sources,
      "domain",
    );
  }
}

export function validateAccountResearchProvenance(
  result: AgentResult<AccountResearchOutput>,
): void {
  requireActualSources(
    result,
    result.output.sources.map((source) => source.url),
  );
  const evidenceByUrl = new Map(
    result.output.sources.map((source) => [
      normalizeProvenanceUrl(source.url),
      source,
    ]),
  );
  requireClaimSupport(
    "summary",
    result.output.facts.summary,
    result.output.sources,
    "fact",
  );
  requireClaimSupport(
    "industry",
    result.output.facts.industry,
    result.output.sources,
    "industry",
  );
  requireClaimSupport(
    "country",
    result.output.facts.country,
    result.output.sources,
    "country",
  );
  requireClaimSupport(
    "employee range",
    result.output.facts.employeeRange,
    result.output.sources,
    "employee_range",
  );
  requireClaimSupport(
    "website",
    result.output.facts.website,
    result.output.sources,
    "domain",
  );
  for (const signal of result.output.signals) {
    requireActualSources(result, signal.sourceUrls);
    for (const sourceUrl of signal.sourceUrls) {
      const evidence = evidenceByUrl.get(normalizeProvenanceUrl(sourceUrl));
      if (!evidence?.supports.includes("signal")) {
        throw new AgentProvenanceError(
          "Every signal URL requires matching signal evidence",
        );
      }
    }
  }
}

export function validateContactDiscoveryProvenance(
  result: AgentResult<ContactDiscoveryOutput>,
): void {
  requireActualSources(
    result,
    result.output.contacts.flatMap((contact) =>
      contact.evidence.map((source) => source.url),
    ),
  );
}

export function validatePersonalizationProvenance(
  input: PersonalizationInput,
  result: AgentResult<PersonalizationOutput>,
): void {
  const trustedSources = new Set(
    input.trustedSourceUrls.map((url) => normalizeProvenanceUrl(url)),
  );
  for (const source of result.output.sources) {
    if (!trustedSources.has(normalizeProvenanceUrl(source.url))) {
      throw new AgentProvenanceError(
        "Personalization evidence URL was absent from trusted research input",
      );
    }
  }
  const evidenceByUrl = new Map(
    result.output.sources.map((source) => [
      normalizeProvenanceUrl(source.url),
      source,
    ]),
  );
  for (const field of result.output.fields) {
    for (const sourceUrl of field.sourceUrls) {
      const evidence = evidenceByUrl.get(normalizeProvenanceUrl(sourceUrl));
      if (!evidence?.supports.includes("personalization")) {
        throw new AgentProvenanceError(
          "Personalization source requires matching personalization evidence",
        );
      }
    }
  }
}

export function validatePersonalizationPostconditions(
  input: PersonalizationInput,
  result: AgentResult<PersonalizationOutput>,
): void {
  validatePersonalizationProvenance(input, result);
  const declared = new Set(input.declaredFields);
  const returned = new Set<string>();
  for (const field of result.output.fields) {
    if (!declared.has(field.name)) {
      throw new AgentProvenanceError(
        "Personalization returned an undeclared reasoning field",
      );
    }
    if (returned.has(field.name)) {
      throw new AgentProvenanceError(
        "Personalization returned a duplicate reasoning field",
      );
    }
    returned.add(field.name);
  }
  if (returned.size !== declared.size) {
    throw new AgentProvenanceError(
      "Personalization omitted a declared reasoning field",
    );
  }
}

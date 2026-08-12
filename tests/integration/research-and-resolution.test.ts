import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as schema from "@/lib/db/schema";
import { resolveDatabaseUrls } from "@/lib/db/test-database";
import type {
  AccountDiscoveryAgent,
  AccountResearchAgent,
  ContactDiscoveryAgent,
  PersonalizationAgent,
} from "@/modules/agents/contracts";
import type {
  AccountDiscoveryOutput,
  AccountResearchOutput,
  ContactDiscoveryOutput,
  PersonalizationOutput,
} from "@/modules/agents/schemas";
import type { AgentResult } from "@/modules/agents/types";
import { OpenAIReplyClassifier } from "@/modules/agents/openai-agents";
import type { StructuredAIProvider } from "@/modules/agents/openai-agents";
import { createOrGetAccount } from "@/modules/accounts/service";
import {
  createDraftCampaign,
  enrollContact,
  publishCampaignVersion,
} from "@/modules/campaigns/service";
import { createOrGetContact } from "@/modules/contacts/service";
import { MockDnsMxResolver } from "@/modules/email-resolution/dns";
import type {
  DnsMxResolver,
  MxResolution,
} from "@/modules/email-resolution/dns";
import {
  NoResultEmailEnrichmentProvider,
  StaticEmailEnrichmentProvider,
  TransientEmailEnrichmentProvider,
} from "@/modules/email-resolution/providers";
import { resolveContactEmail as resolveContactEmailService } from "@/modules/email-resolution/service";
import {
  OpenAIPublicEmailEvidenceProvider,
  StaticPublicEmailEvidenceProvider,
} from "@/modules/email-resolution/public-evidence-provider";
import { generateOutreachProposal } from "@/modules/messages/generation-service";
import { reviewMessage } from "@/modules/messages/review-service";
import { sendApprovedMessage } from "@/modules/messages/send-service";
import { MockMailProvider } from "@/modules/mailboxes/mock-mail-provider";
import { discoverAccounts } from "@/modules/research/account-discovery-service";
import { researchAccount } from "@/modules/research/account-research-service";
import { discoverContacts } from "@/modules/research/contact-discovery-service";
import { personalizeReasoningFields } from "@/modules/research/personalization-service";
import { classifyReplyWithAudit } from "@/modules/replies/classification-service";

const { testUrl } = resolveDatabaseUrls(process.env);
const client = postgres(testUrl, { max: 5 });
const db = drizzle(client, { schema });

function result<T>(output: T, model = "mock-model"): AgentResult<T> {
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
  return {
    responseId: "resp_fixture",
    model,
    output,
    sources: [...sourceUrls].map((url) => ({ url })),
    usage: { inputTokens: 120, outputTokens: 30, totalTokens: 150 },
    costUsd: 0.0123,
  };
}

class AccountDiscoveryFixture implements AccountDiscoveryAgent {
  readonly name = "account_discovery";
  readonly model = "mock-research";
  readonly promptVersion = "account-discovery-prompt-v1";
  readonly schemaVersion = "account-discovery-schema-v1";
  calls = 0;
  constructor(private readonly output: AccountDiscoveryOutput) {}
  async discover(): Promise<AgentResult<AccountDiscoveryOutput>> {
    this.calls += 1;
    return result(this.output, this.model);
  }
}

class AccountResearchFixture implements AccountResearchAgent {
  readonly name = "account_research";
  readonly model = "mock-research";
  readonly promptVersion = "account-research-prompt-v1";
  readonly schemaVersion = "account-research-schema-v1";
  calls = 0;
  constructor(private readonly output: AccountResearchOutput) {}
  async research(): Promise<AgentResult<AccountResearchOutput>> {
    this.calls += 1;
    return result(this.output, this.model);
  }
}

class ContactDiscoveryFixture implements ContactDiscoveryAgent {
  readonly name = "contact_discovery";
  readonly model = "mock-research";
  readonly promptVersion = "contact-discovery-prompt-v1";
  readonly schemaVersion = "contact-discovery-schema-v1";
  calls = 0;
  constructor(private readonly output: ContactDiscoveryOutput) {}
  async discover(): Promise<AgentResult<ContactDiscoveryOutput>> {
    this.calls += 1;
    return result(this.output, this.model);
  }
}

class PersonalizationFixture implements PersonalizationAgent {
  readonly name = "personalization";
  readonly model = "mock-fast";
  readonly promptVersion = "personalization-prompt-v1";
  readonly schemaVersion = "personalization-schema-v1";
  constructor(private readonly output: PersonalizationOutput) {}
  async personalize(): Promise<AgentResult<PersonalizationOutput>> {
    return result(this.output, this.model);
  }
}

const retrievedAt = "2026-08-12T00:00:00.000Z";

async function resolveContactEmail(
  database: typeof db,
  dnsResolver: Parameters<typeof resolveContactEmailService>[1],
  enrichmentProvider: Parameters<typeof resolveContactEmailService>[2],
  input: {
    contactId: string;
    publicSamples: ConstructorParameters<
      typeof StaticPublicEmailEvidenceProvider
    >[0];
    confidenceThreshold?: number;
  },
  options: Parameters<typeof resolveContactEmailService>[4] = {},
) {
  return resolveContactEmailService(
    database,
    dnsResolver,
    enrichmentProvider,
    {
      contactId: input.contactId,
      ...(input.confidenceThreshold === undefined
        ? {}
        : { confidenceThreshold: input.confidenceThreshold }),
    },
    {
      ...options,
      publicEvidenceProvider: new StaticPublicEmailEvidenceProvider(
        input.publicSamples,
      ),
    },
  );
}

async function accountAndContact(suffix: string, evidencedDomain = true) {
  const domain = `${suffix}.example`;
  const account = await createOrGetAccount(db, {
    name: `${suffix} Account`,
    domain,
  });
  if (!account.ok) throw new Error("Account fixture failed");
  if (evidencedDomain) {
    await db.insert(schema.evidenceSources).values({
      accountId: account.account.id,
      url: `https://${domain}/about`,
      sourceType: "company_website",
      supports: ["identity", "domain"],
      confidence: "0.990",
    });
  }
  const contact = await createOrGetContact(db, {
    accountId: account.account.id,
    firstName: "Alice",
    lastName: suffix,
    jobTitle: "VP Sales",
  });
  if (!contact.ok) throw new Error("Contact fixture failed");
  return { account: account.account, contact: contact.contact, domain };
}

describe("database-backed research and email resolution", () => {
  beforeAll(async () => {
    await client.unsafe("drop schema if exists public cascade");
    await client.unsafe("drop schema if exists drizzle cascade");
    await client.unsafe("create schema public");
    await migrate(drizzle(client), { migrationsFolder: "drizzle" });
  });

  afterAll(async () => {
    await client.end();
  });

  it("deduplicates discovered accounts while persisting evidence and one complete agent run", async () => {
    const candidate: AccountDiscoveryOutput["candidates"][number] = {
      name: "Discovery Acme",
      domain: "discovery-acme.example",
      website: "https://discovery-acme.example",
      industry: "Software",
      employeeRange: "51-200",
      country: "FR",
      confidence: 0.93,
      sources: [
        {
          url: "https://discovery-acme.example/about",
          title: "About",
          supports: [
            "identity",
            "domain",
            "industry",
            "employee_range",
            "country",
          ],
          retrievedAt,
        },
      ],
    };
    const agent = new AccountDiscoveryFixture({
      candidates: [candidate, { ...candidate, name: "Discovery Acme SAS" }],
    });

    const discovered = await discoverAccounts(db, agent, {
      icp: "French B2B software companies serving finance teams",
      limit: 10,
      countries: ["FR"],
      industries: ["Software"],
    });
    expect(discovered.ok).toBe(true);
    if (!discovered.ok) return;
    expect(discovered.accounts).toHaveLength(1);

    const accounts = await db
      .select()
      .from(schema.accounts)
      .where(eq(schema.accounts.domain, "discovery-acme.example"));
    expect(accounts).toHaveLength(1);
    const evidence = await db
      .select()
      .from(schema.evidenceSources)
      .where(eq(schema.evidenceSources.accountId, accounts[0]!.id));
    expect(evidence).toHaveLength(1);
    expect(evidence[0]?.supports).toContain("domain");
    const [run] = await db
      .select()
      .from(schema.agentRuns)
      .where(eq(schema.agentRuns.id, discovered.agentRunId));
    expect(run).toMatchObject({
      agent: "account_discovery",
      responseId: "resp_fixture",
      model: "mock-research",
      promptVersion: "account-discovery-prompt-v1",
      schemaVersion: "account-discovery-schema-v1",
      status: "succeeded",
      error: null,
      tokenUsage: { inputTokens: 120, outputTokens: 30, totalTokens: 150 },
      toolUsage: null,
      costAvailability: "available",
    });
    expect(run?.output).toBeTruthy();
    expect(run?.sources).toEqual([
      { url: "https://discovery-acme.example/about" },
    ]);
    expect(run?.completedAt).not.toBeNull();
  });

  it("uses server-observed retrieval time and refreshes repeated evidence", async () => {
    const sourceUrl = "https://evidence-refresh.example/about";
    const baseCandidate: AccountDiscoveryOutput["candidates"][number] = {
      name: "Evidence Refresh",
      domain: "evidence-refresh.example",
      website: null,
      industry: null,
      employeeRange: null,
      country: null,
      confidence: 0.5,
      sources: [
        {
          url: sourceUrl,
          title: "Old title",
          supports: ["identity", "domain"],
          retrievedAt: "2000-01-01T00:00:00.000Z",
        },
      ],
    };
    const observedAfter = new Date();
    const first = await discoverAccounts(
      db,
      new AccountDiscoveryFixture({ candidates: [baseCandidate] }),
      {
        icp: "Companies selected to verify evidence refresh behavior",
        limit: 1,
        countries: [],
        industries: [],
      },
    );
    if (!first.ok) throw new Error(first.message);
    const second = await discoverAccounts(
      db,
      new AccountDiscoveryFixture({
        candidates: [
          {
            ...baseCandidate,
            confidence: 0.95,
            sources: [
              {
                ...baseCandidate.sources[0]!,
                title: "Fresh title",
                supports: ["identity", "domain", "industry"],
              },
            ],
          },
        ],
      }),
      {
        icp: "Companies selected to verify evidence refresh behavior",
        limit: 1,
        countries: [],
        industries: [],
      },
    );
    if (!second.ok) throw new Error(second.message);
    const [evidence] = await db
      .select()
      .from(schema.evidenceSources)
      .where(eq(schema.evidenceSources.url, sourceUrl));
    expect(evidence).toMatchObject({
      title: "Fresh title",
      supports: ["identity", "domain", "industry"],
      confidence: "0.950",
      metadata: { agentRunId: second.agentRunId },
    });
    expect(evidence!.retrievedAt.getTime()).toBeGreaterThanOrEqual(
      observedAfter.getTime(),
    );
  });

  it("deduplicates domain and domainless account candidates regardless of order or concurrency", async () => {
    const sources = [
      {
        url: "https://deterministic-account.example/about",
        title: "About",
        supports: ["identity", "domain"] as const,
        retrievedAt,
      },
    ];
    const strong: AccountDiscoveryOutput["candidates"][number] = {
      name: "Deterministic Account",
      domain: "deterministic-account.example",
      website: null,
      industry: null,
      employeeRange: null,
      country: null,
      confidence: 0.9,
      sources: sources.map((source) => ({
        ...source,
        supports: [...source.supports],
      })),
    };
    const weak: AccountDiscoveryOutput["candidates"][number] = {
      ...strong,
      domain: null,
      sources: sources.map((source) => ({ ...source, supports: ["identity"] })),
    };
    const input = {
      icp: "Deterministic account identity under candidate ordering",
      limit: 2,
      countries: [],
      industries: [],
    };
    expect(
      await discoverAccounts(
        db,
        new AccountDiscoveryFixture({ candidates: [strong, weak] }),
        input,
      ),
    ).toMatchObject({ ok: true, accounts: [expect.any(Object)] });

    const concurrentStrong = {
      ...strong,
      name: "Concurrent Merge Account",
      domain: "concurrent-merge-account.example",
      sources: [
        {
          ...strong.sources[0]!,
          url: "https://concurrent-merge-account.example/about",
        },
      ],
    };
    const concurrentWeak = {
      ...weak,
      name: "Concurrent Merge Account",
      sources: [
        {
          ...weak.sources[0]!,
          url: "https://concurrent-merge-account.example/about",
        },
      ],
    };
    const outcomes = await Promise.all([
      discoverAccounts(
        db,
        new AccountDiscoveryFixture({ candidates: [concurrentStrong] }),
        { ...input, limit: 1 },
      ),
      discoverAccounts(
        db,
        new AccountDiscoveryFixture({ candidates: [concurrentWeak] }),
        { ...input, limit: 1 },
      ),
    ]);
    expect(outcomes).toEqual([
      expect.objectContaining({ ok: true }),
      expect.objectContaining({ ok: true }),
    ]);
    expect(
      await db
        .select()
        .from(schema.accounts)
        .where(eq(schema.accounts.normalizedName, "concurrent merge account")),
    ).toHaveLength(1);
  });

  it("fails provenance-mismatched discovery without persisting model claims", async () => {
    const output: AccountDiscoveryOutput = {
      candidates: [
        {
          name: "Hallucinated Account",
          domain: "hallucinated-account.example",
          website: null,
          industry: null,
          employeeRange: null,
          country: null,
          confidence: 0.9,
          sources: [
            {
              url: "https://hallucinated-account.example/about",
              title: "Invented source",
              supports: ["identity", "domain"],
              retrievedAt,
            },
          ],
        },
      ],
    };
    class MismatchedDiscovery extends AccountDiscoveryFixture {
      override async discover(): Promise<AgentResult<AccountDiscoveryOutput>> {
        this.calls += 1;
        return {
          ...result(output, this.model),
          sources: [{ url: "https://search.example/unrelated-result" }],
        };
      }
    }
    const failed = await discoverAccounts(db, new MismatchedDiscovery(output), {
      icp: "A sufficiently precise target for provenance validation",
      limit: 5,
      countries: [],
      industries: [],
    });
    expect(failed).toMatchObject({ ok: false, code: "AGENT_ERROR" });
    expect(
      await db
        .select()
        .from(schema.accounts)
        .where(eq(schema.accounts.domain, "hallucinated-account.example")),
    ).toHaveLength(0);
    const [run] = await db
      .select()
      .from(schema.agentRuns)
      .where(
        and(
          eq(schema.agentRuns.agent, "account_discovery"),
          eq(schema.agentRuns.status, "failed"),
        ),
      )
      .orderBy(schema.agentRuns.createdAt)
      .limit(1);
    expect(run).toMatchObject({
      status: "failed",
      output: null,
      sources: [],
      error: "Agent execution failed (AgentProvenanceError)",
    });
  });

  it("researches an account once for multiple contacts, reuses fresh data, and force refreshes", async () => {
    const fixture = await accountAndContact("research-shared");
    await createOrGetContact(db, {
      accountId: fixture.account.id,
      firstName: "Bob",
      lastName: "Shared",
      jobTitle: "Head of Sales",
    });
    const agent = new AccountResearchFixture({
      facts: {
        summary: "Shared account research",
        industry: "Software",
        employeeRange: "51-200",
        country: "FR",
        website: `https://${fixture.domain}`,
      },
      signals: [
        {
          name: "Expansion",
          description: "Expanding its sales team",
          observedAt: retrievedAt,
          confidence: 0.88,
          sourceUrls: [`https://${fixture.domain}/jobs`],
        },
      ],
      sources: [
        {
          url: `https://${fixture.domain}/jobs`,
          title: "Jobs",
          supports: [
            "fact",
            "domain",
            "industry",
            "employee_range",
            "country",
            "signal",
          ],
          retrievedAt,
        },
      ],
      confidence: 0.91,
      researchedAt: retrievedAt,
    });

    const first = await researchAccount(db, agent, {
      accountId: fixture.account.id,
      now: new Date("2026-08-12T01:00:00.000Z"),
    });
    const reused = await researchAccount(db, agent, {
      accountId: fixture.account.id,
      now: new Date("2026-08-12T02:00:00.000Z"),
    });
    const forced = await researchAccount(db, agent, {
      accountId: fixture.account.id,
      force: true,
      now: new Date("2026-08-12T03:00:00.000Z"),
    });
    expect(first).toMatchObject({ ok: true, disposition: "researched" });
    expect(reused).toMatchObject({ ok: true, disposition: "reused" });
    expect(forced).toMatchObject({ ok: true, disposition: "researched" });
    expect(agent.calls).toBe(2);
    const [stored] = await db
      .select()
      .from(schema.accounts)
      .where(eq(schema.accounts.id, fixture.account.id));
    expect(stored).toMatchObject({
      researchStatus: "complete",
      researchSnapshot: { facts: { summary: "Shared account research" } },
    });
    const researchRuns = await db
      .select()
      .from(schema.agentRuns)
      .where(eq(schema.agentRuns.agent, "account_research"));
    expect(researchRuns).toHaveLength(2);
  });

  it("allows only one concurrent research owner and exposes in-progress state", async () => {
    const fixture = await accountAndContact("research-concurrent");
    const output: AccountResearchOutput = {
      facts: {
        summary: "Concurrent snapshot",
        industry: null,
        employeeRange: null,
        country: null,
        website: null,
      },
      signals: [],
      sources: [
        {
          url: `https://${fixture.domain}/about`,
          title: "About",
          supports: ["fact"],
          retrievedAt,
        },
      ],
      confidence: 0.9,
      researchedAt: retrievedAt,
    };
    let release!: () => void;
    let started!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    class BlockingAgent extends AccountResearchFixture {
      override async research(): Promise<AgentResult<AccountResearchOutput>> {
        this.calls += 1;
        started();
        await released;
        return result(output, this.model);
      }
    }
    const agent = new BlockingAgent(output);
    const firstPromise = researchAccount(db, agent, {
      accountId: fixture.account.id,
      now: new Date("2026-08-12T04:00:00.000Z"),
    });
    await entered;

    const concurrent = await researchAccount(db, agent, {
      accountId: fixture.account.id,
      now: new Date("2026-08-12T04:00:01.000Z"),
    });
    expect(concurrent).toMatchObject({ ok: true, disposition: "in_progress" });
    expect(agent.calls).toBe(1);

    release();
    const first = await firstPromise;
    expect(first).toMatchObject({
      ok: true,
      disposition: "researched",
    });
  });

  it("takes over a crashed stale research claim", async () => {
    const fixture = await accountAndContact("research-stale");
    await db
      .update(schema.accounts)
      .set({
        researchStatus: "in_progress",
        researchClaimId: "crashed-owner",
        researchClaimedAt: new Date("2026-08-12T01:00:00.000Z"),
      })
      .where(eq(schema.accounts.id, fixture.account.id));
    const agent = new AccountResearchFixture({
      facts: {
        summary: "Recovered snapshot",
        industry: null,
        employeeRange: null,
        country: null,
        website: null,
      },
      signals: [],
      sources: [
        {
          url: `https://${fixture.domain}/about`,
          title: "About",
          supports: ["fact"],
          retrievedAt,
        },
      ],
      confidence: 0.91,
      researchedAt: retrievedAt,
    });

    const recovered = await researchAccount(db, agent, {
      accountId: fixture.account.id,
      now: new Date("2026-08-12T01:10:00.000Z"),
      claimLeaseMs: 60_000,
    });
    expect(recovered).toMatchObject({ ok: true, disposition: "researched" });
    expect(agent.calls).toBe(1);
    const [stored] = await db
      .select()
      .from(schema.accounts)
      .where(eq(schema.accounts.id, fixture.account.id));
    expect(stored).toMatchObject({
      researchStatus: "complete",
      researchClaimId: null,
      researchClaimedAt: null,
      researchSnapshot: { facts: { summary: "Recovered snapshot" } },
    });
  });

  it("does not let a stale owner's late failure overwrite newer research", async () => {
    const fixture = await accountAndContact("research-late-owner");
    const oldOutput: AccountResearchOutput = {
      facts: {
        summary: "Old snapshot",
        industry: null,
        employeeRange: null,
        country: null,
        website: null,
      },
      signals: [],
      sources: [
        {
          url: `https://${fixture.domain}/old`,
          title: "Old",
          supports: ["fact"],
          retrievedAt,
        },
      ],
      confidence: 0.8,
      researchedAt: retrievedAt,
    };
    let release!: () => void;
    let started!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    class LateFailingAgent extends AccountResearchFixture {
      override async research(): Promise<AgentResult<AccountResearchOutput>> {
        this.calls += 1;
        started();
        await released;
        throw new Error("late owner failed");
      }
    }
    const oldPromise = researchAccount(db, new LateFailingAgent(oldOutput), {
      accountId: fixture.account.id,
      now: new Date("2026-08-12T05:00:00.000Z"),
      claimLeaseMs: 60_000,
    });
    await entered;
    const newer = await researchAccount(
      db,
      new AccountResearchFixture({
        ...oldOutput,
        facts: { ...oldOutput.facts, summary: "Newer snapshot" },
        sources: [
          {
            url: `https://${fixture.domain}/newer`,
            title: "Newer",
            supports: ["fact"],
            retrievedAt,
          },
        ],
      }),
      {
        accountId: fixture.account.id,
        now: new Date("2026-08-12T05:02:00.000Z"),
        claimLeaseMs: 60_000,
      },
    );
    expect(newer).toMatchObject({ ok: true, disposition: "researched" });
    release();
    await expect(oldPromise).resolves.toMatchObject({
      ok: false,
      code: "AGENT_ERROR",
    });
    const [stored] = await db
      .select()
      .from(schema.accounts)
      .where(eq(schema.accounts.id, fixture.account.id));
    expect(stored).toMatchObject({
      researchStatus: "complete",
      researchClaimId: null,
      researchSnapshot: { facts: { summary: "Newer snapshot" } },
    });
  });

  it("reports the stored newer snapshot when a stale owner succeeds late", async () => {
    const fixture = await accountAndContact("research-late-success");
    const output = (summary: string, path: string): AccountResearchOutput => ({
      facts: {
        summary,
        industry: null,
        employeeRange: null,
        country: null,
        website: null,
      },
      signals: [],
      sources: [
        {
          url: `https://${fixture.domain}/${path}`,
          title: summary,
          supports: ["fact"],
          retrievedAt,
        },
      ],
      confidence: 0.9,
      researchedAt: retrievedAt,
    });
    let release!: () => void;
    let started!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    class LateSuccessAgent extends AccountResearchFixture {
      override async research(): Promise<AgentResult<AccountResearchOutput>> {
        this.calls += 1;
        started();
        await released;
        return result(output("Old late snapshot", "old-late"), this.model);
      }
    }
    const oldPromise = researchAccount(
      db,
      new LateSuccessAgent(output("Old late snapshot", "old-late")),
      {
        accountId: fixture.account.id,
        now: new Date("2026-08-12T06:00:00.000Z"),
        claimLeaseMs: 60_000,
      },
    );
    await entered;
    await expect(
      researchAccount(
        db,
        new AccountResearchFixture(output("New winning snapshot", "winner")),
        {
          accountId: fixture.account.id,
          now: new Date("2026-08-12T06:02:00.000Z"),
          claimLeaseMs: 60_000,
        },
      ),
    ).resolves.toMatchObject({ ok: true, disposition: "researched" });
    release();
    await expect(oldPromise).resolves.toMatchObject({
      ok: true,
      disposition: "reused",
      snapshot: { facts: { summary: "New winning snapshot" } },
    });
  });

  it("globally deduplicates discovered contacts and persists role evidence and personalization audit", async () => {
    const account = await createOrGetAccount(db, {
      name: "Contact Discovery",
      domain: "contact-discovery.example",
    });
    if (!account.ok) throw new Error("Account fixture failed");
    const contactOutput: ContactDiscoveryOutput["contacts"][number] = {
      firstName: "Chloé",
      lastName: "D’Angelo",
      jobTitle: "VP Sales",
      linkedinUrl: "https://www.linkedin.com/in/chloe-dangelo",
      confidence: 0.94,
      evidence: [
        {
          url: "https://contact-discovery.example/team/chloe",
          title: "Team",
          supports: ["employment", "job_title"],
          retrievedAt,
        },
      ],
    };
    const discovered = await discoverContacts(
      db,
      new ContactDiscoveryFixture({ contacts: [contactOutput, contactOutput] }),
      { accountId: account.account.id, roles: ["VP Sales"], limit: 10 },
    );
    expect(discovered.ok).toBe(true);
    if (!discovered.ok) return;
    expect(discovered.contacts).toHaveLength(1);
    const evidence = await db
      .select()
      .from(schema.evidenceSources)
      .where(eq(schema.evidenceSources.contactId, discovered.contacts[0]!.id));
    expect(evidence[0]?.supports).toEqual(["employment", "job_title"]);

    const personalized = await personalizeReasoningFields(
      db,
      new PersonalizationFixture({
        fields: [
          {
            name: "company_relevance",
            value: "The team is expanding internationally.",
            confidence: 0.9,
            sourceUrls: ["https://contact-discovery.example/news"],
          },
        ],
        sources: [
          {
            url: "https://contact-discovery.example/news",
            title: "News",
            supports: ["personalization"],
            retrievedAt,
          },
        ],
      }),
      {
        declaredFields: ["company_relevance"],
        trustedSourceUrls: ["https://contact-discovery.example/news"],
        context: {
          company: "Contact Discovery",
          firstName: "Chloé",
          jobTitle: "VP Sales",
          research: {},
        },
      },
    );
    expect(personalized.ok).toBe(true);
    if (!personalized.ok) return;
    const [run] = await db
      .select()
      .from(schema.agentRuns)
      .where(eq(schema.agentRuns.id, personalized.agentRunId));
    expect(run).toMatchObject({
      agent: "personalization",
      status: "succeeded",
    });
  });

  it("moves a globally identified contact only with validated current-employment evidence", async () => {
    const oldAccount = await createOrGetAccount(db, {
      name: "Former Employer",
      domain: "former-employer.example",
    });
    const newAccount = await createOrGetAccount(db, {
      name: "Current Employer",
      domain: "current-employer.example",
    });
    if (!oldAccount.ok || !newAccount.ok)
      throw new Error("Account fixture failed");
    const existing = await createOrGetContact(db, {
      accountId: oldAccount.account.id,
      firstName: "Ada",
      lastName: "Lovelace",
      jobTitle: "Director",
      linkedinUrl: "https://linkedin.com/in/ada-lovelace/",
    });
    if (!existing.ok) throw new Error("Contact fixture failed");
    await db
      .update(schema.contacts)
      .set({
        status: "email_resolved",
        emailResolutionStatus: "resolved",
        emailResolutionAttemptedAt: new Date("2026-08-11T00:00:00.000Z"),
      })
      .where(eq(schema.contacts.id, existing.contact.id));
    await db.insert(schema.emailCandidates).values({
      contactId: existing.contact.id,
      email: "ada@former-employer.example",
      normalizedEmail: "ada@former-employer.example",
      domain: "former-employer.example",
      confidence: "0.990",
      source: "old-employment",
      status: "accepted",
      mxValid: true,
    });
    const campaign = await createDraftCampaign(db, {
      name: "Prior employment campaign",
      type: "commercial_outreach",
      targetDescription: "Revenue leaders at the former employer",
      configuration: {},
      steps: [
        {
          delayMinutes: 0,
          subjectTemplate: "Hello {{first_name}}",
          bodyTemplate: "Old-employer outreach",
        },
      ],
    });
    if (!campaign.ok) throw new Error("Campaign fixture failed");
    const published = await publishCampaignVersion(db, {
      campaignId: campaign.campaign.id,
      campaignVersionId: campaign.version.id,
    });
    if (!published.ok) throw new Error("Campaign publish failed");
    const enrollment = await enrollContact(db, {
      campaignId: campaign.campaign.id,
      campaignVersionId: campaign.version.id,
      contactId: existing.contact.id,
    });
    if (!enrollment.ok) throw new Error("Enrollment fixture failed");
    await db
      .update(schema.enrollments)
      .set({
        state: "active",
        nextActionAt: new Date("2026-08-13T00:00:00.000Z"),
        nextActionToken: `employment-change-${existing.contact.id}`,
      })
      .where(eq(schema.enrollments.id, enrollment.enrollment.id));
    await db.insert(schema.evidenceSources).values({
      contactId: existing.contact.id,
      url: "https://former-employer.example/team/ada",
      sourceType: "contact_discovery",
      supports: ["employment", "job_title"],
      confidence: "0.900",
    });
    const discovered = await discoverContacts(
      db,
      new ContactDiscoveryFixture({
        contacts: [
          {
            firstName: "Ada",
            lastName: "Lovelace",
            jobTitle: "VP Revenue",
            linkedinUrl: "https://linkedin.com/in/ada-lovelace/",
            confidence: 0.96,
            evidence: [
              {
                url: "https://www.linkedin.com/in/ada-lovelace",
                title: "LinkedIn profile",
                supports: ["employment", "job_title"],
                retrievedAt,
              },
            ],
          },
        ],
      }),
      { accountId: newAccount.account.id, roles: ["VP Revenue"], limit: 5 },
    );
    expect(discovered).toMatchObject({ ok: true, conflicts: [] });
    if (!discovered.ok) return;
    expect(discovered.contacts).toHaveLength(1);
    expect(discovered.contacts[0]).toMatchObject({
      id: existing.contact.id,
      accountId: newAccount.account.id,
      jobTitle: "VP Revenue",
      status: "discovered",
      emailResolutionStatus: "unresolved",
      emailResolutionReason: "employment_changed",
      emailResolutionAttemptedAt: null,
    });
    const evidence = await db
      .select()
      .from(schema.evidenceSources)
      .where(eq(schema.evidenceSources.contactId, existing.contact.id));
    expect(evidence.map((item) => item.url).sort()).toEqual([
      "https://former-employer.example/team/ada",
      "https://www.linkedin.com/in/ada-lovelace",
    ]);
    const transitions = await db
      .select()
      .from(schema.stateTransitions)
      .where(eq(schema.stateTransitions.entityId, existing.contact.id));
    expect(transitions).toContainEqual(
      expect.objectContaining({
        entityType: "contact_employment",
        fromState: oldAccount.account.id,
        toState: newAccount.account.id,
        reason: "validated_current_employment",
        metadata: expect.objectContaining({
          invalidatedEmailCandidateCount: 1,
          stoppedEnrollmentCount: 1,
        }),
      }),
    );
    const [oldCandidate] = await db
      .select()
      .from(schema.emailCandidates)
      .where(eq(schema.emailCandidates.contactId, existing.contact.id));
    expect(oldCandidate).toMatchObject({ status: "rejected" });
    const [stoppedEnrollment] = await db
      .select()
      .from(schema.enrollments)
      .where(eq(schema.enrollments.id, enrollment.enrollment.id));
    expect(stoppedEnrollment).toMatchObject({
      state: "stopped",
      stopReason: "employment_changed",
      nextActionAt: null,
      nextActionToken: null,
    });
    expect(
      await generateOutreachProposal(db, {
        enrollmentId: enrollment.enrollment.id,
        stepIndex: 0,
        recipient: "ada@former-employer.example",
      }),
    ).toMatchObject({ ok: false, code: "ENROLLMENT_INACTIVE" });

    await db.insert(schema.evidenceSources).values({
      accountId: newAccount.account.id,
      url: "https://current-employer.example/about",
      sourceType: "company_website",
      supports: ["identity", "domain"],
      confidence: "0.990",
    });
    const reResolved = await resolveContactEmail(
      db,
      new MockDnsMxResolver(true),
      null,
      {
        contactId: existing.contact.id,
        publicSamples: [
          {
            firstName: "Marie",
            lastName: "Dupont",
            email: "marie.dupont@current-employer.example",
            sourceUrl: "https://current-employer.example/team/marie",
          },
          {
            firstName: "John",
            lastName: "Smith",
            email: "john.smith@current-employer.example",
            sourceUrl: "https://current-employer.example/team/john",
          },
        ],
      },
    );
    expect(reResolved).toMatchObject({
      ok: true,
      status: "resolved",
      reason: null,
    });
  });

  it("does not commit an employment move while an old-employer send owns the contact action", async () => {
    const oldAccount = await createOrGetAccount(db, {
      name: "Send Race Former Employer",
      domain: "send-race-former.example",
    });
    const newAccount = await createOrGetAccount(db, {
      name: "Send Race Current Employer",
      domain: "send-race-current.example",
    });
    if (!oldAccount.ok || !newAccount.ok)
      throw new Error("Account fixture failed");
    const existing = await createOrGetContact(db, {
      accountId: oldAccount.account.id,
      firstName: "Race",
      lastName: "Sender",
      jobTitle: "Director",
      linkedinUrl: "https://www.linkedin.com/in/race-sender",
    });
    if (!existing.ok) throw new Error("Contact fixture failed");
    const campaign = await createDraftCampaign(db, {
      name: "Employment send race",
      type: "commercial_outreach",
      targetDescription: "Revenue leaders at the former employer",
      configuration: {},
      steps: [
        {
          delayMinutes: 0,
          subjectTemplate: "Hello {{first_name}}",
          bodyTemplate: "A note for {{company}}",
        },
      ],
    });
    if (!campaign.ok) throw new Error("Campaign fixture failed");
    const published = await publishCampaignVersion(db, {
      campaignId: campaign.campaign.id,
      campaignVersionId: campaign.version.id,
    });
    if (!published.ok) throw new Error("Campaign publish failed");
    const enrollment = await enrollContact(db, {
      campaignId: campaign.campaign.id,
      campaignVersionId: campaign.version.id,
      contactId: existing.contact.id,
    });
    if (!enrollment.ok) throw new Error("Enrollment fixture failed");
    const proposal = await generateOutreachProposal(db, {
      enrollmentId: enrollment.enrollment.id,
      stepIndex: 0,
      recipient: "race.sender@send-race-former.example",
    });
    if (!proposal.ok) throw new Error("Proposal fixture failed");
    const approved = await reviewMessage(db, {
      messageId: proposal.message.id,
      action: { kind: "approve" },
      actor: "operator",
    });
    if (!approved.ok) throw new Error("Review fixture failed");

    let releaseSend!: () => void;
    const sendRelease = new Promise<void>((resolve) => {
      releaseSend = resolve;
    });
    let sendStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      sendStarted = resolve;
    });
    class PausedSendProvider extends MockMailProvider {
      override async sendDraft(
        input: Parameters<MockMailProvider["sendDraft"]>[0],
      ) {
        sendStarted();
        await sendRelease;
        return super.sendDraft(input);
      }
    }
    const provider = new PausedSendProvider();
    const sending = sendApprovedMessage(
      db,
      provider,
      { messageId: proposal.message.id },
      { clock: () => new Date("2026-08-12T12:00:00.000Z") },
    );
    await started;
    const moving = discoverContacts(
      db,
      new ContactDiscoveryFixture({
        contacts: [
          {
            firstName: "Race",
            lastName: "Sender",
            jobTitle: "VP Revenue",
            linkedinUrl: "https://www.linkedin.com/in/race-sender",
            confidence: 0.98,
            evidence: [
              {
                url: "https://www.linkedin.com/in/race-sender",
                title: "LinkedIn profile",
                supports: ["employment", "job_title"],
                retrievedAt,
              },
            ],
          },
        ],
      }),
      {
        accountId: newAccount.account.id,
        roles: ["VP Revenue"],
        limit: 1,
      },
    );
    expect(
      await Promise.race([
        moving.then(() => "committed" as const),
        new Promise<"pending">((resolve) =>
          setTimeout(() => resolve("pending"), 50),
        ),
      ]),
    ).toBe("pending");
    releaseSend();
    expect(await sending).toMatchObject({ ok: true, disposition: "sent" });
    expect(await moving).toMatchObject({ ok: true, conflicts: [] });
    const [storedMessage] = await db
      .select()
      .from(schema.messages)
      .where(eq(schema.messages.id, proposal.message.id));
    expect(storedMessage).toMatchObject({
      status: "sent",
      contactAccountId: oldAccount.account.id,
      employmentVersion: 1,
    });
    const [storedContact] = await db
      .select()
      .from(schema.contacts)
      .where(eq(schema.contacts.id, existing.contact.id));
    expect(storedContact).toMatchObject({
      accountId: newAccount.account.id,
      employmentVersion: 2,
    });
  });

  it("discards an old-domain email resolution that finishes after an employment move", async () => {
    const oldFixture = await accountAndContact("resolution-race-former");
    const newAccount = await createOrGetAccount(db, {
      name: "Resolution Race Current",
      domain: "resolution-race-current.example",
    });
    if (!newAccount.ok) throw new Error("Account fixture failed");
    await db
      .update(schema.contacts)
      .set({ linkedinUrl: "https://www.linkedin.com/in/resolution-race" })
      .where(eq(schema.contacts.id, oldFixture.contact.id));
    let releaseDns!: () => void;
    const dnsRelease = new Promise<void>((resolve) => {
      releaseDns = resolve;
    });
    let dnsStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      dnsStarted = resolve;
    });
    const pausedDns: DnsMxResolver = {
      async resolve(domain: string): Promise<MxResolution> {
        dnsStarted();
        await dnsRelease;
        return {
          hasMx: true,
          records: [{ exchange: `mx.${domain}`, priority: 10 }],
        };
      },
    };
    const resolving = resolveContactEmail(db, pausedDns, null, {
      contactId: oldFixture.contact.id,
      publicSamples: [
        {
          firstName: "Marie",
          lastName: "Dupont",
          email: `marie.dupont@${oldFixture.domain}`,
          sourceUrl: `https://${oldFixture.domain}/team`,
        },
        {
          firstName: "John",
          lastName: "Smith",
          email: `john.smith@${oldFixture.domain}`,
          sourceUrl: `https://${oldFixture.domain}/press`,
        },
      ],
    });
    await started;
    const moved = await discoverContacts(
      db,
      new ContactDiscoveryFixture({
        contacts: [
          {
            firstName: oldFixture.contact.firstName,
            lastName: oldFixture.contact.lastName,
            jobTitle: "VP Revenue",
            linkedinUrl: "https://www.linkedin.com/in/resolution-race",
            confidence: 0.98,
            evidence: [
              {
                url: "https://www.linkedin.com/in/resolution-race",
                title: "LinkedIn profile",
                supports: ["employment", "job_title"],
                retrievedAt,
              },
            ],
          },
        ],
      }),
      {
        accountId: newAccount.account.id,
        roles: ["VP Revenue"],
        limit: 1,
      },
    );
    expect(moved).toMatchObject({ ok: true, conflicts: [] });
    releaseDns();
    expect(await resolving).toMatchObject({
      ok: true,
      status: "unresolved",
      reason: "stale_employment",
      candidates: [],
    });
    expect(
      await db
        .select()
        .from(schema.emailCandidates)
        .where(eq(schema.emailCandidates.contactId, oldFixture.contact.id)),
    ).toHaveLength(0);
    const [stored] = await db
      .select()
      .from(schema.contacts)
      .where(eq(schema.contacts.id, oldFixture.contact.id));
    expect(stored).toMatchObject({
      accountId: newAccount.account.id,
      employmentVersion: 2,
      emailResolutionStatus: "unresolved",
      emailResolutionReason: "employment_changed",
    });
  });

  it("does not let a timed-out old-domain resolver overwrite an employment move", async () => {
    const oldFixture = await accountAndContact("resolution-timeout-former");
    const newAccount = await createOrGetAccount(db, {
      name: "Resolution Timeout Current",
      domain: "resolution-timeout-current.example",
    });
    if (!newAccount.ok) throw new Error(newAccount.message);
    await db
      .update(schema.contacts)
      .set({ linkedinUrl: "https://www.linkedin.com/in/resolution-timeout" })
      .where(eq(schema.contacts.id, oldFixture.contact.id));
    let dnsStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      dnsStarted = resolve;
    });
    const hungDns: DnsMxResolver = {
      async resolve(_domain, options): Promise<MxResolution> {
        dnsStarted();
        return new Promise((_resolve, reject) => {
          options?.signal?.addEventListener(
            "abort",
            () => reject(options.signal?.reason),
            { once: true },
          );
        });
      },
    };
    const resolving = resolveContactEmailService(
      db,
      hungDns,
      null,
      { contactId: oldFixture.contact.id },
      { providerOperationTimeoutMs: 50 },
    );
    await started;
    const moved = await discoverContacts(
      db,
      new ContactDiscoveryFixture({
        contacts: [
          {
            firstName: oldFixture.contact.firstName,
            lastName: oldFixture.contact.lastName,
            jobTitle: "VP Revenue",
            linkedinUrl: "https://www.linkedin.com/in/resolution-timeout",
            confidence: 0.98,
            evidence: [
              {
                url: "https://www.linkedin.com/in/resolution-timeout",
                title: "LinkedIn profile",
                supports: ["employment", "job_title"],
                retrievedAt,
              },
            ],
          },
        ],
      }),
      {
        accountId: newAccount.account.id,
        roles: ["VP Revenue"],
        limit: 1,
      },
    );
    expect(moved).toMatchObject({ ok: true, conflicts: [] });
    expect(await resolving).toMatchObject({
      ok: true,
      status: "unresolved",
      reason: "stale_employment",
    });
    const [stored] = await db
      .select()
      .from(schema.contacts)
      .where(eq(schema.contacts.id, oldFixture.contact.id));
    expect(stored).toMatchObject({
      accountId: newAccount.account.id,
      emailResolutionStatus: "unresolved",
      emailResolutionReason: "employment_changed",
    });
  });

  it("discards an in-flight resolution after the owning account domain changes", async () => {
    const fixture = await accountAndContact("resolution-domain-change");
    let releaseDns!: () => void;
    const dnsRelease = new Promise<void>((resolve) => {
      releaseDns = resolve;
    });
    let dnsStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      dnsStarted = resolve;
    });
    const pausedDns: DnsMxResolver = {
      async resolve(domain): Promise<MxResolution> {
        dnsStarted();
        await dnsRelease;
        return {
          hasMx: true,
          records: [{ exchange: `mx.${domain}`, priority: 10 }],
        };
      },
    };
    const resolving = resolveContactEmail(db, pausedDns, null, {
      contactId: fixture.contact.id,
      publicSamples: [
        {
          firstName: "Marie",
          lastName: "Dupont",
          email: `marie.dupont@${fixture.domain}`,
          sourceUrl: `https://${fixture.domain}/team`,
        },
        {
          firstName: "John",
          lastName: "Smith",
          email: `john.smith@${fixture.domain}`,
          sourceUrl: `https://${fixture.domain}/press`,
        },
      ],
    });
    await started;
    await db
      .update(schema.accounts)
      .set({ domain: "resolution-domain-current.example" })
      .where(eq(schema.accounts.id, fixture.account.id));
    releaseDns();
    expect(await resolving).toMatchObject({
      ok: true,
      status: "unresolved",
      reason: "stale_employment",
      candidates: [],
    });
    expect(
      await db
        .select()
        .from(schema.emailCandidates)
        .where(eq(schema.emailCandidates.contactId, fixture.contact.id)),
    ).toHaveLength(0);
  });

  it("rejects provider-independent personalization postcondition failures and audits them", async () => {
    const failed = await personalizeReasoningFields(
      db,
      new PersonalizationFixture({
        fields: [
          {
            name: "personalized_opening",
            value: "An undeclared field.",
            confidence: 0.8,
            sourceUrls: ["https://personalization-invalid.example/news"],
          },
        ],
        sources: [
          {
            url: "https://personalization-invalid.example/news",
            title: "News",
            supports: ["personalization"],
            retrievedAt,
          },
        ],
      }),
      {
        declaredFields: ["company_relevance"],
        trustedSourceUrls: ["https://personalization-invalid.example/news"],
        context: {
          company: "Invalid Personalization",
          firstName: "Alice",
          jobTitle: "VP Sales",
          research: {},
        },
      },
    );
    expect(failed).toMatchObject({ ok: false, code: "AGENT_ERROR" });
    const [run] = await db
      .select()
      .from(schema.agentRuns)
      .where(
        and(
          eq(schema.agentRuns.agent, "personalization"),
          eq(schema.agentRuns.status, "failed"),
        ),
      )
      .orderBy(schema.agentRuns.createdAt)
      .limit(1);
    expect(run).toMatchObject({
      status: "failed",
      output: null,
      error: "Agent execution failed (AgentProvenanceError)",
    });
  });

  it("returns a manual conflict without attaching ambiguous cross-company evidence", async () => {
    const oldAccount = await createOrGetAccount(db, {
      name: "Conflict Old",
      domain: "conflict-old.example",
    });
    const incomingAccount = await createOrGetAccount(db, {
      name: "Conflict Incoming",
      domain: "conflict-incoming.example",
    });
    if (!oldAccount.ok || !incomingAccount.ok)
      throw new Error("Account fixture failed");
    const existing = await createOrGetContact(db, {
      accountId: oldAccount.account.id,
      firstName: "Grace",
      lastName: "Hopper",
      jobTitle: "Director",
      linkedinUrl: "https://linkedin.com/in/grace-hopper",
    });
    if (!existing.ok) throw new Error("Contact fixture failed");
    const discovered = await discoverContacts(
      db,
      new ContactDiscoveryFixture({
        contacts: [
          {
            firstName: "Grace",
            lastName: "Hopper",
            jobTitle: "VP Sales",
            linkedinUrl: "https://www.linkedin.com/in/grace-hopper",
            confidence: 0.7,
            evidence: [
              {
                url: "https://directory.example/grace",
                title: "Unverified directory",
                supports: ["employment", "job_title"],
                retrievedAt,
              },
            ],
          },
        ],
      }),
      { accountId: incomingAccount.account.id, roles: ["VP Sales"], limit: 5 },
    );
    expect(discovered).toMatchObject({
      ok: true,
      contacts: [],
      conflicts: [
        {
          contactId: existing.contact.id,
          code: "CURRENT_EMPLOYMENT_UNVERIFIED",
        },
      ],
    });
    const [stored] = await db
      .select()
      .from(schema.contacts)
      .where(eq(schema.contacts.id, existing.contact.id));
    expect(stored?.accountId).toBe(oldAccount.account.id);
    const ambiguousEvidence = await db
      .select()
      .from(schema.evidenceSources)
      .where(eq(schema.evidenceSources.contactId, existing.contact.id));
    expect(ambiguousEvidence).toHaveLength(0);
  });

  it("serializes concurrent global LinkedIn discovery into one contact", async () => {
    const account = await createOrGetAccount(db, {
      name: "Concurrent Contacts",
      domain: "concurrent-contacts.example",
    });
    if (!account.ok) throw new Error("Account fixture failed");
    const candidate: ContactDiscoveryOutput["contacts"][number] = {
      firstName: "Katherine",
      lastName: "Johnson",
      jobTitle: "VP Sales",
      linkedinUrl: "https://linkedin.com/in/katherine-johnson",
      confidence: 0.95,
      evidence: [
        {
          url: "https://concurrent-contacts.example/team/katherine",
          title: "Team",
          supports: ["employment", "job_title"],
          retrievedAt,
        },
      ],
    };
    const outcomes = await Promise.all([
      discoverContacts(
        db,
        new ContactDiscoveryFixture({ contacts: [candidate] }),
        {
          accountId: account.account.id,
          roles: ["VP Sales"],
          limit: 5,
        },
      ),
      discoverContacts(
        db,
        new ContactDiscoveryFixture({ contacts: [candidate] }),
        {
          accountId: account.account.id,
          roles: ["VP Sales"],
          limit: 5,
        },
      ),
    ]);
    expect(outcomes).toEqual([
      expect.objectContaining({ ok: true }),
      expect.objectContaining({ ok: true }),
    ]);
    expect(
      await db
        .select()
        .from(schema.contacts)
        .where(
          eq(
            schema.contacts.linkedinUrl,
            "https://www.linkedin.com/in/katherine-johnson",
          ),
        ),
    ).toHaveLength(1);
  });

  it("rejects an agent batch over the requested limit without persisting contacts", async () => {
    const account = await createOrGetAccount(db, {
      name: "Contact Output Limit",
      domain: "contact-output-limit.example",
    });
    if (!account.ok) throw new Error(account.message);
    const candidates: ContactDiscoveryOutput["contacts"] = ["one", "two"].map(
      (suffix) => ({
        firstName: "Limit",
        lastName: suffix,
        jobTitle: "VP Sales",
        linkedinUrl: `https://www.linkedin.com/in/contact-limit-${suffix}`,
        confidence: 0.9,
        evidence: [
          {
            url: `https://contact-output-limit.example/team/${suffix}`,
            title: "Team",
            supports: ["employment", "job_title"],
            retrievedAt,
          },
        ],
      }),
    );
    const discovered = await discoverContacts(
      db,
      new ContactDiscoveryFixture({ contacts: candidates }),
      { accountId: account.account.id, roles: ["VP Sales"], limit: 1 },
    );
    expect(discovered).toMatchObject({ ok: false, code: "AGENT_ERROR" });
    expect(
      await db
        .select()
        .from(schema.contacts)
        .where(eq(schema.contacts.accountId, account.account.id)),
    ).toHaveLength(0);
  });

  it("commits contact discovery and its successful agent run atomically", async () => {
    const account = await createOrGetAccount(db, {
      name: "Atomic Contact Batch",
      domain: "atomic-contact-batch.example",
    });
    if (!account.ok) throw new Error(account.message);
    const output = {
      contacts: [
        {
          firstName: "Atomic",
          lastName: "Valid",
          jobTitle: "VP Sales",
          linkedinUrl: "https://www.linkedin.com/in/atomic-valid",
          confidence: 0.9,
          evidence: [
            {
              url: "https://atomic-contact-batch.example/team/valid",
              title: "Team",
              supports: ["employment", "job_title"],
              retrievedAt,
            },
          ],
        },
        {
          firstName: "Atomic",
          lastName: "Invalid",
          jobTitle: "VP Sales",
          linkedinUrl: "https://example.com/not-linkedin",
          confidence: 0.9,
          evidence: [
            {
              url: "https://atomic-contact-batch.example/team/invalid",
              title: "Team",
              supports: ["employment", "job_title"],
              retrievedAt,
            },
          ],
        },
      ],
    } as ContactDiscoveryOutput;
    const discovered = await discoverContacts(
      db,
      new ContactDiscoveryFixture(output),
      { accountId: account.account.id, roles: ["VP Sales"], limit: 2 },
    );
    expect(discovered).toMatchObject({ ok: false, code: "DATABASE_ERROR" });
    expect(
      await db
        .select()
        .from(schema.contacts)
        .where(eq(schema.contacts.accountId, account.account.id)),
    ).toHaveLength(0);
    const [run] = await db
      .select()
      .from(schema.agentRuns)
      .where(eq(schema.agentRuns.agent, "contact_discovery"))
      .orderBy(schema.agentRuns.createdAt)
      .then((rows) => (rows.at(-1) ? [rows.at(-1)!] : []));
    expect(run?.status).not.toBe("succeeded");
  });

  it("persists high, low, and missing email-resolution outcomes without duplicate candidates", async () => {
    const high = await accountAndContact("email-high");
    const highResult = await resolveContactEmail(
      db,
      new MockDnsMxResolver(true),
      null,
      {
        contactId: high.contact.id,
        publicSamples: [
          {
            firstName: "Marie",
            lastName: "Dupont",
            email: `marie.dupont@${high.domain}`,
            sourceUrl: `https://${high.domain}/press`,
          },
          {
            firstName: "John",
            lastName: "Smith",
            email: `john.smith@${high.domain}`,
            sourceUrl: `https://${high.domain}/team`,
          },
        ],
      },
    );
    expect(highResult).toMatchObject({ ok: true, status: "resolved" });
    await resolveContactEmail(db, new MockDnsMxResolver(true), null, {
      contactId: high.contact.id,
      publicSamples: [
        {
          firstName: "Marie",
          lastName: "Dupont",
          email: `marie.dupont@${high.domain}`,
          sourceUrl: `https://${high.domain}/press`,
        },
        {
          firstName: "John",
          lastName: "Smith",
          email: `john.smith@${high.domain}`,
          sourceUrl: `https://${high.domain}/team`,
        },
      ],
    });
    expect(
      await db
        .select()
        .from(schema.emailCandidates)
        .where(eq(schema.emailCandidates.contactId, high.contact.id)),
    ).toHaveLength(1);

    const low = await accountAndContact("email-low");
    const lowResult = await resolveContactEmail(
      db,
      new MockDnsMxResolver(true),
      new NoResultEmailEnrichmentProvider(),
      {
        contactId: low.contact.id,
        publicSamples: [
          {
            firstName: "Marie",
            lastName: "Dupont",
            email: `marie.dupont@${low.domain}`,
            sourceUrl: `https://${low.domain}/press`,
          },
        ],
      },
    );
    expect(lowResult).toMatchObject({ ok: true, status: "manual_review" });
    expect(lowResult).toMatchObject({ reason: "enrichment_no_result" });

    const missing = await accountAndContact("email-missing", false);
    const missingResult = await resolveContactEmail(
      db,
      new MockDnsMxResolver(true),
      null,
      { contactId: missing.contact.id, publicSamples: [] },
    );
    expect(missingResult).toMatchObject({
      ok: true,
      status: "unresolved",
      reason: "domain_not_evidenced",
    });
    const [storedMissing] = await db
      .select()
      .from(schema.contacts)
      .where(eq(schema.contacts.id, missing.contact.id));
    expect(storedMissing?.emailResolutionStatus).toBe("unresolved");
    expect(storedMissing?.emailResolutionReason).toBe("domain_not_evidenced");
  });

  it("persists a complete agent run for successful OpenAI public-email evidence", async () => {
    const fixture = await accountAndContact("email-ai-audit-success");
    const samples = [
      {
        firstName: "Marie",
        lastName: "Dupont",
        email: `marie.dupont@${fixture.domain}`,
        sourceUrl: `https://${fixture.domain}/press`,
      },
      {
        firstName: "John",
        lastName: "Smith",
        email: `john.smith@${fixture.domain}`,
        sourceUrl: `https://${fixture.domain}/team`,
      },
    ];
    const publicEvidenceProvider = new OpenAIPublicEmailEvidenceProvider(
      {
        run: async () => ({
          responseId: "resp_public_email_audit_success",
          model: "mock-public-email-research",
          output: { samples },
          sources: samples.map((sample) => ({
            url: sample.sourceUrl,
            title: `${sample.firstName} profile`,
          })),
          usage: {
            inputTokens: 120,
            outputTokens: 45,
            totalTokens: 165,
            cachedInputTokens: 20,
            reasoningTokens: 5,
          },
          toolUsage: { webSearchCalls: 2 },
          costUsd: null,
          costAvailability: "unavailable" as const,
        }),
      } as unknown as StructuredAIProvider,
      "mock-public-email-research",
    );

    const resolved = await resolveContactEmailService(
      db,
      new MockDnsMxResolver(true),
      null,
      { contactId: fixture.contact.id },
      { publicEvidenceProvider },
    );
    expect(resolved).toMatchObject({ ok: true, status: "resolved" });

    const runs = await db
      .select()
      .from(schema.agentRuns)
      .where(eq(schema.agentRuns.agent, "public_email_evidence"));
    const run = runs.find(
      (candidate) =>
        candidate.input.companyDomain === "email-ai-audit-success.example",
    );
    expect(run).toMatchObject({
      agent: "public_email_evidence",
      model: "mock-public-email-research",
      promptVersion: "public-email-evidence-prompt-v1",
      schemaVersion: "public-email-evidence-schema-v1",
      input: { companyDomain: "email-ai-audit-success.example" },
      output: { samples },
      responseId: "resp_public_email_audit_success",
      tokenUsage: {
        inputTokens: 120,
        outputTokens: 45,
        totalTokens: 165,
        cachedInputTokens: 20,
        reasoningTokens: 5,
      },
      toolUsage: { webSearchCalls: 2 },
      costUsd: null,
      costAvailability: "unavailable",
      status: "succeeded",
      error: null,
    });
    expect(run?.sources).toEqual(
      samples.map((sample) => ({
        url: sample.sourceUrl,
        title: `${sample.firstName} profile`,
      })),
    );
    expect(run?.completedAt).not.toBeNull();
  });

  it("persists a sanitized failed agent run when OpenAI public-email evidence fails", async () => {
    const fixture = await accountAndContact("email-ai-audit-failure");
    const publicEvidenceProvider = new OpenAIPublicEmailEvidenceProvider(
      {
        run: async () => {
          throw new Error("sk-secret-public-evidence-leak");
        },
      } as unknown as StructuredAIProvider,
      "mock-public-email-research",
    );

    const resolved = await resolveContactEmailService(
      db,
      new MockDnsMxResolver(true),
      null,
      { contactId: fixture.contact.id },
      { publicEvidenceProvider },
    );
    expect(resolved).toMatchObject({
      ok: true,
      status: "provider_error",
      reason: "provider_transient_error",
    });

    const runs = await db
      .select()
      .from(schema.agentRuns)
      .where(eq(schema.agentRuns.agent, "public_email_evidence"));
    const run = runs.find(
      (candidate) =>
        candidate.input.companyDomain === "email-ai-audit-failure.example",
    );
    expect(run).toMatchObject({
      agent: "public_email_evidence",
      model: "mock-public-email-research",
      promptVersion: "public-email-evidence-prompt-v1",
      schemaVersion: "public-email-evidence-schema-v1",
      input: { companyDomain: "email-ai-audit-failure.example" },
      responseId: null,
      output: null,
      status: "failed",
      error: "Agent execution failed (Error)",
    });
    expect(run?.completedAt).not.toBeNull();
    expect(JSON.stringify(run)).not.toContain("sk-secret-public-evidence-leak");
  });

  it("persists explicit missing-domain, insufficient-evidence, and missing-MX outcomes", async () => {
    const noDomainAccount = await createOrGetAccount(db, {
      name: "No Domain Account",
    });
    if (!noDomainAccount.ok) throw new Error("Account fixture failed");
    const noDomainContact = await createOrGetContact(db, {
      accountId: noDomainAccount.account.id,
      firstName: "No",
      lastName: "Domain",
    });
    if (!noDomainContact.ok) throw new Error("Contact fixture failed");
    const missingDomain = await resolveContactEmail(
      db,
      new MockDnsMxResolver(true),
      null,
      { contactId: noDomainContact.contact.id, publicSamples: [] },
    );
    expect(missingDomain).toMatchObject({
      ok: true,
      status: "unresolved",
      reason: "missing_domain",
    });

    const insufficient = await accountAndContact("email-insufficient");
    const insufficientResult = await resolveContactEmail(
      db,
      new MockDnsMxResolver(true),
      null,
      { contactId: insufficient.contact.id, publicSamples: [] },
    );
    expect(insufficientResult).toMatchObject({
      ok: true,
      status: "manual_review",
      reason: "insufficient_public_evidence",
    });

    const noMx = await accountAndContact("email-no-mx");
    const noMxResult = await resolveContactEmail(
      db,
      new MockDnsMxResolver(false),
      null,
      {
        contactId: noMx.contact.id,
        publicSamples: [
          {
            firstName: "Marie",
            lastName: "Dupont",
            email: `marie.dupont@${noMx.domain}`,
            sourceUrl: `https://${noMx.domain}/team`,
          },
        ],
      },
    );
    expect(noMxResult).toMatchObject({
      ok: true,
      status: "manual_review",
      reason: "mx_missing",
    });
    const [storedNoMx] = await db
      .select()
      .from(schema.contacts)
      .where(eq(schema.contacts.id, noMx.contact.id));
    expect(storedNoMx?.emailResolutionReason).toBe("mx_missing");
  });

  it("uses optional fallback below threshold and persists sanitized transient failure", async () => {
    const fallback = await accountAndContact("email-fallback");
    const fallbackResult = await resolveContactEmail(
      db,
      new MockDnsMxResolver(true),
      new StaticEmailEnrichmentProvider([
        {
          email: `alice.emailfallback@${fallback.domain}`,
          confidence: 0.96,
          source: "fixture-provider",
          evidenceUrls: ["https://provider.example/fallback"],
        },
      ]),
      {
        contactId: fallback.contact.id,
        publicSamples: [],
      },
    );
    expect(fallbackResult).toMatchObject({ ok: true, status: "resolved" });

    const transient = await accountAndContact("email-transient");
    const transientResult = await resolveContactEmail(
      db,
      new MockDnsMxResolver(true),
      new TransientEmailEnrichmentProvider(),
      {
        contactId: transient.contact.id,
        publicSamples: [
          {
            firstName: "Marie",
            lastName: "Dupont",
            email: `marie.dupont@${transient.domain}`,
            sourceUrl: `https://${transient.domain}/press`,
          },
        ],
      },
    );
    expect(transientResult).toMatchObject({
      ok: true,
      status: "provider_error",
      reason: "provider_transient_error",
    });
    const [stored] = await db
      .select()
      .from(schema.contacts)
      .where(eq(schema.contacts.id, transient.contact.id));
    expect(stored?.emailResolutionError).toBe(
      "Email enrichment temporarily unavailable",
    );
    expect(stored?.emailResolutionError).not.toContain("provider is");
    expect(stored?.emailResolutionReason).toBe("provider_transient_error");
  });

  it("aborts hung DNS and enrichment operations at the provider deadline", async () => {
    const dnsFixture = await accountAndContact("email-dns-timeout");
    let dnsAborted = false;
    const hungDns: DnsMxResolver = {
      async resolve(_domain, options): Promise<MxResolution> {
        return new Promise((_resolve, reject) => {
          options?.signal?.addEventListener(
            "abort",
            () => {
              dnsAborted = true;
              reject(options.signal?.reason);
            },
            { once: true },
          );
        });
      },
    };
    expect(
      await resolveContactEmailService(
        db,
        hungDns,
        null,
        { contactId: dnsFixture.contact.id },
        { providerOperationTimeoutMs: 20 },
      ),
    ).toMatchObject({
      ok: true,
      status: "provider_error",
      reason: "mx_lookup_failure",
    });
    expect(dnsAborted).toBe(true);

    const enrichmentFixture = await accountAndContact(
      "email-enrichment-timeout",
    );
    let enrichmentAborted = false;
    const hungEnrichment = {
      name: "hung-enrichment",
      async resolve(_input: unknown, options?: { signal?: AbortSignal }) {
        return new Promise<never[]>((_resolve, reject) => {
          options?.signal?.addEventListener(
            "abort",
            () => {
              enrichmentAborted = true;
              reject(options.signal?.reason);
            },
            { once: true },
          );
        });
      },
    };
    expect(
      await resolveContactEmailService(
        db,
        new MockDnsMxResolver(true),
        hungEnrichment,
        { contactId: enrichmentFixture.contact.id },
        { providerOperationTimeoutMs: 20 },
      ),
    ).toMatchObject({
      ok: true,
      status: "provider_error",
      reason: "provider_transient_error",
    });
    expect(enrichmentAborted).toBe(true);
  });

  it("does not mark a second contact resolved when the candidate belongs to another contact", async () => {
    const fixture = await accountAndContact("email-collision");
    const second = await createOrGetContact(db, {
      accountId: fixture.account.id,
      firstName: "Bob",
      lastName: "Collision",
      jobTitle: "Head of Sales",
    });
    if (!second.ok) throw new Error("Second contact fixture failed");
    const provider = new StaticEmailEnrichmentProvider([
      {
        email: `shared@${fixture.domain}`,
        confidence: 0.97,
        source: "fixture-provider",
        evidenceUrls: ["https://provider.example/shared"],
      },
    ]);
    const first = await resolveContactEmail(
      db,
      new MockDnsMxResolver(true),
      provider,
      { contactId: fixture.contact.id, publicSamples: [] },
    );
    expect(first).toMatchObject({ ok: true, status: "resolved" });

    const collision = await resolveContactEmail(
      db,
      new MockDnsMxResolver(true),
      provider,
      { contactId: second.contact.id, publicSamples: [] },
    );
    expect(collision).toMatchObject({
      ok: true,
      status: "manual_review",
      reason: "candidate_conflict",
    });
    const [stored] = await db
      .select()
      .from(schema.contacts)
      .where(eq(schema.contacts.id, second.contact.id));
    expect(stored).toMatchObject({
      status: "discovered",
      emailResolutionStatus: "manual_review",
      emailResolutionReason: "candidate_conflict",
    });
  });

  it("atomically replaces the accepted address on a later stronger resolution", async () => {
    const fixture = await accountAndContact("email-replacement");
    const firstProvider = new StaticEmailEnrichmentProvider([
      {
        email: `first@${fixture.domain}`,
        confidence: 0.9,
        source: "first-fixture",
        evidenceUrls: ["https://provider.example/first"],
      },
    ]);
    expect(
      await resolveContactEmail(
        db,
        new MockDnsMxResolver(true),
        firstProvider,
        {
          contactId: fixture.contact.id,
          publicSamples: [],
          confidenceThreshold: 0.85,
        },
      ),
    ).toMatchObject({ ok: true, status: "resolved" });
    const secondProvider = new StaticEmailEnrichmentProvider([
      {
        email: `second@${fixture.domain}`,
        confidence: 0.99,
        source: "second-fixture",
        evidenceUrls: ["https://provider.example/second"],
      },
    ]);
    expect(
      await resolveContactEmail(
        db,
        new MockDnsMxResolver(true),
        secondProvider,
        {
          contactId: fixture.contact.id,
          publicSamples: [],
          confidenceThreshold: 0.95,
        },
      ),
    ).toMatchObject({ ok: true, status: "resolved" });
    const stored = await db
      .select()
      .from(schema.emailCandidates)
      .where(eq(schema.emailCandidates.contactId, fixture.contact.id));
    expect(
      stored.filter((candidate) => candidate.status === "accepted"),
    ).toEqual([
      expect.objectContaining({ normalizedEmail: `second@${fixture.domain}` }),
    ]);
  });

  it("audits reply classification without inbound side effects and sanitizes failed agent errors", async () => {
    const classifier = new OpenAIReplyClassifier(
      {
        run: async () =>
          result(
            {
              category: "question" as const,
              confidence: 0.89,
              reason: "The recipient asks about pricing.",
            },
            "mock-fast",
          ),
      } as unknown as StructuredAIProvider,
      "mock-fast",
    );
    const classified = await classifyReplyWithAudit(db, classifier, {
      sender: "recipient@example.com",
      subject: "Re: introduction",
      body: "Could you share pricing?",
    });
    expect(classified).toMatchObject({
      ok: true,
      classification: { category: "question", confidence: 0.89 },
    });
    if (!classified.ok) return;
    const [replyRun] = await db
      .select()
      .from(schema.agentRuns)
      .where(eq(schema.agentRuns.id, classified.agentRunId));
    expect(replyRun).toMatchObject({
      agent: "reply_classifier",
      model: "mock-fast",
      status: "succeeded",
    });

    class FailingDiscovery extends AccountDiscoveryFixture {
      override async discover(): Promise<AgentResult<AccountDiscoveryOutput>> {
        throw new Error("sk-secret-must-not-be-stored");
      }
    }
    const failed = await discoverAccounts(
      db,
      new FailingDiscovery({ candidates: [] }),
      {
        icp: "Companies with a sufficiently precise target description",
        limit: 5,
        countries: [],
        industries: [],
      },
    );
    expect(failed).toMatchObject({ ok: false, code: "AGENT_ERROR" });
    const failedRuns = await db
      .select()
      .from(schema.agentRuns)
      .where(
        and(
          eq(schema.agentRuns.status, "failed"),
          eq(schema.agentRuns.agent, "account_discovery"),
        ),
      );
    const latest = failedRuns.at(-1);
    expect(latest?.error).toBe("Agent execution failed (Error)");
    expect(JSON.stringify(latest)).not.toContain(
      "sk-secret-must-not-be-stored",
    );
  });
});

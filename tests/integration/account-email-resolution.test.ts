import { asc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as schema from "@/lib/db/schema";
import { resolveDatabaseUrls } from "@/lib/db/test-database";
import type { AIProviderBundle } from "@/lib/ai/provider-bundle";
import type {
  StructuredAIProvider,
  StructuredResponseRequest,
  StructuredResponseResult,
} from "@/lib/ai/providers/types";
import { createOrGetAccount } from "@/modules/accounts/service";
import { createOrGetContact } from "@/modules/contacts/service";
import { MockDnsMxResolver } from "@/modules/email-resolution/dns";
import { findAccountContactsNeedingResolution } from "@/modules/email-resolution/account-resolution";
import {
  drainOperatorCommands,
  enqueueOperatorCommand,
} from "@/modules/workflows/operator-command-queue";
import { WorkflowRuntime } from "@/modules/workflows/runtime";
import { createWorkflowTaskServices } from "@/modules/workflows/service-factory";
import type { WorkflowTaskName } from "@/modules/workflows/task-contracts";

const { testUrl } = resolveDatabaseUrls(process.env);
const client = postgres(testUrl, { max: 5 });
const db = drizzle(client, { schema });

/**
 * A research surface that answers the public-address question with a fixed set
 * of samples and counts how often it was actually asked.
 *
 * Built as a real `StructuredAIProvider` behind the production bundle rather
 * than as a stubbed evidence provider, so the path under test is the one that
 * ships: `composeEmailResolutionProviders` wraps it in the observable
 * `StructuredPublicEmailEvidenceProvider`, which is what writes the `agent_runs`
 * row that both the reuse rule and the queue's turn-counting depend on.
 */
class CountingResearchProvider implements StructuredAIProvider {
  calls = 0;

  constructor(private readonly samples: Array<Record<string, string>>) {}

  async run<T>(
    request: StructuredResponseRequest<T>,
  ): Promise<StructuredResponseResult<T>> {
    this.calls += 1;
    const output = { samples: this.samples } as unknown as T;
    return {
      responseId: `counting_${this.calls}`,
      model: request.model,
      output,
      sources: this.samples.map((sample) => ({
        url: sample.sourceUrl!,
        provenance: "model_declared_after_search" as const,
      })),
      usage: null,
      toolUsage: null,
      costUsd: null,
      costAvailability: "unavailable" as const,
    };
  }
}

function bundleWith(provider: StructuredAIProvider): AIProviderBundle {
  return {
    mode: "chatgpt_desktop",
    usesRealInfrastructure: true,
    research: {
      provider,
      model: "test-research-model",
      effort: "High",
      operationTimeoutMs: 30_000,
    },
    nonWeb: { provider, model: "test-fast-model", effort: "Instant" },
  };
}

function servicesWith(provider: StructuredAIProvider) {
  return createWorkflowTaskServices(
    db,
    { AI_PROVIDER: "chatgpt_desktop", MAIL_PROVIDER: "mock" },
    {
      createBundle: () => bundleWith(provider),
      createRealDns: () => new MockDnsMxResolver(true),
      createMockDns: () => new MockDnsMxResolver(true),
    },
  );
}

async function drainOnce(provider: StructuredAIProvider) {
  const services = servicesWith(provider);
  return drainOperatorCommands(db, (input) =>
    new WorkflowRuntime(db, services).execute(
      input.task as WorkflowTaskName,
      input.payload,
      { runId: input.runId, attempt: input.attempt },
    ),
  );
}

async function companyWithContacts(
  slug: string,
  names: Array<[string, string]>,
) {
  const domain = `${slug}.example`;
  const account = await createOrGetAccount(db, {
    name: `${slug} Account`,
    domain,
  });
  if (!account.ok) throw new Error("Account fixture failed");
  await db.insert(schema.evidenceSources).values({
    accountId: account.account.id,
    url: `https://${domain}/about`,
    sourceType: "company_website",
    supports: ["identity", "domain"],
    confidence: "0.990",
  });
  const contacts = [];
  for (const [firstName, lastName] of names) {
    const created = await createOrGetContact(db, {
      accountId: account.account.id,
      firstName,
      lastName,
      jobTitle: "Directeur",
    });
    if (!created.ok) throw new Error("Contact fixture failed");
    contacts.push(created.contact);
  }
  const samples = [
    {
      firstName: "Marie",
      lastName: "Durand",
      email: `marie.durand@${domain}`,
      sourceUrl: `https://${domain}/press.pdf`,
    },
    {
      firstName: "Paul",
      lastName: "Martin",
      email: `paul.martin@${domain}`,
      sourceUrl: `https://${domain}/press.pdf`,
    },
  ];
  return { account: account.account, contacts, domain, samples };
}

describe("resolving a company's addresses as one action", () => {
  beforeAll(async () => {
    await client.unsafe("drop schema if exists public cascade");
    await client.unsafe("drop schema if exists drizzle cascade");
    await client.unsafe("create schema public");
    await migrate(drizzle(client), { migrationsFolder: "drizzle" });
  });

  afterAll(async () => {
    await client.end();
  });

  /**
   * The defect that made a company-level action unusable: the queue decided a
   * command had spent a turn on the operator's single ChatGPT window by reading
   * its task name, so a resolution that reused a recorded company search stopped
   * the pass exactly as one that searched. Ten colleagues took ten minutes for an
   * answer established once.
   */
  it("drains every reusing resolution of one company in a single pass", async () => {
    const company = await companyWithContacts("one-pass", [
      ["Audrey", "Gimenez"],
      ["Abdesslam", "Laoukili"],
      ["Tony", "Pasquier"],
    ]);
    const provider = new CountingResearchProvider(company.samples);
    for (const contact of company.contacts) {
      await enqueueOperatorCommand(db, {
        command: "resolve-email",
        payload: {
          contactId: contact.id,
          confidenceThreshold: 0.85,
          forcePublicSearch: false,
        },
        requestedBy: "operator@example.com",
        dedupeKey: `ui:email-resolution:${contact.id}:one-pass`,
      });
    }

    // The first pass spends the one turn the company needs and stops there.
    const first = await drainOnce(provider);
    expect(first).toHaveLength(1);
    expect(provider.calls).toBe(1);

    // The second drains the rest, because none of them asks the model anything.
    const second = await drainOnce(provider);
    expect(second).toHaveLength(2);
    expect(second.every((row) => row.status === "succeeded")).toBe(true);
    expect(provider.calls).toBe(1);

    const accepted = await db
      .select({
        contactId: schema.emailCandidates.contactId,
        email: schema.emailCandidates.normalizedEmail,
      })
      .from(schema.emailCandidates)
      .where(eq(schema.emailCandidates.status, "accepted"));
    expect(
      accepted.filter((row) =>
        company.contacts.some((contact) => contact.id === row.contactId),
      ),
    ).toHaveLength(3);
  });

  it("asks the model exactly once for a whole company", async () => {
    const company = await companyWithContacts("one-search", [
      ["Nadia", "Perrin"],
      ["Bruno", "Leclerc"],
      ["Elsa", "Moreau"],
    ]);
    const provider = new CountingResearchProvider(company.samples);
    for (const contact of company.contacts) {
      await enqueueOperatorCommand(db, {
        command: "resolve-email",
        payload: {
          contactId: contact.id,
          confidenceThreshold: 0.85,
          forcePublicSearch: false,
        },
        requestedBy: "operator@example.com",
        dedupeKey: `ui:email-resolution:${contact.id}:one-search`,
      });
    }
    await drainOnce(provider);
    await drainOnce(provider);

    const runs = await db
      .select()
      .from(schema.agentRuns)
      .where(eq(schema.agentRuns.agent, "public_email_evidence"));
    const forThisCompany = runs.filter(
      (run) => run.input.companyDomain === company.domain,
    );
    expect(forThisCompany).toHaveLength(1);
    expect(forThisCompany[0]?.status).toBe("succeeded");
  });

  it("offers every contact of a company that still needs an address", async () => {
    const company = await companyWithContacts("needs-address", [
      ["Remi", "Gauthier"],
      ["Iris", "Kang"],
    ]);
    const before = await findAccountContactsNeedingResolution(db, {
      accountId: company.account.id,
    });
    expect(before.map((row) => row.contactId).sort()).toEqual(
      company.contacts.map((contact) => contact.id).sort(),
    );

    const provider = new CountingResearchProvider(company.samples);
    for (const contact of company.contacts) {
      await enqueueOperatorCommand(db, {
        command: "resolve-email",
        payload: { contactId: contact.id, confidenceThreshold: 0.85 },
        requestedBy: "operator@example.com",
        dedupeKey: `ui:email-resolution:${contact.id}:needs-address`,
      });
    }
    await drainOnce(provider);
    await drainOnce(provider);

    const after = await findAccountContactsNeedingResolution(db, {
      accountId: company.account.id,
    });
    expect(after).toEqual([]);
  });

  /**
   * A forced re-search is a search per *company*, not per contact. Sending the
   * flag to all of them would spend ten live web searches on a ten-person
   * company, which is the cost this whole direction exists to remove.
   */
  it("re-searches a forced company once and reuses that answer for the rest", async () => {
    const company = await companyWithContacts("forced-once", [
      ["Sofia", "Ricci"],
      ["Karim", "Benali"],
    ]);
    const provider = new CountingResearchProvider(company.samples);
    const ordered = [...company.contacts].sort((left, right) =>
      left.id.localeCompare(right.id),
    );
    void ordered;
    const eligible = await findAccountContactsNeedingResolution(db, {
      accountId: company.account.id,
    });
    // Exactly what the route does: the flag rides on the first queued contact
    // and on no other.
    for (const [index, row] of eligible.entries()) {
      await enqueueOperatorCommand(db, {
        command: "resolve-email",
        payload: {
          contactId: row.contactId,
          confidenceThreshold: 0.85,
          forcePublicSearch: index === 0,
        },
        requestedBy: "operator@example.com",
        dedupeKey: `ui:account-email-resolution:${company.account.id}:forced:${row.contactId}`,
      });
    }
    await drainOnce(provider);
    await drainOnce(provider);
    expect(provider.calls).toBe(1);

    const remaining = await findAccountContactsNeedingResolution(db, {
      accountId: company.account.id,
    });
    expect(remaining).toEqual([]);
  });

  it("does not offer a contact whose address has already been written to", async () => {
    const company = await companyWithContacts("already-sent", [
      ["Chloe", "Fabre"],
    ]);
    const contact = company.contacts[0]!;
    await db.insert(schema.emailCandidates).values({
      contactId: contact.id,
      email: `chloe.fabre@${company.domain}`,
      normalizedEmail: `chloe.fabre@${company.domain}`,
      domain: company.domain,
      confidence: "0.970",
      source: "public_pattern",
      status: "accepted",
      firstAttemptedAt: new Date("2026-08-18T10:00:00.000Z"),
    });
    await db
      .update(schema.contacts)
      .set({ emailResolutionStatus: "resolved" })
      .where(eq(schema.contacts.id, contact.id));

    expect(
      await findAccountContactsNeedingResolution(db, {
        accountId: company.account.id,
      }),
    ).toEqual([]);
    // Even a forced re-search leaves them alone: moving the address of somebody
    // who may be holding a message is the one thing resolution must not do.
    expect(
      await findAccountContactsNeedingResolution(db, {
        accountId: company.account.id,
        includeResolved: true,
      }),
    ).toEqual([]);
  });

  it("re-offers a resolved contact nobody has written to when the search is forced", async () => {
    const company = await companyWithContacts("forced-resolved", [
      ["Yanis", "Bouchard"],
    ]);
    const contact = company.contacts[0]!;
    await db.insert(schema.emailCandidates).values({
      contactId: contact.id,
      email: `yanis.bouchard@${company.domain}`,
      normalizedEmail: `yanis.bouchard@${company.domain}`,
      domain: company.domain,
      confidence: "0.970",
      source: "public_pattern",
      status: "accepted",
    });
    await db
      .update(schema.contacts)
      .set({ emailResolutionStatus: "resolved" })
      .where(eq(schema.contacts.id, contact.id));

    expect(
      await findAccountContactsNeedingResolution(db, {
        accountId: company.account.id,
      }),
    ).toEqual([]);
    expect(
      (
        await findAccountContactsNeedingResolution(db, {
          accountId: company.account.id,
          includeResolved: true,
        })
      ).map((row) => row.contactId),
    ).toEqual([contact.id]);
  });

  it("returns contacts in a stable order, so the forced search is always the same one", async () => {
    const company = await companyWithContacts("stable-order", [
      ["Ana", "Ferrand"],
      ["Bo", "Guerin"],
      ["Cyril", "Hamon"],
    ]);
    const first = await findAccountContactsNeedingResolution(db, {
      accountId: company.account.id,
    });
    const second = await findAccountContactsNeedingResolution(db, {
      accountId: company.account.id,
    });
    expect(first).toEqual(second);
    const created = await db
      .select({ id: schema.contacts.id })
      .from(schema.contacts)
      .where(eq(schema.contacts.accountId, company.account.id))
      .orderBy(asc(schema.contacts.createdAt), asc(schema.contacts.id));
    expect(first.map((row) => row.contactId)).toEqual(
      created.map((row) => row.id),
    );
  });
});

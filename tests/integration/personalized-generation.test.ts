import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as schema from "@/lib/db/schema";
import { resolveDatabaseUrls } from "@/lib/db/test-database";
import type { PersonalizationAgent } from "@/modules/agents/contracts";
import { createAgentSetFromBundle } from "@/modules/agents/factory";
import { generateWithPersonalization } from "@/modules/messages/personalized-generation";

const { testUrl } = resolveDatabaseUrls(process.env);
const client = postgres(testUrl, { max: 4 });
const db = drizzle(client, { schema });

const NOW = new Date("2026-08-16T12:00:00.000Z");
const EVIDENCE_URL = "https://evidence.example/acme";

const deterministicAgent = createAgentSetFromBundle({
  mode: "mock",
  usesRealInfrastructure: false,
}).personalization;

/** An agent that answers, but never confidently enough. */
const timidAgent: PersonalizationAgent = {
  name: "personalization",
  model: "timid-mock",
  promptVersion: "timid-v1",
  schemaVersion: "personalization-schema-v1",
  async personalize(input) {
    const sourceUrl = input.trustedSourceUrls[0]!;
    return {
      responseId: "timid",
      model: "timid-mock",
      output: {
        fields: input.declaredFields.map((name) => ({
          name,
          value: "A hedged sentence.",
          confidence: 0.2,
          sourceUrls: [sourceUrl],
        })),
        sources: [
          {
            url: sourceUrl,
            title: "Caller-supplied research",
            supports: ["personalization" as const],
            retrievedAt: null,
          },
        ],
      },
      sources: [{ url: sourceUrl }],
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      costUsd: 0,
    };
  },
};

/** An agent that cites a URL nobody supplied. */
const inventiveAgent: PersonalizationAgent = {
  ...timidAgent,
  model: "inventive-mock",
  async personalize(input) {
    return {
      responseId: "inventive",
      model: "inventive-mock",
      output: {
        fields: input.declaredFields.map((name) => ({
          name,
          value: "A sentence with a source nobody gave it.",
          confidence: 0.99,
          sourceUrls: ["https://invented.example/not-supplied"],
        })),
        sources: [
          {
            url: "https://invented.example/not-supplied",
            title: "Invented",
            supports: ["personalization" as const],
            retrievedAt: null,
          },
        ],
      },
      sources: [{ url: "https://invented.example/not-supplied" }],
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      costUsd: 0,
    };
  },
};

async function fixture(
  options: {
    declared?: Record<string, unknown>;
    researched?: boolean;
    evidence?: boolean;
  } = {},
) {
  const suffix = crypto.randomUUID().slice(0, 8);
  const [account] = await db
    .insert(schema.accounts)
    .values({
      name: `Acme ${suffix}`,
      normalizedName: `acme-${suffix}`,
      ...(options.researched === false
        ? {}
        : {
            researchStatus: "complete" as const,
            researchSnapshot: { summary: "Builds evidence-backed tooling" },
            researchedAt: NOW,
          }),
    })
    .returning();
  if (options.evidence !== false) {
    await db.insert(schema.evidenceSources).values({
      accountId: account!.id,
      url: EVIDENCE_URL,
      sourceType: "website",
    });
  }
  const [contact] = await db
    .insert(schema.contacts)
    .values({
      accountId: account!.id,
      firstName: "Ada",
      lastName: "Lovelace",
      fullName: "Ada Lovelace",
      normalizedFullName: `ada-${suffix}`,
      jobTitle: "CTO",
    })
    .returning();
  const [campaign] = await db
    .insert(schema.campaigns)
    .values({
      name: `Personalized ${suffix}`,
      type: "commercial_outreach",
      status: "active",
      targetDescription: "Let the agent write one sentence",
    })
    .returning();
  const [version] = await db
    .insert(schema.campaignVersions)
    .values({ campaignId: campaign!.id, version: 1 })
    .returning();
  await db.insert(schema.sequenceSteps).values({
    campaignVersionId: version!.id,
    stepIndex: 0,
    delayMinutes: 0,
    subjectTemplate: "Hello {{first_name}}",
    // The template names exactly the fields the step declares, because a
    // template variable the agent was never asked to write cannot resolve.
    bodyTemplate:
      options.declared === undefined
        ? "A note for {{company}}"
        : `${((options.declared as { fields: string[] }).fields ?? [])
            .map((field) => `{{${field}}}`)
            .join(" ")} — about {{company}}`,
    ...(options.declared === undefined
      ? {}
      : { personalizationSchema: options.declared }),
  });
  await db
    .update(schema.campaignVersions)
    .set({ publishedAt: NOW })
    .where(eq(schema.campaignVersions.id, version!.id));
  const [enrollment] = await db
    .insert(schema.enrollments)
    .values({
      campaignId: campaign!.id,
      campaignVersionId: version!.id,
      contactId: contact!.id,
      state: "ready_for_review",
    })
    .returning();
  return { account: account!, enrollment: enrollment! };
}

function generate(
  enrollmentId: string,
  agent: PersonalizationAgent = deterministicAgent,
) {
  return generateWithPersonalization(db, agent, {
    enrollmentId,
    stepIndex: 0,
    recipient: `ada-${crypto.randomUUID().slice(0, 8)}@example.com`,
  });
}

async function fieldsFor(messageId: string) {
  return db
    .select()
    .from(schema.messagePersonalizationFields)
    .where(eq(schema.messagePersonalizationFields.messageId, messageId));
}

describe("the agent writes part of the message", () => {
  beforeAll(async () => {
    await client.unsafe("drop schema if exists public cascade");
    await client.unsafe("drop schema if exists drizzle cascade");
    await client.unsafe("create schema public");
    await migrate(drizzle(client), { migrationsFolder: "drizzle" });
  });

  afterAll(async () => {
    await client.end();
  });

  it("leaves a step that declares nothing entirely deterministic", async () => {
    const seeded = await fixture();

    const result = await generate(seeded.enrollment.id);

    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    expect(result.message.body).toBe(`A note for ${seeded.account.name}`);
    expect(await fieldsFor(result.message.id)).toHaveLength(0);
  });

  it("puts the agent's sentence in the body and keeps its evidence", async () => {
    const seeded = await fixture({
      declared: { fields: ["personalized_opening"], minConfidence: 0.5 },
    });

    const result = await generate(seeded.enrollment.id);

    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    expect(result.message.body).toContain("Your work as CTO");
    expect(result.message.body).toContain(seeded.account.name);
    const fields = await fieldsFor(result.message.id);
    expect(fields).toHaveLength(1);
    expect(fields[0]).toMatchObject({
      name: "personalized_opening",
      confidence: "0.500",
      sourceUrls: [EVIDENCE_URL],
    });
    expect(fields[0]!.agentRunId).toBeTruthy();
  });

  // The default threshold and the deterministic agent's confidence are the
  // same number on purpose. Raising the default must be a deliberate act, not
  // something that quietly stops every mock-backed test from producing a
  // message.
  it("passes at exactly the default threshold", async () => {
    const seeded = await fixture({
      declared: { fields: ["company_relevance"] },
    });

    expect(await generate(seeded.enrollment.id)).toMatchObject({ ok: true });
  });

  it("produces nothing when the agent is not confident enough, and says how confident it was", async () => {
    const seeded = await fixture({
      declared: { fields: ["personalized_opening"], minConfidence: 0.5 },
    });

    const result = await generate(seeded.enrollment.id, timidAgent);

    expect(result).toMatchObject({ ok: false, code: "LOW_CONFIDENCE" });
    if (result.ok) return;
    expect(result.message).toContain("0.20");
    expect(result.message).toContain("0.50");
    const messages = await db
      .select()
      .from(schema.messages)
      .where(eq(schema.messages.enrollmentId, seeded.enrollment.id));
    expect(messages).toHaveLength(0);
  });

  // The provenance module exists to make this impossible, and this is the
  // clause most likely to fail on a fast model.
  // Two fields, one confident and one not. A message is either good enough or
  // it is not; the weakest sentence in it decides.
  it("refuses when only one of two declared fields is weak", async () => {
    const seeded = await fixture({
      declared: {
        fields: ["personalized_opening", "company_relevance"],
        minConfidence: 0.5,
      },
    });
    const unevenAgent: PersonalizationAgent = {
      ...timidAgent,
      model: "uneven-mock",
      async personalize(input) {
        const sourceUrl = input.trustedSourceUrls[0]!;
        return {
          responseId: "uneven",
          model: "uneven-mock",
          output: {
            fields: input.declaredFields.map((name, index) => ({
              name,
              value: `Sentence ${index}.`,
              confidence: index === 0 ? 0.95 : 0.2,
              sourceUrls: [sourceUrl],
            })),
            sources: [
              {
                url: sourceUrl,
                title: "Caller-supplied research",
                supports: ["personalization" as const],
                retrievedAt: null,
              },
            ],
          },
          sources: [{ url: sourceUrl }],
          usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
          costUsd: 0,
        };
      },
    };

    const result = await generate(seeded.enrollment.id, unevenAgent);

    expect(result).toMatchObject({ ok: false, code: "LOW_CONFIDENCE" });
    if (result.ok) return;
    expect(result.message).toContain("0.20");
  });

  it("produces nothing when the agent cites a source nobody supplied", async () => {
    const seeded = await fixture({
      declared: { fields: ["personalized_opening"], minConfidence: 0.5 },
    });

    const result = await generate(seeded.enrollment.id, inventiveAgent);

    expect(result).toMatchObject({ ok: false, code: "AGENT_ERROR" });
    expect(
      await db
        .select()
        .from(schema.messages)
        .where(eq(schema.messages.enrollmentId, seeded.enrollment.id)),
    ).toHaveLength(0);
  });

  // Not a failure and not something a retry can fix: there is nothing to
  // personalize from until research runs.
  it("waits for research instead of calling the agent at all", async () => {
    const seeded = await fixture({
      declared: { fields: ["personalized_opening"], minConfidence: 0.5 },
      researched: false,
      evidence: false,
    });
    let called = false;
    const watchfulAgent: PersonalizationAgent = {
      ...deterministicAgent,
      async personalize(input) {
        called = true;
        return deterministicAgent.personalize(input);
      },
    };

    const result = await generate(seeded.enrollment.id, watchfulAgent);

    expect(result).toMatchObject({ ok: false, code: "AWAITING_RESEARCH" });
    expect(called).toBe(false);
  });

  it("waits when research completed but left no evidence to cite", async () => {
    const seeded = await fixture({
      declared: { fields: ["personalized_opening"], minConfidence: 0.5 },
      evidence: false,
    });

    expect(await generate(seeded.enrollment.id)).toMatchObject({
      ok: false,
      code: "AWAITING_RESEARCH",
    });
  });
});

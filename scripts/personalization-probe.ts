#!/usr/bin/env tsx
/**
 * Measures whether the fast lane can hold the personalization contract, before
 * a campaign depends on it.
 *
 * The unknown is not the transport — that is exercised elsewhere. It is
 * whether `AI_FAST_MODEL` at `AI_FAST_EFFORT` returns a single valid JSON
 * object, restricts its citations to the URLs it was given, and marks each of
 * them `supports: ["personalization"]`. That last clause is the one most
 * likely to fail on a fast model, and it is what stands between the operator
 * and a sentence citing a page nobody supplied.
 *
 * It drives the operator's own ChatGPT window, so it is theirs to run:
 *
 *   npm run probe:personalization -- --runs 10
 *   npm run probe:personalization -- --account "Radiance"
 *
 * With no account it uses a fixed synthetic context, which measures the
 * contract without touching the operator's data.
 *
 * Stop the maintenance worker first. It drives the same single ChatGPT window
 * from another process, and a turn's deadline counts the time it spends
 * queued — run both at once and one of them dies without ever being sent.
 */
import { config } from "dotenv";
import { eq } from "drizzle-orm";

import { getDatabase } from "@/lib/db/client-core";
import { accounts, evidenceSources } from "@/lib/db/schema";
import { createProductionAIProviderBundle } from "@/lib/ai/production-provider-bundle";
import { createAgentSetFromBundle } from "@/modules/agents/factory";
import { AgentProvenanceError } from "@/modules/agents/provenance";
import { validatePersonalizationPostconditions } from "@/modules/agents/provenance";
import type { PersonalizationInput } from "@/modules/agents/schemas";

// Same bootstrap as `migrate.ts` and `seed.ts`. Without it this script reads a
// bare `process.env`: `AI_PROVIDER` is unset, the bundle reports itself as the
// mock, and the probe exits before its first turn — which is what it did every
// time until somebody ran the command the plan hands the operator.
config({ path: ".env.local" });
config({ path: ".env" });

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

const requestedRuns = Number.parseInt(argument("runs") ?? "10", 10);
if (
  !Number.isInteger(requestedRuns) ||
  requestedRuns < 1 ||
  requestedRuns > 50
) {
  process.stdout.write("--runs must be a whole number between 1 and 50.\n");
  process.exit(1);
}
const runs = requestedRuns;
const accountName = argument("account");

const synthetic: PersonalizationInput = {
  declaredFields: ["personalized_opening"],
  trustedSourceUrls: ["https://example.com/about"],
  context: {
    company: "Example Industries",
    firstName: "Ada",
    jobTitle: "Chief Technology Officer",
    research: {
      summary: "Example Industries builds measurement tools for laboratories.",
      signals: ["Published a hardware roadmap", "Hiring embedded engineers"],
    },
  },
};

async function realInput(name: string): Promise<PersonalizationInput> {
  const db = getDatabase();
  const [account] = await db
    .select()
    .from(accounts)
    .where(eq(accounts.name, name))
    .limit(1);
  if (!account) throw new Error(`No account named ${name}`);
  const sources = await db
    .select({ url: evidenceSources.url })
    .from(evidenceSources)
    .where(eq(evidenceSources.accountId, account.id));
  if (sources.length === 0) {
    throw new Error(`${name} has no evidence sources to cite`);
  }
  return {
    declaredFields: ["personalized_opening"],
    trustedSourceUrls: sources.map((row) => row.url),
    context: {
      company: account.name,
      firstName: "Ada",
      jobTitle: "Chief Technology Officer",
      research: account.researchSnapshot ?? {},
    },
  };
}

const input = accountName ? await realInput(accountName) : synthetic;
const bundle = createProductionAIProviderBundle(process.env);
if (!bundle.usesRealInfrastructure) {
  process.stdout.write(
    "AI_PROVIDER is mock. This probe measures the live surface; set AI_PROVIDER=chatgpt_desktop to run it.\n",
  );
  process.exit(1);
}
const agent = createAgentSetFromBundle(bundle).personalization;

let valid = 0;
let provenanceFailures = 0;
let otherFailures = 0;
const confidences: number[] = [];
const durations: number[] = [];

for (let run = 1; run <= runs; run += 1) {
  const startedAt = Date.now();
  try {
    const result = await agent.personalize(input);
    validatePersonalizationPostconditions(input, result);
    valid += 1;
    for (const field of result.output.fields)
      confidences.push(field.confidence);
    durations.push(Date.now() - startedAt);
    process.stdout.write(
      `run ${run}: ok in ${Math.round((Date.now() - startedAt) / 1000)} s — ${result.output.fields
        .map((field) => `${field.name} ${field.confidence.toFixed(2)}`)
        .join(", ")}\n`,
    );
  } catch (error) {
    durations.push(Date.now() - startedAt);
    if (error instanceof AgentProvenanceError) {
      provenanceFailures += 1;
      process.stdout.write(`run ${run}: provenance — ${error.message}\n`);
    } else {
      otherFailures += 1;
      process.stdout.write(
        `run ${run}: failed — ${error instanceof Error ? error.message : "unknown"}\n`,
      );
    }
  }
}

const average = (values: number[]) =>
  values.length === 0
    ? 0
    : values.reduce((total, value) => total + value, 0) / values.length;

process.stdout.write(
  `\n=== ${runs} runs on ${bundle.nonWeb.model} ===\n` +
    `contract held:        ${valid}/${runs}\n` +
    `provenance refused:   ${provenanceFailures}\n` +
    `other failures:       ${otherFailures}\n` +
    `mean confidence:      ${average(confidences).toFixed(2)}\n` +
    `mean duration:        ${Math.round(average(durations) / 1000)} s\n` +
    "\nA contract rate below roughly nine in ten is the signal to move\n" +
    "personalization to the research lane and accept its latency.\n",
);

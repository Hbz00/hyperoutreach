#!/usr/bin/env tsx
/**
 * Does telling the discovery agent what a job title *is* stop it returning
 * LinkedIn headlines?
 *
 * A real run stored six headlines out of ten ("Directeur agence chez FedEx
 * Express FR"), and the deterministic stripper now removes the employer before
 * the write. This measures whether the instruction change is worth making on
 * top of that — fewer headlines to strip, or no measurable difference.
 *
 * Arms alternate (control-A, treatment-A, control-B, treatment-B) so the
 * ChatGPT app's silent search degradation after a long session drifts onto both
 * arms rather than only the later one. Writes nothing: no agent_runs, no
 * contacts. The only database access is reading account names and domains.
 */
import { setTimeout as sleep } from "node:timers/promises";
import { writeFileSync } from "node:fs";

import { config } from "dotenv";

config({ path: ".env.local" });
config({ path: ".env" });

import { inArray } from "drizzle-orm";

import { getDatabase } from "@/lib/db/client-core";
import { maintenanceState, operatorCommands } from "@/lib/db/schema";
import { createProductionAIProviderBundle } from "@/lib/ai/production-provider-bundle";
import { contactDiscoveryOutputSchema } from "@/modules/agents/schemas";
import { withoutEmployer } from "@/modules/contacts/job-title";

const OUT = process.argv[2] ?? "job-title-probe.json";
const GAP_MS = 300_000;

const CONTROL =
  "Find current employees matching the requested roles. Each contact must include public evidence collectively supporting both current employment and current job title. Never invent a profile or stale role.";

const TREATMENT =
  CONTROL +
  " jobTitle is the short title as it would appear on a business card — 'Directeur des opérations', 'Head of Logistics' — never the profile headline. Strip the employer: a title must not contain the company name, its abbreviation, or a 'chez'/'at'/'@' clause naming it. Strip taglines, emoji, and anything after a '|'.";

const bundle = createProductionAIProviderBundle(process.env);
if (!bundle.usesRealInfrastructure) {
  process.stdout.write(
    "Provider bundle is in mock mode; nothing to measure.\n",
  );
  process.exit(1);
}
const lane = bundle.research;
const db = getDatabase();

async function windowIsFree(): Promise<string | null> {
  const [maintenance] = await db.select().from(maintenanceState).limit(1);
  if (maintenance?.ownerToken && maintenance.heartbeatAt) {
    const ageMs = Date.now() - maintenance.heartbeatAt.getTime();
    if (ageMs < 120_000)
      return `maintenance lease held (${Math.round(ageMs / 1000)}s ago)`;
  }
  const queued = await db
    .select({ id: operatorCommands.id })
    .from(operatorCommands)
    .where(inArray(operatorCommands.status, ["queued", "running"]));
  if (queued.length > 0) return `${queued.length} operator command(s) queued`;
  return null;
}

async function waitForWindow(): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const busy = await windowIsFree();
    if (!busy) return;
    process.stdout.write(`  waiting: ${busy}\n`);
    await sleep(15_000);
  }
  throw new Error("ChatGPT window never came free");
}

type Arm = { arm: "control" | "treatment"; instructions: string };
const ARMS: Record<string, Arm> = {
  control: { arm: "control", instructions: CONTROL },
  treatment: { arm: "treatment", instructions: TREATMENT },
};

const COMPANIES = [
  { name: "Mondial Relay", domain: "mondialrelay.fr" },
  { name: "Colis Privé", domain: "colisprive.fr" },
];

const PLAN: Array<{ company: (typeof COMPANIES)[number]; arm: Arm }> = [
  { company: COMPANIES[0]!, arm: ARMS.control! },
  { company: COMPANIES[0]!, arm: ARMS.treatment! },
  { company: COMPANIES[1]!, arm: ARMS.control! },
  { company: COMPANIES[1]!, arm: ARMS.treatment! },
];

const results: unknown[] = [];
let failedRuns = 0;

for (const [index, step] of PLAN.entries()) {
  if (index > 0) {
    process.stdout.write(
      `\nsleeping ${GAP_MS / 60_000} min before run ${index + 1}\n`,
    );
    await sleep(GAP_MS);
  }
  process.stdout.write(
    `\n=== run ${index + 1}/${PLAN.length}: ${step.arm.arm} @ ${step.company.name} ===\n`,
  );
  await waitForWindow();
  const startedAt = new Date().toISOString();
  try {
    const result = await lane.provider.run({
      agent: "contact_discovery",
      model: lane.model,
      instructions: step.arm.instructions,
      input: {
        account: {
          id: "00000000-0000-4000-8000-000000000000",
          name: step.company.name,
          domain: step.company.domain,
        },
        roles: ["Directeur des opérations", "Responsable logistique"],
        limit: 6,
      },
      outputSchema: contactDiscoveryOutputSchema,
      outputName: "contact-discovery-schema-v1",
      useWebSearch: true,
    });
    const titles = result.output.contacts.map((contact) => contact.jobTitle);
    const scored = titles.map((title) => ({
      title,
      carriesEmployer: withoutEmployer(title, step.company).employerRemoved,
    }));
    const carrying = scored.filter((row) => row.carriesEmployer).length;
    results.push({
      run: index + 1,
      arm: step.arm.arm,
      company: step.company.name,
      startedAt,
      finishedAt: new Date().toISOString(),
      webSearchCalls: result.toolUsage?.webSearchCalls ?? null,
      contacts: titles.length,
      carryingEmployer: carrying,
      scored,
    });
    process.stdout.write(
      `  ${carrying}/${titles.length} titles carry the employer` +
        ` (web searches: ${result.toolUsage?.webSearchCalls ?? "unreported"})\n`,
    );
    for (const row of scored) {
      process.stdout.write(
        `    ${row.carriesEmployer ? "X" : "."} ${row.title}\n`,
      );
    }
  } catch (error) {
    failedRuns += 1;
    const message = error instanceof Error ? error.message : String(error);
    results.push({
      run: index + 1,
      arm: step.arm.arm,
      company: step.company.name,
      startedAt,
      error: message,
    });
    process.stdout.write(`  FAILED: ${message}\n`);
  }
  writeFileSync(OUT, JSON.stringify(results, null, 2));
}

process.stdout.write(`\nwrote ${OUT}\n`);
process.exit(failedRuns > 0 ? 1 : 0);

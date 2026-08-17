#!/usr/bin/env tsx
/**
 * Measures whether a candidate prompt finds more public address evidence than
 * the shipped one, before a campaign depends on the answer.
 *
 * The pipeline that turns evidence into an address is deterministic and already
 * tested. What is unmeasured is *recall*: how many named addresses on a company
 * domain the research lane actually surfaces. That number is what decides
 * whether email resolution is automatable on an ICP, because the shipped
 * scoring needs two unambiguous samples to clear the default 0.85 threshold —
 * one sample scores 0.75 and lands the contact in manual review.
 *
 * Two things make this a measurement rather than an opinion:
 *
 * - It scores each variant with the production `inferEmailPatterns` and
 *   `scoreEmailCandidate`, so a "win" means a contact would actually resolve,
 *   not merely that more JSON came back.
 * - It fetches every cited page and checks the address literally appears there.
 *   The shipped provenance check only verifies that a sample's URL was among the
 *   model's own declared sources; nothing reads the page. A prompt that raises
 *   recall by inventing plausible addresses would look like an improvement
 *   without this, so unverified samples are reported separately and never
 *   counted as a win.
 *
 * It drives the operator's own ChatGPT window, so it is theirs to run:
 *
 *   npm run probe:public-email                      # 5 domains, both variants
 *   npm run probe:public-email -- --domains 10
 *   npm run probe:public-email -- --domain jetransporte.com
 *
 * Stop the maintenance worker first. It drives the same single window from
 * another process, and a turn's deadline counts the time it spends queued — run
 * both at once and one of them dies without ever being sent. The probe refuses
 * to start while a maintenance lease looks live.
 *
 * It writes nothing: no `agent_runs`, no candidates, no contact state. The only
 * database access is reading account domains.
 */
import { config } from "dotenv";

import { getDatabase } from "@/lib/db/client-core";
import { accounts, maintenanceState } from "@/lib/db/schema";
import { createProductionAIProviderBundle } from "@/lib/ai/production-provider-bundle";
import type { StructuredAIProvider } from "@/lib/ai/providers/types";
import {
  publicEmailEvidenceInstructions,
  publicEmailEvidenceOutputSchema,
  PUBLIC_EMAIL_EVIDENCE_INSTRUCTIONS,
  PUBLIC_EMAIL_EVIDENCE_PROMPT_VERSION,
  type PublicEmailSample,
} from "@/modules/email-resolution/public-evidence-provider";
import {
  inferEmailPatterns,
  scoreEmailCandidate,
} from "@/modules/email-resolution/patterns";
import { DEFAULT_EMAIL_CONFIDENCE_THRESHOLD } from "@/modules/email-resolution/service";

// Same bootstrap as the other scripts: without it `AI_PROVIDER` is unset and the
// bundle reports itself as the mock.
config({ path: ".env.local" });
config({ path: ".env" });

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

/**
 * The instructions the application actually sends, imported rather than copied:
 * a benchmark whose baseline is a hand-maintained copy measures the copy.
 */
const SHIPPED_INSTRUCTIONS = PUBLIC_EMAIL_EVIDENCE_INSTRUCTIONS;

/**
 * The editable slot for the next experiment.
 *
 * It currently holds a copy of what shipped, so a run with no edit compares a
 * prompt against itself and reports a flat result — which is the honest reading
 * of "nothing was proposed". Change this constant, run the probe, and read the
 * `domains that resolve` line: a candidate earns production only by raising it
 * while keeping unverified samples at zero.
 *
 * Note what "unverified" can and cannot mean here. The verifier is an ordinary
 * HTTP client: LinkedIn answers it 999 and contact aggregators answer 403,
 * while the ChatGPT app reads both — that is why this installation uses the app
 * at all. A source it cannot open is therefore out of reach, not discredited.
 * Only a readable page that does not contain the address is evidence of a
 * fabrication, and only that should count against a candidate.
 */
const CANDIDATE_INSTRUCTIONS = PUBLIC_EMAIL_EVIDENCE_INSTRUCTIONS;

/**
 * The variant measured on 2026-08-17 against ten French road-freight carriers,
 * kept verbatim so the numbers that justified prompt v2 can be reproduced. It
 * is the shipped v1 text plus the "find as many as you can" and document-family
 * clauses, and without the two prohibitions v2 later added.
 *
 * Recorded because the comparison was run from an off-tree edit and nothing in
 * the repository could reproduce it — a measurement nobody can repeat is an
 * anecdote. Scored on verified samples only, it moved `domains that resolve`
 * from 2/10 to 3/10 and produced 4 samples whose readable cited page did not
 * contain the address; rescored counting sources the verifier cannot open but
 * the ChatGPT app can — LinkedIn, contact databases — it reached 6/10. v2 keeps
 * its gains and targets those 4 fabrications by name, and has not itself been
 * measured.
 */
export const MEASURED_2026_08_17_CANDIDATE = [
  "Search public web sources for named employee email addresses on the exact company domain.",
  "Find as many distinct named addresses as you can, not just the first one: two or more from different people are far more useful than one.",
  'Search documents as well as web pages, because companies that publish no address on their own site still appear in files written by others: PDFs (event and training programmes, press kits, tender documents, meeting minutes), press releases, legal notices, conference programmes, job adverts, and association or trade-body publications. The literal query "@<domain>" is an effective way to find these.',
  "Report only addresses of named individuals; skip role and department mailboxes such as contact@, info@ or sales@.",
  "Return only addresses visibly supported by the cited page. Do not infer or generate addresses.",
].join(" ");

const VARIANTS = [
  { key: "shipped", instructions: SHIPPED_INSTRUCTIONS },
  { key: "candidate", instructions: CANDIDATE_INSTRUCTIONS },
] as const;

type VariantKey = (typeof VARIANTS)[number]["key"];

const requestedDomains = Number.parseInt(argument("domains") ?? "5", 10);
if (
  !Number.isInteger(requestedDomains) ||
  requestedDomains < 1 ||
  requestedDomains > 25
) {
  process.stdout.write("--domains must be a whole number between 1 and 25.\n");
  process.exit(1);
}
/**
 * A comma-separated list, not one domain: "the first N accounts by name" is a
 * poor benchmark set. It silently included this installation's own company and
 * pushed a large group out of a ten-domain slice — exactly the comparison the
 * run existed to make. Naming the set makes it reproducible and reviewable.
 */
const chosenDomains = (argument("domain") ?? "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
// Bounded like `--domains`, and checked: each turn is a live web search on a
// budget that degrades silently, so a fat-fingered list is an expensive typo.
if (chosenDomains.length > 25) {
  process.stdout.write("--domain accepts at most 25 domains.\n");
  process.exit(1);
}
for (const candidate of chosenDomains) {
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(candidate)) {
    process.stdout.write(
      `--domain contains something that is not a domain: ${candidate}\n`,
    );
    process.exit(1);
  }
}

const bundle = createProductionAIProviderBundle(process.env);
if (!bundle.usesRealInfrastructure) {
  process.stdout.write(
    "The provider bundle is in mock mode, so there is nothing to measure.\n" +
      "Set AI_PROVIDER=chatgpt_desktop in .env.local and try again.\n",
  );
  process.exit(1);
}
const lane = bundle.research;
const provider: StructuredAIProvider = lane.provider;

const db = getDatabase();

const [maintenance] = await db.select().from(maintenanceState).limit(1);
if (maintenance?.ownerToken && maintenance.heartbeatAt) {
  const ageMs = Date.now() - maintenance.heartbeatAt.getTime();
  if (ageMs < 120_000) {
    process.stdout.write(
      `A maintenance cycle holds the lease (heartbeat ${Math.round(ageMs / 1000)} s ago).\n` +
        "Stop the local stack before probing: it drives the same ChatGPT window.\n",
    );
    process.exit(1);
  }
}

const domains = chosenDomains.length
  ? chosenDomains
  : (
      await db
        .select({ name: accounts.name, domain: accounts.domain })
        .from(accounts)
        .orderBy(accounts.name)
    )
      .flatMap((row) => (row.domain ? [row.domain] : []))
      .slice(0, requestedDomains);

if (domains.length === 0) {
  process.stdout.write("No account domains to probe.\n");
  process.exit(1);
}

/**
 * Reads a cited page and answers whether the address is really on it.
 *
 * `null` means the page could not be read at all — a 403 from a site that
 * refuses robots is not evidence either way, and counting it as a fabrication
 * would slander an honest sample.
 */
async function pageContains(
  url: string,
  email: string,
): Promise<boolean | null> {
  let response: Response;
  try {
    response = await fetch(url, {
      redirect: "follow",
      headers: { "user-agent": "Mozilla/5.0" },
      signal: AbortSignal.timeout(45_000),
    });
  } catch {
    return null;
  }
  if (!response.ok) return null;
  const type = response.headers.get("content-type") ?? "";
  let text: string;
  if (type.includes("pdf") || url.toLowerCase().endsWith(".pdf")) {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const { writeFile, mkdtemp, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const directory = await mkdtemp(join(tmpdir(), "probe-pdf-"));
    const file = join(directory, "page.pdf");
    try {
      await writeFile(file, Buffer.from(await response.arrayBuffer()));
      const { stdout } = await promisify(execFile)("pdftotext", [file, "-"], {
        maxBuffer: 32 * 1024 * 1024,
      });
      text = stdout;
    } catch {
      return null;
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  } else {
    try {
      text = await response.text();
    } catch {
      // A body that dies mid-read is unreadable, not fabricated — and it must
      // not take down a run whose live turns are already spent.
      return null;
    }
  }
  return text.toLowerCase().includes(email.toLowerCase());
}

type DomainOutcome = {
  samples: PublicEmailSample[];
  verified: number;
  unverified: number;
  unreadable: number;
  bestPattern: string | null;
  bestSampleCount: number;
  score: number;
  resolves: boolean;
  durationMs: number;
  error: string | null;
};

async function probe(
  domain: string,
  instructions: string,
): Promise<DomainOutcome> {
  const startedAt = Date.now();
  const empty = {
    samples: [] as PublicEmailSample[],
    verified: 0,
    unverified: 0,
    unreadable: 0,
    bestPattern: null,
    bestSampleCount: 0,
    score: 0,
    resolves: false,
  };
  let samples: PublicEmailSample[];
  try {
    const result = await provider.run({
      agent: "public_email_evidence",
      model: lane.model,
      // The same interpolation production performs, through the same function,
      // so the probe cannot measure a prompt the application does not send.
      instructions:
        instructions === PUBLIC_EMAIL_EVIDENCE_INSTRUCTIONS
          ? publicEmailEvidenceInstructions(domain)
          : instructions.replaceAll("<domain>", domain),
      input: { companyDomain: domain },
      outputSchema: publicEmailEvidenceOutputSchema,
      outputName: "public-email-evidence-schema-v1",
      useWebSearch: true,
    });
    samples = publicEmailEvidenceOutputSchema.parse(result.output).samples;
  } catch (error) {
    return {
      ...empty,
      durationMs: Date.now() - startedAt,
      error: error instanceof Error ? error.name : "unknown",
    };
  }

  let verified = 0;
  let unverified = 0;
  let unreadable = 0;
  const confirmed: PublicEmailSample[] = [];
  for (const sample of samples) {
    const present = await pageContains(sample.sourceUrl, sample.email);
    if (present === null) unreadable += 1;
    else if (present) {
      verified += 1;
      confirmed.push(sample);
    } else unverified += 1;
  }

  // Scored on confirmed samples only: a prompt must not win by inventing.
  const patterns = inferEmailPatterns(confirmed, domain);
  const best = patterns[0];
  const score = best
    ? scoreEmailCandidate({ sampleCount: best.sampleCount, mxValid: true })
    : 0;
  return {
    samples,
    verified,
    unverified,
    unreadable,
    bestPattern: best?.pattern ?? null,
    bestSampleCount: best?.sampleCount ?? 0,
    score,
    resolves: score >= DEFAULT_EMAIL_CONFIDENCE_THRESHOLD,
    durationMs: Date.now() - startedAt,
    error: null,
  };
}

const results = new Map<VariantKey, DomainOutcome[]>();
for (const variant of VARIANTS) results.set(variant.key, []);

process.stdout.write(
  `Probing ${domains.length} domain(s) on ${lane.model} at ${lane.effort ?? "default"} effort,\n` +
    `${VARIANTS.length} prompt variants each — ${domains.length * VARIANTS.length} turns, one at a time.\n` +
    // Without this, two runs months apart are indistinguishable in their own
    // output, and the numbers cannot be attributed to a prompt.
    `shipped prompt: ${PUBLIC_EMAIL_EVIDENCE_PROMPT_VERSION}\n\n`,
);

for (const [index, domain] of domains.entries()) {
  process.stdout.write(`${domain}\n`);
  // Alternating order, because turn latency drifts upward over a long session
  // (16 s to 41 s across ten consecutive turns, measured). Always probing the
  // shipped prompt first would load that drift onto the candidate.
  const order = index % 2 === 0 ? VARIANTS : [...VARIANTS].reverse();
  for (const variant of order) {
    // Sequential on purpose: one shared window, and a queued turn's deadline
    // runs while it waits.
    const outcome = await probe(domain, variant.instructions);
    results.get(variant.key)!.push(outcome);
    const detail = outcome.error
      ? `failed (${outcome.error})`
      : `${outcome.samples.length} sample(s) — verified ${outcome.verified}, unverified ${outcome.unverified}, unreadable ${outcome.unreadable}` +
        (outcome.bestPattern
          ? ` — ${outcome.bestPattern} ×${outcome.bestSampleCount}, score ${outcome.score.toFixed(2)}${outcome.resolves ? " RESOLVES" : ""}`
          : " — no pattern");
    process.stdout.write(
      `  ${variant.key.padEnd(8)} ${Math.round(outcome.durationMs / 1000)
        .toString()
        .padStart(3)} s  ${detail}\n`,
    );
    for (const sample of outcome.samples) {
      process.stdout.write(`           ${sample.email}  ${sample.sourceUrl}\n`);
    }
  }
  process.stdout.write("\n");
}

const total = (values: number[]) =>
  values.reduce((sum, value) => sum + value, 0);

process.stdout.write(`=== ${domains.length} domains, ${lane.model} ===\n`);
for (const variant of VARIANTS) {
  const outcomes = results.get(variant.key)!;
  const verified = total(outcomes.map((outcome) => outcome.verified));
  const unverified = total(outcomes.map((outcome) => outcome.unverified));
  const unreadable = total(outcomes.map((outcome) => outcome.unreadable));
  const resolvable = outcomes.filter((outcome) => outcome.resolves).length;
  const failures = outcomes.filter((outcome) => outcome.error).length;
  process.stdout.write(
    `${variant.key}\n` +
      `  verified samples:     ${verified}\n` +
      `  unverified samples:   ${unverified}   (cited a page that does not contain the address)\n` +
      `  unreadable sources:   ${unreadable}   (neither confirmed nor refuted)\n` +
      `  domains that resolve: ${resolvable}/${outcomes.length}   (>= ${DEFAULT_EMAIL_CONFIDENCE_THRESHOLD} on verified evidence)\n` +
      `  turn failures:        ${failures}\n` +
      `  mean duration:        ${Math.round(total(outcomes.map((outcome) => outcome.durationMs)) / outcomes.length / 1000)} s\n`,
  );
}

process.stdout.write(
  "\nThe decisive column is `domains that resolve`: more samples that no page\n" +
    "confirms is a loss, not a win. A tuned prompt earns its place only by\n" +
    "raising that count while keeping unverified samples at zero.\n",
);

// Non-zero when a turn failed, so the script can gate something one day
// rather than always reporting success whatever happened.
const failedTurns = [...results.values()]
  .flat()
  .filter((outcome) => outcome.error).length;
process.exit(failedTurns > 0 ? 1 : 0);

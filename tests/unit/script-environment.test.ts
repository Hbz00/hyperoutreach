import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const scriptsRoot = join(process.cwd(), "scripts");

/**
 * A script reaches configured state when it opens the database or builds the
 * real AI provider bundle. Both read `process.env`, and a script run through
 * `tsx` gets a bare one — Next.js loads `.env.local`, but nothing else does.
 */
const NEEDS_ENVIRONMENT =
  /getDatabase|createProductionAIProviderBundle|process\.env\.(TEST_)?DATABASE_URL/;

const LOADS_ENVIRONMENT = /config\(\{\s*path:\s*"\.env\.local"\s*\}\)/;

describe("scripts that reach configured state", () => {
  const scripts = readdirSync(scriptsRoot)
    .filter((name) => name.endsWith(".ts"))
    .map((name) => ({
      name,
      source: readFileSync(join(scriptsRoot, name), "utf8"),
    }));

  it("finds the scripts to check", () => {
    expect(scripts.length).toBeGreaterThan(3);
  });

  // `personalization-probe.ts` shipped without this and could therefore never
  // run: it read a bare `process.env`, found no `AI_PROVIDER`, reported itself
  // as the mock and exited before its first turn. It is the one command the
  // design hands to the operator, and it had never been executed once. The
  // rule is asserted here rather than remembered.
  it("all load .env.local before reading it", () => {
    const offenders = scripts
      .filter((script) => NEEDS_ENVIRONMENT.test(script.source))
      .filter((script) => !LOADS_ENVIRONMENT.test(script.source))
      .map((script) => script.name);

    expect(offenders).toEqual([]);
  });

  it("checks a set that actually contains the probe", () => {
    const checked = scripts
      .filter((script) => NEEDS_ENVIRONMENT.test(script.source))
      .map((script) => script.name);

    expect(checked).toContain("personalization-probe.ts");
  });
});

import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as schema from "@/lib/db/schema";
import { resolveDatabaseUrls } from "@/lib/db/test-database";
import {
  accountHasDomainEvidence,
  hasDomainEvidence,
} from "@/modules/email-resolution/domain-evidence";

const { testUrl } = resolveDatabaseUrls(process.env);
const client = postgres(testUrl, { max: 4 });
const db = drizzle(client, { schema });

let sequence = 0;

/**
 * The two forms of one rule, answered for the same company.
 *
 * `sql` is what the company list asks of the database for every row at once;
 * `js` is what the prospect page and `resolveContactEmail` ask of rows they
 * already hold. Read together, in one helper, because the assertion worth
 * making is that they agree — two separate helpers could drift exactly the way
 * the three inline copies they replaced did.
 */
async function bothAnswers(accountId: string) {
  const [row] = await db
    .select({ answer: accountHasDomainEvidence() })
    .from(schema.accounts)
    .where(eq(schema.accounts.id, accountId));
  const sources = await db
    .select({ supports: schema.evidenceSources.supports })
    .from(schema.evidenceSources)
    .where(eq(schema.evidenceSources.accountId, accountId));
  return { sql: row!.answer, js: hasDomainEvidence(sources) };
}

async function companyWithEvidence(supportsPerSource: string[][]) {
  sequence += 1;
  const [account] = await db
    .insert(schema.accounts)
    .values({
      name: `Evidence ${sequence}`,
      normalizedName: `evidence-${sequence}`,
      domain: `evidence-${sequence}.example`,
    })
    .returning();
  for (const [index, supports] of supportsPerSource.entries()) {
    await db.insert(schema.evidenceSources).values({
      accountId: account!.id,
      url: `https://evidence-${sequence}.example/${index}`,
      sourceType: "website",
      supports,
    });
  }
  return account!;
}

beforeAll(async () => {
  await client.unsafe("drop schema if exists public cascade");
  await client.unsafe("drop schema if exists drizzle cascade");
  await client.unsafe("create schema public");
  await migrate(drizzle(client), { migrationsFolder: "drizzle" });
});

afterAll(async () => {
  await client.end();
});

describe("the domain-evidence rule answers the same in SQL and in memory", () => {
  const cases: Array<{ name: string; sources: string[][]; expected: boolean }> =
    [
      { name: "no evidence at all", sources: [], expected: false },
      { name: "a source supporting nothing", sources: [[]], expected: false },
      {
        name: "sources supporting other claims",
        sources: [["headcount"], ["news"]],
        expected: false,
      },
      {
        name: "one source tying the domain",
        sources: [["domain"]],
        expected: true,
      },
      {
        name: "the tie among other claims on one source",
        sources: [["news", "domain", "headcount"]],
        expected: true,
      },
      {
        name: "the tie on only one of several sources",
        sources: [["headcount"], ["news"], ["domain"]],
        expected: true,
      },
      // The tag is matched exactly. A near miss is a different claim, and
      // treating it as the tie would enable a button the resolver then refuses.
      {
        name: "a near-miss tag that is not the tie",
        sources: [["domains"], ["Domain"], ["domain-name"]],
        expected: false,
      },
    ];

  for (const { name, sources, expected } of cases) {
    it(`agrees on ${name}`, async () => {
      const account = await companyWithEvidence(sources);

      const answers = await bothAnswers(account.id);

      expect(answers.sql).toBe(expected);
      expect(answers.js).toBe(expected);
      // Stated as its own assertion rather than left implicit in the two above:
      // the property being defended is that the forms cannot diverge, not that
      // each happens to match a number written here.
      expect(answers.sql).toBe(answers.js);
    });
  }

  // The company list reads this for every row of a real page, where companies
  // that do and do not qualify sit next to each other.
  it("answers per company when several are read at once", async () => {
    const tied = await companyWithEvidence([["domain"]]);
    const untied = await companyWithEvidence([["headcount"]]);

    const rows = await db
      .select({ id: schema.accounts.id, answer: accountHasDomainEvidence() })
      .from(schema.accounts);
    const answers = new Map(rows.map((row) => [row.id, row.answer]));

    expect(answers.get(tied.id)).toBe(true);
    expect(answers.get(untied.id)).toBe(false);
  });
});

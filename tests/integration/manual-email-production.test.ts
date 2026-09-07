import { asc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as schema from "@/lib/db/schema";
import { resolveDatabaseUrls } from "@/lib/db/test-database";
import { createOrGetAccount } from "@/modules/accounts/service";
import { createOrGetContact } from "@/modules/contacts/service";
import { acceptManualEmail } from "@/modules/email-resolution/manual-service";

const { testUrl } = resolveDatabaseUrls(process.env);
const client = postgres(testUrl, { max: 5 });
const db = drizzle(client, { schema });

async function fixture(label: string) {
  const domain = `${label}.example.test`;
  const account = await createOrGetAccount(db, {
    name: `Manual audit ${label}`,
    domain,
  });
  if (!account.ok) throw new Error(`Account setup failed: ${account.code}`);
  const contact = await createOrGetContact(db, {
    accountId: account.account.id,
    firstName: "Alice",
    lastName: "Audit",
  });
  if (!contact.ok) throw new Error(`Contact setup failed: ${contact.code}`);
  const previous = await acceptManualEmail(db, {
    contactId: contact.contact.id,
    email: `previous@${domain}`,
    actor: "test",
  });
  if (!previous.ok)
    throw new Error(`Acceptance setup failed: ${previous.code}`);
  return {
    contactId: contact.contact.id,
    domain,
    previous: previous.candidate,
  };
}

async function snapshot(contactId: string) {
  return {
    candidates: await db
      .select()
      .from(schema.emailCandidates)
      .where(eq(schema.emailCandidates.contactId, contactId))
      .orderBy(asc(schema.emailCandidates.id)),
    contacts: await db
      .select()
      .from(schema.contacts)
      .where(eq(schema.contacts.id, contactId)),
    transitions: await db
      .select()
      .from(schema.stateTransitions)
      .where(eq(schema.stateTransitions.entityId, contactId))
      .orderBy(asc(schema.stateTransitions.id)),
  };
}

describe("manual address replacement atomicity", () => {
  beforeAll(async () => {
    await client.unsafe("drop schema if exists public cascade");
    await client.unsafe("drop schema if exists drizzle cascade");
    await client.unsafe("create schema public");
    await migrate(db, { migrationsFolder: "drizzle" });
  });
  afterAll(async () => {
    await client.end({ timeout: 5 });
  });

  it.each([false, true])(
    "leaves all previous data intact when a suppressed replacement is refused (existing=%s)",
    async (exists) => {
      const { contactId, domain } = await fixture(`suppressed-${exists}`);
      const email = `replacement@${domain}`;
      if (exists)
        await db.insert(schema.emailCandidates).values({
          contactId,
          email,
          normalizedEmail: email,
          domain,
          confidence: "0.800",
          source: "fixture",
        });
      await db
        .insert(schema.suppressionEntries)
        .values({ scope: "email", normalizedValue: email, reason: "manual" });
      const before = await snapshot(contactId);
      expect(
        await acceptManualEmail(db, { contactId, email, actor: "test" }),
      ).toEqual({ ok: false, code: "ADDRESS_SUPPRESSED" });
      expect(await snapshot(contactId)).toEqual(before);
    },
  );

  it("retains its accepted candidate when a dead replacement is refused", async () => {
    const { contactId, domain } = await fixture("dead");
    const email = `replacement@${domain}`;
    await db.insert(schema.emailCandidates).values({
      contactId,
      email,
      normalizedEmail: email,
      domain,
      confidence: "0.800",
      source: "fixture",
      deadAt: new Date(),
      status: "rejected",
    });
    const before = await snapshot(contactId);
    expect(
      await acceptManualEmail(db, { contactId, email, actor: "test" }),
    ).toEqual({ ok: false, code: "ADDRESS_DEAD" });
    expect(await snapshot(contactId)).toEqual(before);
  });

  it.each(["www", "path"])(
    "does not persist a different address after %s input",
    async (variant) => {
      const { contactId, domain } = await fixture(`identity-${variant}`);
      const email =
        variant === "www"
          ? `replacement@www.${domain}`
          : `replacement@${domain}/ignored`;
      const before = await snapshot(contactId);
      expect(
        await acceptManualEmail(db, { contactId, email, actor: "test" }),
      ).toEqual({
        ok: false,
        code: variant === "www" ? "DOMAIN_MISMATCH" : "INVALID_INPUT",
      });
      expect(await snapshot(contactId)).toEqual(before);
    },
  );

  it.each([false, true])(
    "atomically replaces an accepted address with a usable one (existing=%s)",
    async (exists) => {
      const { contactId, domain, previous } = await fixture(
        `success-${exists}`,
      );
      const email = `replacement@${domain}`;
      if (exists)
        await db.insert(schema.emailCandidates).values({
          contactId,
          email,
          normalizedEmail: email,
          domain,
          confidence: "0.800",
          source: "fixture",
        });
      const result = await acceptManualEmail(db, {
        contactId,
        email,
        actor: "test",
      });
      expect(result.ok).toBe(true);
      const stored = await snapshot(contactId);
      expect(
        stored.candidates
          .filter((row) => row.status === "accepted")
          .map((row) => row.normalizedEmail),
      ).toEqual([email]);
      expect(
        stored.candidates.find((row) => row.id === previous.id)?.status,
      ).toBe("rejected");
      expect(stored.contacts[0]?.emailResolutionStatus).toBe("resolved");
      expect(stored.transitions).toHaveLength(2);
      const after = await snapshot(contactId);
      expect(
        await acceptManualEmail(db, { contactId, email, actor: "test" }),
      ).toMatchObject({ ok: true, disposition: "already_accepted" });
      expect(await snapshot(contactId)).toEqual(after);
    },
  );
});

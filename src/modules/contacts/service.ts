import { and, eq, isNull, sql } from "drizzle-orm";

import { accounts, contacts } from "@/lib/db/schema";
import type { AppDatabase } from "@/lib/db/types";
import {
  parseContactInput,
  resolveContactIdentity,
} from "@/modules/contacts/input";

type Contact = typeof contacts.$inferSelect;

export type CreateContactResult =
  | { ok: true; disposition: "created" | "existing"; contact: Contact }
  | { ok: false; code: "INVALID_INPUT"; message: "Invalid contact input" }
  | { ok: false; code: "ACCOUNT_NOT_FOUND"; message: "Account not found" }
  | { ok: false; code: "DATABASE_ERROR"; message: "Could not save contact" };

export async function createOrGetContact(
  db: AppDatabase,
  rawInput: unknown,
): Promise<CreateContactResult> {
  let input;
  try {
    input = parseContactInput(rawInput);
  } catch {
    return {
      ok: false,
      code: "INVALID_INPUT",
      message: "Invalid contact input",
    };
  }

  try {
    return await db.transaction(async (tx) => {
      const [account] = await tx
        .select({ id: accounts.id })
        .from(accounts)
        .where(eq(accounts.id, input.accountId))
        .limit(1);
      if (!account) {
        return {
          ok: false,
          code: "ACCOUNT_NOT_FOUND",
          message: "Account not found",
        } as const;
      }

      const identity = resolveContactIdentity(input);
      const fallbackPredicate = and(
        eq(contacts.accountId, input.accountId),
        eq(contacts.normalizedFullName, input.normalizedFullName),
        isNull(contacts.linkedinUrl),
      );
      const predicate =
        identity.kind === "linkedin"
          ? eq(contacts.linkedinUrl, identity.value)
          : fallbackPredicate;
      const [existing] = await tx
        .select()
        .from(contacts)
        .where(predicate)
        .limit(1);
      if (existing) {
        return {
          ok: true,
          disposition: "existing",
          contact: existing,
        } as const;
      }

      if (identity.kind === "linkedin") {
        // Serialize enrichment of an existing weak-identity contact. A second
        // transaction waits here, then observes the strong global identity.
        await tx.execute(
          sql`select id from contacts where account_id = ${input.accountId} and normalized_full_name = ${input.normalizedFullName} and linkedin_url is null for update`,
        );
        const [racedStrongIdentity] = await tx
          .select()
          .from(contacts)
          .where(eq(contacts.linkedinUrl, identity.value))
          .limit(1);
        if (racedStrongIdentity) {
          return {
            ok: true,
            disposition: "existing",
            contact: racedStrongIdentity,
          } as const;
        }
        const [weakIdentity] = await tx
          .select()
          .from(contacts)
          .where(fallbackPredicate)
          .limit(1);
        if (weakIdentity) {
          const [enriched] = await tx
            .update(contacts)
            .set({
              linkedinUrl: identity.value,
              jobTitle: input.jobTitle ?? weakIdentity.jobTitle,
              professionalRelevance:
                input.professionalRelevance ??
                weakIdentity.professionalRelevance,
            })
            .where(eq(contacts.id, weakIdentity.id))
            .returning();
          if (!enriched) throw new Error("Contact enrichment returned no row");
          return {
            ok: true,
            disposition: "existing",
            contact: enriched,
          } as const;
        }
      }

      const [created] = await tx
        .insert(contacts)
        .values(input)
        .onConflictDoNothing()
        .returning();
      if (created) {
        return { ok: true, disposition: "created", contact: created } as const;
      }

      const [raced] = await tx
        .select()
        .from(contacts)
        .where(predicate)
        .limit(1);
      if (!raced) {
        throw new Error("Contact conflict could not be reconciled");
      }
      return { ok: true, disposition: "existing", contact: raced } as const;
    });
  } catch {
    return {
      ok: false,
      code: "DATABASE_ERROR",
      message: "Could not save contact",
    };
  }
}

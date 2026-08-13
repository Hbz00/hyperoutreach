import { describe, expect, it } from "vitest";

import { mailboxProvider } from "@/lib/db/schema";
import type { MailProviderKind } from "@/modules/mailboxes/mail-provider";

describe("provider kind is a single source of truth", () => {
  it("keeps the database enum and the TypeScript union aligned", () => {
    const dbValues = [...mailboxProvider.enumValues].sort();
    const unionValues: MailProviderKind[] = [
      "microsoft_graph",
      "mock",
      "smtp_imap",
    ];
    expect(dbValues).toEqual([...unionValues].sort());
  });
});

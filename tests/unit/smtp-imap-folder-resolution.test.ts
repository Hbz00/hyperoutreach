import { describe, expect, it } from "vitest";

// No `vi.mock("server-only", ...)` here: `imap-client.ts` no longer imports
// that marker (Task 10 fix round 1) since it is reachable from
// `trigger/tasks.ts`'s plain Node worker graph, where `server-only` throws
// unconditionally rather than being a no-op.
import { resolveFolderRoles } from "@/lib/smtp-imap/imap-client";

describe("folder discovery", () => {
  it("prefers special-use flags over folder names", () => {
    const roles = resolveFolderRoles([
      { path: "Brouillons", specialUse: "\\Drafts" },
      { path: "Envoyes", specialUse: "\\Sent" },
      { path: "INBOX", specialUse: undefined },
    ]);
    expect(roles.drafts).toBe("Brouillons");
    expect(roles.sent).toBe("Envoyes");
  });

  it("falls back to conventional names when no flag is advertised", () => {
    const roles = resolveFolderRoles([
      { path: "Drafts", specialUse: undefined },
      { path: "Sent", specialUse: undefined },
      { path: "INBOX", specialUse: undefined },
    ]);
    expect(roles.drafts).toBe("Drafts");
    expect(roles.sent).toBe("Sent");
  });

  it("throws when neither a flag nor a conventional name exists", () => {
    expect(() =>
      resolveFolderRoles([{ path: "INBOX", specialUse: undefined }]),
    ).toThrow("Unable to resolve the Drafts folder");
  });
});

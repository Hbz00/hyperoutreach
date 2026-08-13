import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { registerMailProvider, resolveMailProvider } =
  await import("@/modules/mailboxes/provider-registry");

const smtpMailbox = {
  id: "11111111-1111-1111-1111-111111111111",
  provider: "smtp_imap" as const,
  status: "available" as const,
};

registerMailProvider("smtp_imap", () => ({
  kind: "smtp_imap" as const,
  createDraft: () => {
    throw new Error("not implemented in test");
  },
  sendDraft: () => {
    throw new Error("not implemented in test");
  },
  reconcile: () => {
    throw new Error("not implemented in test");
  },
}));

describe("mail provider registry", () => {
  it("resolves an smtp_imap mailbox without any Microsoft configuration", async () => {
    const provider = await resolveMailProvider({} as never, smtpMailbox, {
      microsoftConfig: undefined,
    });
    expect(provider.kind).toBe("smtp_imap");
  });

  it("fails loudly for an unregistered provider kind", async () => {
    await expect(
      resolveMailProvider(
        {} as never,
        { ...smtpMailbox, provider: "unknown" as never },
        {},
      ),
    ).rejects.toThrow("Unsupported mail provider");
  });
});

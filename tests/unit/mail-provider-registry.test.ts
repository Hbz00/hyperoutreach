import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { lazyMailProvider, registerMailProvider, resolveMailProvider } =
  await import("@/modules/mailboxes/provider-registry");

import type { MailProvider } from "@/modules/mailboxes/mail-provider";

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
  it("reloads current credentials between operations on the same lazy provider", async () => {
    let currentPassword = "before-rotation";
    const sentWith: string[] = [];
    const provider = lazyMailProvider("smtp_imap", async () => {
      const password = currentPassword;
      return {
        kind: "smtp_imap",
        createDraft: async () => ({ draftId: "draft" }),
        sendDraft: async () => {
          sentWith.push(password);
          return { status: "accepted" };
        },
        reconcile: async () => null,
      } satisfies MailProvider;
    });
    await provider.createDraft({
      outreachId: "rotation",
      mailboxId: smtpMailbox.id,
      sender: null,
      recipient: "prospect@example.test",
      subject: "Fixture",
      body: "Fixture",
      headers: {},
    });
    currentPassword = "after-rotation";
    await provider.sendDraft({
      outreachId: "rotation",
      mailboxId: smtpMailbox.id,
      draftId: "draft",
    });
    expect(sentWith).toEqual(["after-rotation"]);
  });

  it("shares only an in-flight provider load between concurrent operations", async () => {
    let loads = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const provider = lazyMailProvider("smtp_imap", async () => {
      loads += 1;
      await gate;
      return {
        kind: "smtp_imap",
        createDraft: async () => ({ draftId: "draft" }),
        sendDraft: async () => ({ status: "accepted" }),
        reconcile: async () => null,
      } satisfies MailProvider;
    });
    const input = {
      outreachId: "rotation",
      mailboxId: smtpMailbox.id,
      draftId: "draft",
    };
    const first = provider.reconcile(input);
    const second = provider.reconcile(input);
    try {
      expect(loads).toBe(1);
    } finally {
      release();
      await Promise.all([first, second]);
    }
    await provider.reconcile(input);
    expect(loads).toBe(2);
  });

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

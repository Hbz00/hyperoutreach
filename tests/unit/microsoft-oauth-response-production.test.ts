import { afterEach, describe, expect, it, vi } from "vitest";

import type { AppDatabase } from "@/lib/db/types";
import type { MicrosoftConfig } from "@/lib/microsoft/config";
import { completeMicrosoftConnection } from "@/modules/mailboxes/microsoft-oauth-service";

const config: MicrosoftConfig = {
  clientId: "synthetic-client",
  clientSecret: "synthetic-secret",
  tenantId: "organizations",
  redirectUri: "https://app.example/callback",
  webhookClientState: "synthetic-webhook-client-state-1234567890",
  keyring: { activeKeyId: "test", keys: { test: Buffer.alloc(32) } },
  authorizeEndpoint:
    "https://login.microsoftonline.com/organizations/oauth2/v2.0/authorize",
  tokenEndpoint:
    "https://login.microsoftonline.com/organizations/oauth2/v2.0/token",
};
const token = {
  access_token: "synthetic-access",
  refresh_token: "synthetic-refresh",
  expires_in: 3600,
  scope: "Mail.ReadWrite Mail.Send",
};
const profile = {
  id: "synthetic-user",
  mail: "person@example.test",
  userPrincipalName: "person@example.test",
};
const input = { code: "synthetic-code", codeVerifier: "a".repeat(43) };

function streamed(value: unknown, status = 200) {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let offset = 0;
  const cancel = vi.fn();
  const response = new Response(
    new ReadableStream({
      pull(controller) {
        if (offset === bytes.length) return controller.close();
        const next = Math.min(bytes.length, offset + 4096);
        controller.enqueue(bytes.slice(offset, next));
        offset = next;
      },
      cancel,
    }),
    { status, headers: { "content-length": "1" } },
  );
  return { response, cancel };
}

afterEach(() => vi.restoreAllMocks());

describe("OAuth response resource and redirect boundaries", () => {
  it.each(["token", "profile", "error"])(
    "cancels oversized %s JSON before database access",
    async (kind) => {
      const transaction = vi.fn(async () => ({ ok: true }));
      const large = streamed(
        kind === "token"
          ? { ...token, padding: "x".repeat(2 * 1024 * 1024) }
          : kind === "profile"
            ? { ...profile, padding: "x".repeat(2 * 1024 * 1024) }
            : { error: "invalid_grant", padding: "x".repeat(128 * 1024) },
        kind === "error" ? 400 : 200,
      );
      const calls: string[] = [];
      const result = await completeMicrosoftConnection(
        { transaction } as unknown as AppDatabase,
        config,
        input,
        {
          fetcher: async (url) => {
            calls.push(String(url));
            return kind === "profile" && calls.length === 1
              ? Response.json(token)
              : large.response;
          },
        },
      );
      expect(result.ok).toBe(false);
      expect(large.cancel).toHaveBeenCalledTimes(1);
      expect(transaction).not.toHaveBeenCalled();
      expect(calls).toHaveLength(kind === "profile" ? 2 : 1);
      expect(JSON.stringify(result)).not.toContain("synthetic-secret");
    },
  );

  it("rejects redirect following at both credential-bearing requests", async () => {
    const transaction = vi.fn(async () => ({ ok: true }));
    const observed: RequestInit[] = [];
    await completeMicrosoftConnection(
      { transaction } as unknown as AppDatabase,
      config,
      input,
      {
        fetcher: async (_url, init) => {
          observed.push(init!);
          return Response.json(observed.length === 1 ? token : profile);
        },
      },
    );
    expect(observed).toHaveLength(2);
    expect(observed.map((init) => init.redirect)).toEqual(["error", "error"]);
    expect(transaction).toHaveBeenCalledTimes(1);
  });

  it.each(["token", "profile"])(
    "times out a stalled %s body after headers arrive",
    async (kind) => {
      const transaction = vi.fn();
      const cancel = vi.fn();
      let bodyController!: ReadableStreamDefaultController<Uint8Array>;
      const stalled = new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            bodyController = controller;
          },
          cancel,
        }),
      );
      let calls = 0;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const operation = completeMicrosoftConnection(
        { transaction } as unknown as AppDatabase,
        config,
        input,
        {
          requestTimeoutMs: 20,
          fetcher: async () =>
            kind === "profile" && calls++ === 0
              ? Response.json(token)
              : stalled,
        },
      );
      try {
        const result = await Promise.race([
          operation,
          new Promise<"still pending">((resolve) => {
            timer = setTimeout(() => resolve("still pending"), 250);
          }),
        ]);
        expect(result).not.toBe("still pending");
        expect(result).toMatchObject({ ok: false });
        expect(cancel).toHaveBeenCalledTimes(1);
        expect(transaction).not.toHaveBeenCalled();
      } finally {
        clearTimeout(timer);
        if (cancel.mock.calls.length === 0) bodyController.close();
        await operation;
      }
    },
  );
});

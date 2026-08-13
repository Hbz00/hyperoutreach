import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  decryptSecret,
  encryptSecret,
  type EncryptionKeyring,
} from "@/lib/microsoft/token-crypto";
import {
  MICROSOFT_DELEGATED_SCOPES,
  buildMicrosoftAuthorizationRequest,
  requireMicrosoftConfig,
} from "@/lib/microsoft/config";
import {
  GraphApiError,
  MicrosoftGraphClient,
} from "@/lib/microsoft/graph-client";
import { MicrosoftGraphMailProvider } from "@/modules/mailboxes/microsoft-graph-mail-provider";
import { graphMessageToInbound } from "@/modules/mailboxes/microsoft-graph-message";
import { createMicrosoftGraphInboundSource } from "@/modules/mailboxes/microsoft-graph-inbound-source";
import {
  parseGraphNotifications,
  validateWebhookClientState,
} from "@/modules/mailboxes/microsoft-graph-webhook";
import { authorizeOperatorRequest } from "@/lib/operator-auth";

const keyring: EncryptionKeyring = {
  activeKeyId: "current",
  keys: {
    current: Buffer.alloc(32, 7),
    previous: Buffer.alloc(32, 3),
  },
};

describe("Microsoft token encryption", () => {
  it("round-trips AES-GCM envelopes and identifies the key used", () => {
    const encrypted = encryptSecret("refresh-secret", keyring);
    expect(encrypted).not.toContain("refresh-secret");
    expect(decryptSecret(encrypted, keyring)).toEqual({
      plaintext: "refresh-secret",
      keyId: "current",
      needsRotation: false,
    });
  });

  it("decrypts an old-key envelope and marks it for rotation", () => {
    const old = encryptSecret("refresh-secret", {
      activeKeyId: "previous",
      keys: keyring.keys,
    });
    expect(decryptSecret(old, keyring)).toMatchObject({
      plaintext: "refresh-secret",
      keyId: "previous",
      needsRotation: true,
    });
  });

  it("rejects a tampered envelope without exposing plaintext", () => {
    const encrypted = encryptSecret("refresh-secret", keyring);
    const parts = encrypted.split(".");
    parts[3] = `${parts[3]!.startsWith("A") ? "B" : "A"}${parts[3]!.slice(1)}`;
    expect(() => decryptSecret(parts.join("."), keyring)).toThrow(
      "Encrypted secret could not be authenticated",
    );
  });
});

describe("Microsoft OAuth configuration", () => {
  it("protects OAuth initiation with the configured operator bearer token", () => {
    const token = "o".repeat(32);
    expect(
      authorizeOperatorRequest(
        new Request(
          "https://app.example/api/integrations/microsoft/authorize",
          {
            headers: { authorization: `Bearer ${token}` },
          },
        ),
        { OPERATOR_API_TOKEN: token },
      ),
    ).toBe("authorized");
    expect(
      authorizeOperatorRequest(
        new Request("https://app.example/api/integrations/microsoft/authorize"),
        { OPERATOR_API_TOKEN: token },
      ),
    ).toBe("unauthorized");
  });

  it("uses delegated least-privilege mail scopes with offline access", () => {
    expect(MICROSOFT_DELEGATED_SCOPES).toEqual([
      "openid",
      "profile",
      "email",
      "offline_access",
      "Mail.ReadWrite",
      "Mail.Send",
    ]);
    expect(MICROSOFT_DELEGATED_SCOPES).not.toContain("Mail.Read");
  });

  it("builds a PKCE S256 authorization request with state", () => {
    const config = requireMicrosoftConfig({
      MICROSOFT_CLIENT_ID: "client-id",
      MICROSOFT_CLIENT_SECRET: "client-secret",
      MICROSOFT_TENANT_ID: "organizations",
      MICROSOFT_REDIRECT_URI:
        "https://app.example/api/integrations/microsoft/callback",
      MICROSOFT_GRAPH_WEBHOOK_CLIENT_STATE: "x".repeat(32),
      TOKEN_ENCRYPTION_KEYS: `current:${Buffer.alloc(32, 7).toString("base64")}`,
      TOKEN_ENCRYPTION_ACTIVE_KEY_ID: "current",
    });
    const request = buildMicrosoftAuthorizationRequest(config, {
      state: "state-value",
      codeVerifier: "v".repeat(64),
    });
    const url = new URL(request.authorizationUrl);
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("response_mode")).toBe("query");
    expect(url.searchParams.get("state")).toBe("state-value");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toBe(
      createHash("sha256").update("v".repeat(64)).digest("base64url"),
    );
  });
});

describe("Microsoft Graph HTTP and mail contracts", () => {
  it("creates an immutable draft with X-Outreach-ID then treats 202 as acceptance", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetcher: typeof fetch = async (input, init = {}) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.endsWith("/me/messages")) {
        return Response.json(
          {
            id: "immutable-draft",
            internetMessageId: "<draft@example.com>",
            conversationId: "conversation",
            isDraft: true,
          },
          { status: 201 },
        );
      }
      return new Response(null, { status: 202 });
    };
    const client = new MicrosoftGraphClient({
      accessToken: async () => "access-secret",
      fetcher,
    });
    const provider = new MicrosoftGraphMailProvider(client, "mailbox-id");
    const draft = await provider.createDraft({
      outreachId: "outreach-123",
      mailboxId: "mailbox-id",
      sender: "operator@example.com",
      recipient: "prospect@example.org",
      subject: "Hello",
      body: "Body",
      headers: {},
    });
    expect(draft).toMatchObject({ draftId: "immutable-draft" });
    await expect(
      provider.sendDraft({
        draftId: draft.draftId,
        outreachId: "outreach-123",
        mailboxId: "mailbox-id",
      }),
    ).resolves.toEqual({ status: "accepted" });
    expect(calls[0]!.init.headers).toMatchObject({
      Authorization: "Bearer access-secret",
      Prefer: 'IdType="ImmutableId"',
    });
    const body = JSON.parse(String(calls[0]!.init.body)) as {
      internetMessageHeaders: Array<{ name: string; value: string }>;
    };
    expect(body.internetMessageHeaders).toContainEqual({
      name: "X-Outreach-ID",
      value: "outreach-123",
    });
    expect(calls[1]!.url).toContain("immutable-draft/send");
  });

  it("classifies 410 syncStateNotFound without leaking response bodies", async () => {
    const client = new MicrosoftGraphClient({
      accessToken: async () => "access-secret",
      fetcher: async () =>
        Response.json(
          { error: { code: "syncStateNotFound", message: "opaque detail" } },
          { status: 410 },
        ),
    });
    await expect(
      client.get("https://graph.microsoft.com/v1.0/delta"),
    ).rejects.toMatchObject({
      name: "GraphApiError",
      status: 410,
      code: "syncStateNotFound",
      message: "Microsoft Graph request failed",
    } satisfies Partial<GraphApiError>);
  });

  it("bounds Graph requests with an abortable timeout", async () => {
    const client = new MicrosoftGraphClient({
      accessToken: async () => "access-secret",
      requestTimeoutMs: 10,
      fetcher: async (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(init.signal?.reason),
            { once: true },
          );
        }),
    });
    await expect(client.get("/me")).rejects.toThrow();
  });

  it("never sends a Graph bearer token to an untrusted continuation URL", async () => {
    let called = false;
    const client = new MicrosoftGraphClient({
      accessToken: async () => "access-secret",
      fetcher: async () => {
        called = true;
        return Response.json({});
      },
    });
    await expect(client.get("https://attacker.example/delta")).rejects.toThrow(
      "Microsoft Graph URL is not trusted",
    );
    expect(called).toBe(false);
  });
});

describe("Graph inbound and webhook validation", () => {
  it("skips one malformed delta item and still advances the page cursor", async () => {
    const graph = {
      get: async () => ({
        value: [
          { id: "poison", subject: 42 },
          {
            id: "valid",
            internetMessageId: "<valid@example.com>",
            conversationId: "conversation-1",
            subject: "Re: hello",
            receivedDateTime: "2026-08-13T10:00:00.000Z",
            from: { emailAddress: { address: "prospect@example.com" } },
            toRecipients: [
              { emailAddress: { address: "mailbox@example.com" } },
            ],
            body: { contentType: "text", content: "Interested" },
            internetMessageHeaders: [],
          },
        ],
        "@odata.deltaLink": "https://graph.microsoft.com/v1.0/delta-final",
      }),
    };
    const source = createMicrosoftGraphInboundSource(graph as never, {
      id: "mailbox-id",
      since: new Date("2026-08-13T09:00:00.000Z"),
    });
    const pages: unknown[][] = [];
    const result = await source.fetchSince(null, async (messages) => {
      pages.push(messages);
      return messages.length;
    });
    expect(pages.flat()).toHaveLength(1);
    expect(result.nextCursor).toBe(
      "https://graph.microsoft.com/v1.0/delta-final",
    );
  });

  it("converts Graph headers and mailbox identity into the shared inbound contract", () => {
    expect(
      graphMessageToInbound("mailbox-id", "notification-key", {
        id: "graph-message",
        internetMessageId: "<reply@example.org>",
        conversationId: "conversation",
        subject: "Re: Hello",
        receivedDateTime: "2026-08-12T10:00:00.000Z",
        from: { emailAddress: { address: "Prospect@Example.org" } },
        toRecipients: [{ emailAddress: { address: "operator@example.com" } }],
        body: { contentType: "text", content: "Interested" },
        internetMessageHeaders: [
          { name: "In-Reply-To", value: "<outbound@example.com>" },
          {
            name: "References",
            value: "<older@example.com> <outbound@example.com>",
          },
          { name: "X-Outreach-ID", value: "outreach-123" },
        ],
      }),
    ).toMatchObject({
      mailboxId: "mailbox-id",
      providerMessageId: "graph-message",
      providerNotificationId: "notification-key",
      sender: "Prospect@Example.org",
      recipient: "operator@example.com",
      inReplyTo: "<outbound@example.com>",
      references: ["<older@example.com>", "<outbound@example.com>"],
      outreachId: "outreach-123",
      body: "Interested",
    });
  });

  it("converts an evidenced Graph delivery failure into the shared bounce signal", () => {
    expect(
      graphMessageToInbound("mailbox-id", undefined, {
        id: "graph-bounce",
        subject: "Undeliverable",
        receivedDateTime: "2026-08-12T10:00:00.000Z",
        from: { emailAddress: { address: "postmaster@example.com" } },
        toRecipients: [{ emailAddress: { address: "operator@example.com" } }],
        body: { contentType: "text", content: "Delivery failed" },
        internetMessageHeaders: [
          {
            name: "X-Failed-Recipients",
            value: "prospect@example.org",
          },
          { name: "Status", value: "5.1.1" },
        ],
      }),
    ).toMatchObject({
      bounceKind: "hard",
      bouncedRecipient: "prospect@example.org",
    });
  });

  it("does not turn an unclassified delivery failure into hard suppression", () => {
    expect(
      graphMessageToInbound("mailbox-id", undefined, {
        id: "graph-unknown-bounce",
        subject: "Delivery delayed",
        receivedDateTime: "2026-08-12T10:00:00.000Z",
        from: { emailAddress: { address: "postmaster@example.com" } },
        toRecipients: [{ emailAddress: { address: "operator@example.com" } }],
        body: { contentType: "text", content: "No diagnostic status" },
        internetMessageHeaders: [
          { name: "X-Failed-Recipients", value: "prospect@example.org" },
        ],
      }),
    ).toMatchObject({
      bounceKind: undefined,
      bouncedRecipient: undefined,
      metadata: { unclassifiedFailedRecipient: "prospect@example.org" },
    });
  });

  it("deterministically truncates oversized Graph content for durable ingestion", () => {
    const inbound = graphMessageToInbound("mailbox-id", undefined, {
      id: "graph-large-message",
      subject: "s".repeat(10_100),
      receivedDateTime: "2026-08-12T10:00:00.000Z",
      from: { emailAddress: { address: "prospect@example.org" } },
      toRecipients: [{ emailAddress: { address: "operator@example.com" } }],
      body: { contentType: "text", content: "x".repeat(1_000_100) },
      internetMessageHeaders: [],
    });
    expect(inbound.subject).toHaveLength(10_000);
    expect(inbound.body).toHaveLength(1_000_000);
    expect(inbound.metadata).toMatchObject({ graphBodyTruncated: true });
  });

  it("rejects invalid notification shapes and mismatched clientState", () => {
    const parsed = parseGraphNotifications({
      value: [
        {
          subscriptionId: "subscription-id",
          changeType: "created",
          resource: "me/mailFolders('Inbox')/messages('message-id')",
          clientState: "expected-secret",
          resourceData: { id: "message-id" },
        },
      ],
    });
    expect(parsed).toHaveLength(1);
    expect(
      validateWebhookClientState(parsed[0]!.clientState, "expected-secret"),
    ).toBe(true);
    expect(
      validateWebhookClientState(parsed[0]!.clientState, "different-secret"),
    ).toBe(false);
    expect(() =>
      parseGraphNotifications({ value: [{ changeType: "x" }] }),
    ).toThrow();
  });
});

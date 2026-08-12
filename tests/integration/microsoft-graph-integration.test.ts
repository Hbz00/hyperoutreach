import { randomBytes } from "node:crypto";

import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as schema from "@/lib/db/schema";
import { resolveDatabaseUrls } from "@/lib/db/test-database";
import type { MicrosoftConfig } from "@/lib/microsoft/config";
import { MicrosoftGraphClient } from "@/lib/microsoft/graph-client";
import { encryptSecret } from "@/lib/microsoft/token-crypto";
import {
  beginMicrosoftAuthorization,
  completeMicrosoftConnection,
  consumeMicrosoftAuthorizationState,
  disconnectMicrosoftMailbox,
  getMicrosoftAccessToken,
} from "@/modules/mailboxes/microsoft-oauth-service";
import {
  processGraphWebhook,
  reconcileGraphDelta,
  reconcilePendingGraphLifecycleEvents,
  reconcilePendingGraphNotifications,
  runMicrosoftGraphMaintenance,
  stageGraphWebhook,
} from "@/modules/mailboxes/microsoft-graph-sync-service";
import {
  deleteGraphSubscription,
  ensureGraphSubscription,
  renewDueGraphSubscriptions,
} from "@/modules/mailboxes/microsoft-graph-subscription-service";
import { DeterministicReplyClassifier } from "@/modules/replies/reply-classifier";

const { testUrl } = resolveDatabaseUrls(process.env);
const client = postgres(testUrl, { max: 6 });
const db = drizzle(client, { schema });
const keyring = {
  activeKeyId: "current",
  keys: { current: randomBytes(32) },
};
const config: MicrosoftConfig = {
  clientId: "client-id",
  clientSecret: "client-secret",
  tenantId: "organizations",
  redirectUri: "https://app.example/api/integrations/microsoft/callback",
  webhookClientState: "graph-client-state-secret-1234567890",
  keyring,
  authorizeEndpoint:
    "https://login.microsoftonline.com/organizations/oauth2/v2.0/authorize",
  tokenEndpoint:
    "https://login.microsoftonline.com/organizations/oauth2/v2.0/token",
};

async function insertMailbox(
  overrides: Partial<typeof schema.mailboxConnections.$inferInsert> = {},
) {
  const [mailbox] = await db
    .insert(schema.mailboxConnections)
    .values({
      provider: "microsoft_graph",
      email: `operator-${crypto.randomUUID()}@example.com`,
      normalizedEmail: `operator-${crypto.randomUUID()}@example.com`,
      status: "available",
      encryptedRefreshToken: encryptSecret("refresh-old", keyring),
      tokenExpiresAt: new Date("2026-08-12T09:00:00.000Z"),
      lastSyncedAt: new Date("2026-08-12T08:55:00.000Z"),
      grantedScopes: [...schema.MICROSOFT_REQUIRED_SCOPES],
      ...overrides,
    })
    .returning();
  if (!mailbox) throw new Error("mailbox fixture missing");
  return mailbox;
}

describe("Microsoft Graph OAuth persistence and recovery", () => {
  beforeAll(async () => {
    await client.unsafe("drop schema if exists public cascade");
    await client.unsafe("drop schema if exists drizzle cascade");
    await client.unsafe("create schema public");
    await migrate(drizzle(client), { migrationsFolder: "drizzle" });
  });

  afterAll(async () => {
    await client.end();
  });

  it("completes OAuth with encrypted refresh token and idempotent mailbox identity", async () => {
    let calls = 0;
    const fetcher: typeof fetch = async (input) => {
      calls += 1;
      if (String(input).includes("/token")) {
        return Response.json({
          access_token: "access-secret",
          refresh_token: "refresh-secret",
          expires_in: 3600,
          scope: "Mail.ReadWrite Mail.Send offline_access openid profile email",
        });
      }
      return Response.json({
        id: "provider-user-id",
        mail: "operator@example.com",
        userPrincipalName: "operator@example.com",
      });
    };
    const first = await completeMicrosoftConnection(
      db,
      config,
      {
        code: "authorization-code",
        codeVerifier: "v".repeat(64),
      },
      {
        fetcher,
        now: new Date("2026-08-12T10:00:00.000Z"),
      },
    );
    const second = await completeMicrosoftConnection(
      db,
      config,
      {
        code: "authorization-code-2",
        codeVerifier: "w".repeat(64),
      },
      {
        fetcher,
        now: new Date("2026-08-12T10:01:00.000Z"),
      },
    );
    expect(calls).toBe(4);
    expect({ first, second }).toMatchObject({
      first: { ok: true },
      second: { ok: true },
    });
    if (!first.ok || !second.ok) return;
    expect(second.mailbox.id).toBe(first.mailbox.id);
    expect(second.mailbox.encryptedRefreshToken).not.toContain(
      "refresh-secret",
    );
    expect(second.mailbox.status).toBe("available");
  });

  it("creates the initial subscription through the production maintenance flow", async () => {
    const [mailbox] = await db
      .select()
      .from(schema.mailboxConnections)
      .where(
        eq(schema.mailboxConnections.normalizedEmail, "operator@example.com"),
      );
    if (!mailbox) throw new Error("connected mailbox fixture missing");
    const graph = new MicrosoftGraphClient({
      accessToken: async () => "access",
      fetcher: async (input, init = {}) => {
        const url = String(input);
        if (
          url.endsWith("/subscriptions") &&
          (init.method ?? "GET") === "GET"
        ) {
          return Response.json({ value: [] });
        }
        if (url.endsWith("/subscriptions") && init.method === "POST") {
          return Response.json({
            id: "initial-subscription",
            expirationDateTime: "2026-08-18T10:00:00.000Z",
          });
        }
        return Response.json({
          value: [],
          "@odata.deltaLink": "https://graph.microsoft.com/v1.0/initial-delta",
        });
      },
    });
    await expect(
      runMicrosoftGraphMaintenance(
        db,
        () => graph,
        new DeterministicReplyClassifier(),
        config,
        {
          notificationUrl: "https://app.example/api/webhooks/microsoft",
          now: new Date("2026-08-12T10:02:00.000Z"),
        },
      ),
    ).resolves.toMatchObject({
      subscriptionsEnsured: 1,
      subscriptionsFailed: 0,
      deltaSynced: 1,
    });
    const [stored] = await db
      .select()
      .from(schema.mailboxConnections)
      .where(eq(schema.mailboxConnections.id, mailbox.id));
    expect(stored).toMatchObject({
      subscriptionId: "initial-subscription",
      deltaLink: "https://graph.microsoft.com/v1.0/initial-delta",
    });
  });

  it("preserves an existing delta cursor and safe anchor when reconnecting", async () => {
    const anchor = new Date("2026-08-01T10:00:00.000Z");
    const mailbox = await insertMailbox({
      email: "reconnect@example.com",
      normalizedEmail: "reconnect@example.com",
      deltaLink: "https://graph.microsoft.com/v1.0/existing-cursor",
      lastSyncedAt: anchor,
      status: "revoked",
    });
    const fetcher: typeof fetch = async (input) =>
      String(input).includes("/token")
        ? Response.json({
            access_token: "access-secret",
            refresh_token: "refresh-secret",
            expires_in: 3600,
            scope: "Mail.ReadWrite Mail.Send",
          })
        : Response.json({
            id: mailbox.providerUserId ?? "reconnect-provider-id",
            mail: "reconnect@example.com",
            userPrincipalName: "reconnect@example.com",
          });
    await expect(
      completeMicrosoftConnection(
        db,
        config,
        { code: "reconnect-code", codeVerifier: "v".repeat(64) },
        { fetcher, now: new Date("2026-08-12T10:00:00.000Z") },
      ),
    ).resolves.toMatchObject({ ok: true });
    const [stored] = await db
      .select()
      .from(schema.mailboxConnections)
      .where(eq(schema.mailboxConnections.id, mailbox.id));
    expect(stored).toMatchObject({
      deltaLink: "https://graph.microsoft.com/v1.0/existing-cursor",
      lastSyncedAt: anchor,
    });
  });

  it("rejects email reuse by a different Graph identity", async () => {
    await insertMailbox({
      email: "reused@example.com",
      normalizedEmail: "reused@example.com",
      providerUserId: "original-identity",
    });
    const fetcher: typeof fetch = async (input) =>
      String(input).includes("/token")
        ? Response.json({
            access_token: "access-secret",
            refresh_token: "refresh-secret",
            expires_in: 3600,
            scope: "Mail.ReadWrite Mail.Send",
          })
        : Response.json({
            id: "different-identity",
            mail: "reused@example.com",
            userPrincipalName: "reused@example.com",
          });
    await expect(
      completeMicrosoftConnection(
        db,
        config,
        { code: "reused-code", codeVerifier: "v".repeat(64) },
        { fetcher },
      ),
    ).resolves.toMatchObject({ ok: false, code: "IDENTITY_CONFLICT" });
  });

  it("updates email on the same stable Graph identity without duplicating it", async () => {
    const mailbox = await insertMailbox({
      email: "old-address@example.com",
      normalizedEmail: "old-address@example.com",
      providerUserId: "stable-identity",
    });
    const fetcher: typeof fetch = async (input) =>
      String(input).includes("/token")
        ? Response.json({
            access_token: "access-secret",
            refresh_token: "refresh-secret",
            expires_in: 3600,
            scope: "Mail.ReadWrite Mail.Send",
          })
        : Response.json({
            id: "stable-identity",
            mail: "new-address@example.com",
            userPrincipalName: "new-address@example.com",
          });
    const result = await completeMicrosoftConnection(
      db,
      config,
      { code: "renamed-code", codeVerifier: "v".repeat(64) },
      { fetcher },
    );
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    expect(result.mailbox).toMatchObject({
      id: mailbox.id,
      normalizedEmail: "new-address@example.com",
      providerUserId: "stable-identity",
    });
  });

  it("stores PKCE verifier encrypted and consumes OAuth state exactly once", async () => {
    const begun = await beginMicrosoftAuthorization(db, config, {
      now: new Date("2026-08-12T10:00:00.000Z"),
      operatorBinding: "a".repeat(32),
    });
    const [stored] = await db
      .select()
      .from(schema.oauthAuthorizationRequests)
      .where(eq(schema.oauthAuthorizationRequests.provider, "microsoft_graph"));
    expect(stored?.stateHash).not.toBe(begun.state);
    expect(stored?.encryptedCodeVerifier).toMatch(/^v1\./);
    const first = await consumeMicrosoftAuthorizationState(
      db,
      config,
      { state: begun.state, operatorBinding: "a".repeat(32) },
      new Date("2026-08-12T10:01:00.000Z"),
    );
    expect(first).toMatchObject({ ok: true });
    await expect(
      consumeMicrosoftAuthorizationState(
        db,
        config,
        { state: begun.state, operatorBinding: "a".repeat(32) },
        new Date("2026-08-12T10:01:01.000Z"),
      ),
    ).resolves.toMatchObject({ ok: false, code: "INVALID_STATE" });
  });

  it("rejects an OAuth callback not bound to the initiating operator session", async () => {
    const begun = await beginMicrosoftAuthorization(db, config, {
      operatorBinding: "a".repeat(32),
    });
    await expect(
      consumeMicrosoftAuthorizationState(db, config, {
        state: begun.state,
        operatorBinding: "b".repeat(32),
      }),
    ).resolves.toMatchObject({ ok: false, code: "INVALID_STATE" });
  });

  it("serializes refresh rotation so concurrent callers use one refresh response", async () => {
    const mailbox = await insertMailbox({
      email: "refresh@example.com",
      normalizedEmail: "refresh@example.com",
    });
    let refreshCalls = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const fetcher: typeof fetch = async () => {
      refreshCalls += 1;
      await gate;
      return Response.json({
        access_token: "access-new",
        refresh_token: "refresh-new",
        expires_in: 3600,
        scope: "Mail.ReadWrite Mail.Send offline_access openid profile email",
      });
    };
    const first = getMicrosoftAccessToken(db, config, mailbox.id, {
      fetcher,
      now: new Date("2026-08-12T10:00:00.000Z"),
    });
    const second = getMicrosoftAccessToken(db, config, mailbox.id, {
      fetcher,
      now: new Date("2026-08-12T10:00:00.000Z"),
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    release();
    await expect(Promise.all([first, second])).resolves.toEqual([
      "access-new",
      "access-new",
    ]);
    expect(refreshCalls).toBe(1);
    const [stored] = await db
      .select()
      .from(schema.mailboxConnections)
      .where(eq(schema.mailboxConnections.id, mailbox.id));
    expect(stored?.encryptedRefreshToken).not.toBe(
      mailbox.encryptedRefreshToken,
    );
  });

  it("does not revoke a mailbox on a transient token endpoint failure", async () => {
    const mailbox = await insertMailbox();
    await expect(
      getMicrosoftAccessToken(db, config, mailbox.id, {
        fetcher: async () =>
          Response.json({ error: "temporarily_unavailable" }, { status: 429 }),
        now: new Date("2026-08-12T10:00:00.000Z"),
      }),
    ).rejects.toThrow("Microsoft token exchange failed");
    const [stored] = await db
      .select()
      .from(schema.mailboxConnections)
      .where(eq(schema.mailboxConnections.id, mailbox.id));
    expect(stored?.status).toBe("available");
  });

  it("retains persisted grants when a refresh response omits optional scope", async () => {
    const mailbox = await insertMailbox();
    await expect(
      getMicrosoftAccessToken(db, config, mailbox.id, {
        fetcher: async () =>
          Response.json({
            access_token: "access-without-scope",
            refresh_token: "refresh-without-scope",
            expires_in: 3600,
          }),
        now: new Date("2026-08-12T10:00:00.000Z"),
      }),
    ).resolves.toBe("access-without-scope");
    const [stored] = await db
      .select()
      .from(schema.mailboxConnections)
      .where(eq(schema.mailboxConnections.id, mailbox.id));
    expect(stored?.grantedScopes).toEqual([
      ...schema.MICROSOFT_REQUIRED_SCOPES,
    ]);
  });

  it("marks the mailbox revoked when Microsoft rejects the refresh grant", async () => {
    const mailbox = await insertMailbox();
    await expect(
      getMicrosoftAccessToken(db, config, mailbox.id, {
        fetcher: async () =>
          Response.json({ error: "invalid_grant" }, { status: 400 }),
        now: new Date("2026-08-12T10:00:00.000Z"),
      }),
    ).rejects.toThrow("Microsoft token exchange failed");
    const [stored] = await db
      .select()
      .from(schema.mailboxConnections)
      .where(eq(schema.mailboxConnections.id, mailbox.id));
    expect(stored).toMatchObject({
      status: "revoked",
      accessTokenCiphertext: null,
      tokenExpiresAt: null,
    });
  });

  it("bounds a stalled token refresh and leaves the mailbox reconnectable", async () => {
    const mailbox = await insertMailbox();
    await expect(
      getMicrosoftAccessToken(db, config, mailbox.id, {
        requestTimeoutMs: 10,
        fetcher: async (_input, init) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener(
              "abort",
              () => reject(init.signal?.reason),
              { once: true },
            );
          }),
        now: new Date("2026-08-12T10:00:00.000Z"),
      }),
    ).rejects.toThrow();
    const [stored] = await db
      .select()
      .from(schema.mailboxConnections)
      .where(eq(schema.mailboxConnections.id, mailbox.id));
    expect(stored?.status).toBe("available");
  });

  it("disconnects locally even when subscription deletion fails", async () => {
    const mailbox = await insertMailbox({
      subscriptionId: "subscription-to-delete",
    });
    const result = await disconnectMicrosoftMailbox(db, mailbox.id, {
      deleteSubscription: async () => {
        throw new Error("network secret must not persist");
      },
    });
    expect(result).toMatchObject({ ok: true, remoteDeleteFailed: true });
    const [stored] = await db
      .select()
      .from(schema.mailboxConnections)
      .where(eq(schema.mailboxConnections.id, mailbox.id));
    expect(stored).toMatchObject({
      status: "disconnected",
      encryptedRefreshToken: null,
      subscriptionId: null,
      deltaLink: null,
    });
  });

  it("creates, renews, and deletes immutable-ID subscriptions", async () => {
    const mailbox = await insertMailbox();
    const calls: Array<{
      method: string;
      url: string;
      body?: unknown;
      prefer?: string;
    }> = [];
    const fetcher: typeof fetch = async (input, init = {}) => {
      const body = init.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({
        method: init.method ?? "GET",
        url: String(input),
        body,
        prefer: new Headers(init.headers).get("prefer") ?? undefined,
      });
      if ((init.method ?? "GET") === "GET") {
        return Response.json({ value: [] });
      }
      if (init.method === "POST") {
        return Response.json(
          {
            id: "subscription-id",
            expirationDateTime: "2026-08-18T10:00:00.000Z",
          },
          { status: 201 },
        );
      }
      if (init.method === "PATCH") {
        return Response.json({
          id: "subscription-id",
          expirationDateTime: "2026-08-18T11:00:00.000Z",
        });
      }
      return new Response(null, { status: 204 });
    };
    const graph = new MicrosoftGraphClient({
      accessToken: async () => "access",
      fetcher,
    });
    await expect(
      ensureGraphSubscription(db, graph, config, mailbox.id, {
        notificationUrl: "https://app.example/api/webhooks/microsoft",
        now: new Date("2026-08-12T10:00:00.000Z"),
      }),
    ).resolves.toMatchObject({ ok: true });
    await expect(
      renewDueGraphSubscriptions(db, () => graph, {
        now: new Date("2026-08-18T09:00:00.000Z"),
        renewBeforeMs: 2 * 60 * 60_000,
      }),
    ).resolves.toMatchObject({ renewed: 2 });
    await expect(
      deleteGraphSubscription(db, graph, mailbox.id),
    ).resolves.toMatchObject({
      ok: true,
    });
    expect(calls.map((call) => call.method)).toEqual([
      "GET",
      "POST",
      "PATCH",
      "PATCH",
      "DELETE",
    ]);
    expect(calls[1]?.prefer).toBe('IdType="ImmutableId"');
    expect(calls[1]?.body).toMatchObject({
      resource: "me/mailFolders('Inbox')/messages",
      clientState: config.webhookClientState,
      changeType: "created,updated",
    });
  });

  it("recovers a remotely-created subscription after local persistence loss", async () => {
    const mailbox = await insertMailbox();
    let createCalls = 0;
    const graph = new MicrosoftGraphClient({
      accessToken: async () => "access",
      fetcher: async (_input, init = {}) => {
        if ((init.method ?? "GET") === "GET") {
          return Response.json({
            value: [
              {
                id: "orphaned-subscription",
                resource: "me/mailFolders('Inbox')/messages",
                notificationUrl: "https://app.example/api/webhooks/microsoft",
                expirationDateTime: "2026-08-18T10:00:00.000Z",
              },
            ],
          });
        }
        createCalls += 1;
        return Response.json({}, { status: 500 });
      },
    });
    await expect(
      ensureGraphSubscription(db, graph, config, mailbox.id, {
        notificationUrl: "https://app.example/api/webhooks/microsoft",
        now: new Date("2026-08-12T10:00:00.000Z"),
      }),
    ).resolves.toMatchObject({ ok: true, disposition: "recovered" });
    expect(createCalls).toBe(0);
    const [stored] = await db
      .select()
      .from(schema.mailboxConnections)
      .where(eq(schema.mailboxConnections.id, mailbox.id));
    expect(stored?.subscriptionId).toBe("orphaned-subscription");
  });

  it("serializes concurrent subscription creation for one mailbox", async () => {
    const mailbox = await insertMailbox();
    let creates = 0;
    const graph = new MicrosoftGraphClient({
      accessToken: async () => "access",
      fetcher: async (_input, init = {}) => {
        if ((init.method ?? "GET") === "GET")
          return Response.json({ value: [] });
        creates += 1;
        return Response.json({
          id: "only-subscription",
          expirationDateTime: "2026-08-18T10:00:00.000Z",
        });
      },
    });
    const options = {
      notificationUrl: "https://app.example/api/webhooks/microsoft",
      now: new Date("2026-08-12T10:00:00.000Z"),
    };
    await expect(
      Promise.all([
        ensureGraphSubscription(db, graph, config, mailbox.id, options),
        ensureGraphSubscription(db, graph, config, mailbox.id, options),
      ]),
    ).resolves.toMatchObject([{ ok: true }, { ok: true }]);
    expect(creates).toBe(1);
  });

  it("deduplicates webhook deliveries and delta pagination recovers missed messages", async () => {
    const subscriptionId = `subscription-${crypto.randomUUID()}`;
    const mailbox = await insertMailbox({ subscriptionId });
    const classifier = new DeterministicReplyClassifier();
    let fetchedMessages = 0;
    const graph = new MicrosoftGraphClient({
      accessToken: async () => "access",
      fetcher: async (input) => {
        const url = String(input);
        if (url.includes("/messages/message-1")) {
          fetchedMessages += 1;
          return Response.json({
            id: "message-1",
            subject: "Hello",
            receivedDateTime: "2026-08-12T10:00:00.000Z",
            from: { emailAddress: { address: "prospect@example.org" } },
            toRecipients: [{ emailAddress: { address: mailbox.email } }],
            body: { contentType: "text", content: "No thanks" },
            internetMessageHeaders: [],
          });
        }
        if (url.endsWith("page-2")) {
          return Response.json({
            value: [],
            "@odata.deltaLink": "https://graph.microsoft.com/v1.0/delta-token",
          });
        }
        return Response.json({
          value: [
            {
              id: "message-2",
              subject: "Hello again",
              receivedDateTime: "2026-08-12T10:01:00.000Z",
              from: { emailAddress: { address: "other@example.org" } },
              toRecipients: [{ emailAddress: { address: mailbox.email } }],
              body: { contentType: "text", content: "unsubscribe" },
              internetMessageHeaders: [],
            },
          ],
          "@odata.nextLink": "https://graph.microsoft.com/v1.0/page-2",
        });
      },
    });
    const payload = {
      value: [
        {
          id: "notification-1",
          subscriptionId,
          changeType: "created",
          resource: "me/mailFolders('Inbox')/messages('message-1')",
          clientState: config.webhookClientState,
          resourceData: { id: "message-1" },
        },
      ],
    };
    await expect(
      processGraphWebhook(db, () => graph, classifier, config, payload),
    ).resolves.toMatchObject({ accepted: 1 });
    await expect(
      processGraphWebhook(db, () => graph, classifier, config, payload),
    ).resolves.toMatchObject({ duplicates: 1 });
    expect(fetchedMessages).toBe(1);
    await expect(
      reconcileGraphDelta(db, graph, classifier, mailbox.id),
    ).resolves.toMatchObject({ processed: 1, rebaselined: false });
    const [stored] = await db
      .select()
      .from(schema.mailboxConnections)
      .where(eq(schema.mailboxConnections.id, mailbox.id));
    expect(stored?.deltaLink).toBe(
      "https://graph.microsoft.com/v1.0/delta-token",
    );
    const inbound = await db
      .select()
      .from(schema.inboundRecords)
      .where(eq(schema.inboundRecords.mailboxId, mailbox.id));
    expect(inbound).toHaveLength(2);
  });

  it("stages a webhook without Graph or classifier work and claims it once", async () => {
    const mailbox = await insertMailbox({
      subscriptionId: "fast-subscription",
    });
    let graphCalls = 0;
    const graph = new MicrosoftGraphClient({
      accessToken: async () => "access",
      fetcher: async () => {
        graphCalls += 1;
        return Response.json({
          id: "fast-message",
          subject: "Hello",
          receivedDateTime: "2026-08-12T10:00:00.000Z",
          from: { emailAddress: { address: "prospect@example.org" } },
          toRecipients: [{ emailAddress: { address: mailbox.email } }],
          body: { contentType: "text", content: "Interested" },
          internetMessageHeaders: [],
        });
      },
    });
    const payload = {
      value: [
        {
          id: "fast-notification",
          subscriptionId: "fast-subscription",
          changeType: "created",
          resource: "messages/fast-message",
          clientState: config.webhookClientState,
          resourceData: { id: "fast-message" },
        },
      ],
    };
    await expect(stageGraphWebhook(db, config, payload)).resolves.toMatchObject(
      { accepted: 1 },
    );
    expect(graphCalls).toBe(0);
    await Promise.all([
      reconcilePendingGraphNotifications(
        db,
        () => graph,
        new DeterministicReplyClassifier(),
        { now: new Date("2026-08-12T10:00:00.000Z") },
      ),
      reconcilePendingGraphNotifications(
        db,
        () => graph,
        new DeterministicReplyClassifier(),
        { now: new Date("2026-08-12T10:01:00.000Z") },
      ),
    ]);
    expect(graphCalls).toBe(1);
  });

  it("releases a failed webhook claim for deterministic retry", async () => {
    const mailbox = await insertMailbox({
      subscriptionId: "retry-subscription",
    });
    await stageGraphWebhook(db, config, {
      value: [
        {
          id: "retry-notification",
          subscriptionId: "retry-subscription",
          changeType: "created",
          resource: "messages/retry-message",
          clientState: config.webhookClientState,
          resourceData: { id: "retry-message" },
        },
      ],
    });
    let calls = 0;
    const graph = new MicrosoftGraphClient({
      accessToken: async () => "access",
      fetcher: async () => {
        calls += 1;
        if (calls === 1)
          return Response.json(
            { error: { code: "throttled" } },
            { status: 429 },
          );
        return Response.json({
          id: "retry-message",
          subject: "Hello",
          receivedDateTime: "2026-08-12T10:00:00.000Z",
          from: { emailAddress: { address: "prospect@example.org" } },
          toRecipients: [{ emailAddress: { address: mailbox.email } }],
          body: { contentType: "text", content: "Interested" },
          internetMessageHeaders: [],
        });
      },
    });
    await expect(
      reconcilePendingGraphNotifications(
        db,
        () => graph,
        new DeterministicReplyClassifier(),
        { now: new Date("2026-08-12T10:00:00.000Z") },
      ),
    ).resolves.toMatchObject({ failed: 1 });
    await expect(
      reconcilePendingGraphNotifications(
        db,
        () => graph,
        new DeterministicReplyClassifier(),
        { now: new Date("2026-08-12T10:01:00.000Z") },
      ),
    ).resolves.toMatchObject({ processed: 1 });
    expect(calls).toBe(2);
  });

  it("durably quarantines an invalid Graph shape and retains a review hold", async () => {
    const subscriptionId = `quarantine-${crypto.randomUUID()}`;
    const mailbox = await insertMailbox({ subscriptionId });
    await stageGraphWebhook(db, config, {
      value: [
        {
          id: "invalid-shape-notification",
          subscriptionId,
          changeType: "created",
          resource: "messages/invalid-shape",
          clientState: config.webhookClientState,
          resourceData: { id: "invalid-shape" },
        },
      ],
    });
    const graph = new MicrosoftGraphClient({
      accessToken: async () => "access",
      fetcher: async () => Response.json({ id: "invalid-shape" }),
    });
    await expect(
      reconcilePendingGraphNotifications(
        db,
        () => graph,
        new DeterministicReplyClassifier(),
      ),
    ).resolves.toMatchObject({ processed: 1 });
    const [receipt] = await db
      .select()
      .from(schema.graphNotificationReceipts)
      .where(eq(schema.graphNotificationReceipts.mailboxId, mailbox.id));
    expect(receipt).toMatchObject({
      requiresReview: true,
      reviewResolvedAt: null,
      error: "Graph message quarantined as invalid",
    });
    const [quarantine] = await db
      .select()
      .from(schema.workflowEvents)
      .where(
        eq(
          schema.workflowEvents.idempotencyKey,
          `graph:quarantine:${receipt!.deduplicationKey}`,
        ),
      );
    expect(quarantine).toMatchObject({ status: "scheduled" });
  });

  it("does not advance delta state when inbound ingestion is not durable", async () => {
    const anchor = new Date("2026-08-12T09:50:00.000Z");
    const mailbox = await insertMailbox({ lastSyncedAt: anchor });
    let requestedUrl = "";
    const graph = new MicrosoftGraphClient({
      accessToken: async () => "access",
      fetcher: async (input) => {
        requestedUrl = String(input);
        return Response.json({
          value: [
            {
              id: "classifier-failure",
              subject: "Hello",
              receivedDateTime: "2026-08-12T09:55:00.000Z",
              from: { emailAddress: { address: "prospect@example.org" } },
              toRecipients: [{ emailAddress: { address: mailbox.email } }],
              body: { contentType: "text", content: "Maybe" },
              internetMessageHeaders: [],
            },
          ],
          "@odata.deltaLink":
            "https://graph.microsoft.com/v1.0/must-not-advance",
        });
      },
    });
    await expect(
      reconcileGraphDelta(
        db,
        graph,
        {
          name: "failing-test-classifier",
          classify: async () => {
            throw new Error("offline");
          },
        },
        mailbox.id,
      ),
    ).rejects.toThrow("Inbound delta processing not completed");
    expect(decodeURIComponent(requestedUrl)).toContain(anchor.toISOString());
    const [stored] = await db
      .select()
      .from(schema.mailboxConnections)
      .where(eq(schema.mailboxConnections.id, mailbox.id));
    expect(stored?.deltaLink).toBeNull();
    const [health] = await db
      .select()
      .from(schema.workflowEvents)
      .where(
        eq(
          schema.workflowEvents.idempotencyKey,
          `graph:delta-health:${mailbox.id}`,
        ),
      );
    expect(health).toMatchObject({
      status: "failed",
      error: "Microsoft Graph delta reconciliation failed",
    });
  });

  it("validates lifecycle notifications and marks missed-delivery recovery durably", async () => {
    const mailbox = await insertMailbox({
      subscriptionId: "lifecycle-subscription",
    });
    const graph = new MicrosoftGraphClient({
      accessToken: async () => "access",
      fetcher: async () =>
        Response.json({
          value: [],
          "@odata.deltaLink":
            "https://graph.microsoft.com/v1.0/lifecycle-delta",
        }),
    });
    const lifecyclePayload = {
      value: [
        {
          subscriptionId: "lifecycle-subscription",
          clientState: config.webhookClientState,
          lifecycleEvent: "missed" as const,
        },
      ],
    };
    await expect(
      processGraphWebhook(
        db,
        () => graph,
        new DeterministicReplyClassifier(),
        config,
        lifecyclePayload,
      ),
    ).resolves.toMatchObject({ accepted: 1 });
    await expect(
      processGraphWebhook(
        db,
        () => graph,
        new DeterministicReplyClassifier(),
        config,
        lifecyclePayload,
      ),
    ).resolves.toMatchObject({ accepted: 1 });
    const events = await db
      .select()
      .from(schema.workflowEvents)
      .where(
        and(
          eq(schema.workflowEvents.entityId, mailbox.id),
          eq(schema.workflowEvents.event, "graph.lifecycle.missed"),
        ),
      );
    expect(events).toHaveLength(2);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ status: "succeeded" }),
        expect.objectContaining({ status: "succeeded" }),
      ]),
    );
  });

  it("reclaims a stale started lifecycle recovery after a worker crash", async () => {
    const mailbox = await insertMailbox({ subscriptionId: "stale-lifecycle" });
    const [event] = await db
      .insert(schema.workflowEvents)
      .values({
        entityType: "mailbox",
        entityId: mailbox.id,
        event: "graph.lifecycle.missed",
        workflowName: "graph_lifecycle_reconciliation",
        idempotencyKey: `stale-${crypto.randomUUID()}`,
        status: "started",
        runId: "crashed-worker",
        startedAt: new Date("2026-08-12T09:00:00.000Z"),
        payload: {
          lifecycleEvent: "missed",
          subscriptionId: "stale-lifecycle",
        },
      })
      .returning();
    const graph = new MicrosoftGraphClient({
      accessToken: async () => "access",
      fetcher: async () =>
        Response.json({
          value: [],
          "@odata.deltaLink":
            "https://graph.microsoft.com/v1.0/recovered-stale",
        }),
    });
    await expect(
      reconcilePendingGraphLifecycleEvents(
        db,
        () => graph,
        new DeterministicReplyClassifier(),
        config,
        { now: new Date("2026-08-12T10:00:00.000Z") },
      ),
    ).resolves.toMatchObject({ processed: 1 });
    const [stored] = await db
      .select()
      .from(schema.workflowEvents)
      .where(eq(schema.workflowEvents.id, event!.id));
    expect(stored).toMatchObject({ status: "succeeded", attempt: 2 });
    expect(stored?.runId).not.toBe("crashed-worker");
  });

  it("does not clear a replacement subscription for a stale removal event", async () => {
    const mailbox = await insertMailbox({
      subscriptionId: "replacement-subscription",
      subscriptionExpiresAt: new Date("2026-08-18T10:00:00.000Z"),
    });
    await db.insert(schema.workflowEvents).values({
      entityType: "mailbox",
      entityId: mailbox.id,
      event: "graph.lifecycle.subscriptionRemoved",
      workflowName: "graph_lifecycle_reconciliation",
      idempotencyKey: `stale-removal-${crypto.randomUUID()}`,
      status: "scheduled",
      scheduledAt: new Date("2026-08-12T09:00:00.000Z"),
      payload: {
        lifecycleEvent: "subscriptionRemoved",
        subscriptionId: "old-subscription",
      },
    });
    const graph = new MicrosoftGraphClient({
      accessToken: async () => "access",
      fetcher: async () =>
        Response.json({
          value: [],
          "@odata.deltaLink":
            "https://graph.microsoft.com/v1.0/stale-removal-delta",
        }),
    });
    await expect(
      reconcilePendingGraphLifecycleEvents(
        db,
        () => graph,
        new DeterministicReplyClassifier(),
        config,
        {
          notificationUrl: "https://app.example/api/webhooks/microsoft",
          now: new Date("2026-08-12T10:00:00.000Z"),
        },
      ),
    ).resolves.toMatchObject({ processed: 1 });
    const [stored] = await db
      .select()
      .from(schema.mailboxConnections)
      .where(eq(schema.mailboxConnections.id, mailbox.id));
    expect(stored?.subscriptionId).toBe("replacement-subscription");
  });

  it("rebaselines an expired delta token and persists only the replacement deltaLink", async () => {
    const mailbox = await insertMailbox({
      deltaLink: "https://graph.microsoft.com/v1.0/expired-token",
    });
    let calls = 0;
    const graph = new MicrosoftGraphClient({
      accessToken: async () => "access",
      fetcher: async () => {
        calls += 1;
        if (calls === 1) {
          return Response.json(
            { error: { code: "syncStateNotFound" } },
            { status: 410 },
          );
        }
        return Response.json({
          value: [],
          "@odata.deltaLink": "https://graph.microsoft.com/v1.0/rebased-token",
        });
      },
    });
    await expect(
      reconcileGraphDelta(
        db,
        graph,
        new DeterministicReplyClassifier(),
        mailbox.id,
      ),
    ).resolves.toMatchObject({ processed: 0, rebaselined: true });
    const [stored] = await db
      .select()
      .from(schema.mailboxConnections)
      .where(
        and(
          eq(schema.mailboxConnections.id, mailbox.id),
          eq(
            schema.mailboxConnections.deltaLink,
            "https://graph.microsoft.com/v1.0/rebased-token",
          ),
        ),
      );
    expect(stored).toBeDefined();
  });
});

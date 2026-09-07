import { createHash, randomBytes, randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import * as schema from "@/lib/db/schema";
import { resolveDatabaseUrls } from "@/lib/db/test-database";
import { encryptSecret } from "@/lib/microsoft/token-crypto";
import { createWorkflowTaskServices } from "@/modules/workflows/service-factory";

const { testUrl } = resolveDatabaseUrls(process.env);
const client = postgres(testUrl, { max: 5 });
const db = drizzle(client, { schema });
const now = new Date("2026-09-06T12:00:00.000Z");
const keyring = { activeKeyId: "current", keys: { current: randomBytes(32) } };
const clientState = "synthetic-workflow-routing-state-1234567890";
const notificationUrl = "https://app.example/graph-notifications";
const resource = "me/mailFolders('Inbox')/messages";
const environment = {
  AI_PROVIDER: "mock",
  MAIL_PROVIDER: "mock",
  WORKFLOW_PROVIDER: "mock",
  MICROSOFT_CLIENT_ID: "synthetic-client",
  MICROSOFT_CLIENT_SECRET: "synthetic-secret",
  MICROSOFT_TENANT_ID: "organizations",
  MICROSOFT_REDIRECT_URI: "https://app.example/callback",
  MICROSOFT_GRAPH_WEBHOOK_CLIENT_STATE: clientState,
  MICROSOFT_GRAPH_NOTIFICATION_URL: notificationUrl,
  TOKEN_ENCRYPTION_ACTIVE_KEY_ID: "current",
  TOKEN_ENCRYPTION_KEYS: `current:${keyring.keys.current.toString("base64")}`,
};
const cursor = "https://graph.microsoft.com/v1.0/me/messages/delta?original=1";
const nextCursor =
  "https://graph.microsoft.com/v1.0/me/messages/delta?completed=1";
async function insertMailbox(subscriptionId: string | null) {
  const email = `workflow-${randomUUID()}@example.com`;
  const [row] = await db
    .insert(schema.mailboxConnections)
    .values({
      provider: "microsoft_graph",
      email,
      normalizedEmail: email,
      status: "available",
      encryptedRefreshToken: encryptSecret("synthetic-refresh", keyring),
      accessTokenCiphertext: encryptSecret("synthetic-access", keyring),
      tokenExpiresAt: new Date(now.getTime() + 3_600_000),
      grantedScopes: [...schema.MICROSOFT_REQUIRED_SCOPES],
      lastSyncedAt: new Date(now.getTime() - 300_000),
      syncCursor: cursor,
      subscriptionId,
      subscriptionExpiresAt: subscriptionId
        ? new Date(now.getTime() + 6 * 86_400_000)
        : null,
      subscriptionResource: subscriptionId ? resource : null,
      subscriptionClientStateHash: subscriptionId
        ? createHash("sha256").update(clientState).digest("hex")
        : null,
    })
    .returning();
  return row!;
}
function injectTransport(
  respond: (url: string, init: RequestInit) => Response,
) {
  const calls: { method: string; url: string }[] = [];
  vi.stubGlobal(
    "fetch",
    async (input: string | URL | Request, init: RequestInit = {}) => {
      expect(new Headers(init.headers).get("Authorization")).toBe(
        "Bearer synthetic-access",
      );
      expect(
        String(input).startsWith("https://graph.microsoft.com/v1.0/"),
      ).toBe(true);
      calls.push({ method: init.method ?? "GET", url: String(input) });
      return respond(String(input), init);
    },
  );
  return calls;
}

describe("Graph workflow routing follows connected mailbox rows", () => {
  beforeAll(async () => {
    await client.unsafe("drop schema if exists public cascade");
    await client.unsafe("drop schema if exists drizzle cascade");
    await client.unsafe("create schema public");
    await migrate(drizzle(client), { migrationsFolder: "drizzle" });
  });
  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(now);
    vi.stubGlobal("fetch", async () => {
      throw new Error("Uninjected provider request");
    });
    await client.unsafe(
      "truncate table mailbox_connections, workflow_events cascade",
    );
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });
  afterAll(async () => {
    await client.end();
  });

  it("drains a real Graph receipt and lifecycle event with a mock global outbound provider", async () => {
    const row = await insertMailbox("synthetic-subscription");
    const [receipt] = await db
      .insert(schema.graphNotificationReceipts)
      .values({
        mailboxId: row.id,
        subscriptionId: row.subscriptionId!,
        resourceId: "synthetic-message",
        changeType: "created",
        deduplicationKey: randomUUID(),
      })
      .returning();
    const [lifecycle] = await db
      .insert(schema.workflowEvents)
      .values({
        entityType: "mailbox",
        entityId: row.id,
        event: "graph.lifecycle.missed",
        workflowName: "graph_lifecycle_reconciliation",
        status: "scheduled",
        scheduledAt: now,
        payload: {
          lifecycleEvent: "missed",
          subscriptionId: row.subscriptionId,
        },
      })
      .returning();
    const messagePath =
      "https://graph.microsoft.com/v1.0/me/messages/synthetic-message?$select=id,internetMessageId,conversationId,subject,receivedDateTime,from,toRecipients,body,internetMessageHeaders";
    const calls = injectTransport((url, init) => {
      expect(init.method).toBe("GET");
      if (url === cursor)
        return Response.json({ value: [], "@odata.deltaLink": nextCursor });
      expect(url).toBe(messagePath);
      return Response.json({
        id: "synthetic-message",
        internetMessageId: "<synthetic@provider.invalid>",
        subject: "Hello",
        receivedDateTime: now.toISOString(),
        from: { emailAddress: { address: "sender@example.net" } },
        toRecipients: [{ emailAddress: { address: row.email } }],
        body: { contentType: "text", content: "Thank you" },
        internetMessageHeaders: [],
      });
    });
    const services = createWorkflowTaskServices(db, environment);
    expect(
      await services["drain-graph-webhooks"]({ observedAt: now.toISOString() }),
    ).toEqual({
      notifications: { processed: 1, failed: 0 },
      lifecycle: { processed: 1, failed: 0 },
    });
    const [storedReceipt] = await db
      .select()
      .from(schema.graphNotificationReceipts)
      .where(eq(schema.graphNotificationReceipts.id, receipt!.id));
    const [storedLifecycle] = await db
      .select()
      .from(schema.workflowEvents)
      .where(eq(schema.workflowEvents.id, lifecycle!.id));
    expect(storedReceipt).toMatchObject({
      processedAt: now,
      claimId: null,
      requiresReview: false,
    });
    expect(storedLifecycle).toMatchObject({ status: "succeeded", error: null });
    expect(calls).toEqual([
      { method: "GET", url: messagePath },
      { method: "GET", url: cursor },
    ]);
  });

  it("creates and persists a real Graph subscription with a mock global outbound provider", async () => {
    const row = await insertMailbox(null);
    const expiry = new Date(now.getTime() + 6 * 86_400_000);
    const subscriptionsUrl = "https://graph.microsoft.com/v1.0/subscriptions";
    const calls = injectTransport((url, init) => {
      if (url === cursor) {
        expect(init.method).toBe("GET");
        return Response.json({ value: [], "@odata.deltaLink": nextCursor });
      }
      expect(url).toBe(subscriptionsUrl);
      if (init.method === "GET") return Response.json({ value: [] });
      expect(init.method).toBe("POST");
      expect(JSON.parse(String(init.body))).toMatchObject({
        resource,
        notificationUrl,
        clientState,
      });
      return Response.json({
        id: "synthetic-created-subscription",
        expirationDateTime: expiry.toISOString(),
      });
    });
    const services = createWorkflowTaskServices(db, environment);
    expect(
      await services["maintain-graph-subscriptions"]({
        observedAt: now.toISOString(),
      }),
    ).toMatchObject({
      subscriptionsEnsured: 1,
      subscriptionsFailed: 0,
      renewal: { renewed: 0, failed: 0 },
      deltaSynced: 1,
      deltaFailed: 0,
    });
    const [stored] = await db
      .select()
      .from(schema.mailboxConnections)
      .where(eq(schema.mailboxConnections.id, row.id));
    expect(stored).toMatchObject({
      subscriptionId: "synthetic-created-subscription",
      subscriptionExpiresAt: expiry,
      subscriptionResource: resource,
      subscriptionClientStateHash: createHash("sha256")
        .update(clientState)
        .digest("hex"),
      syncCursor: nextCursor,
    });
    expect(calls).toEqual([
      { method: "GET", url: subscriptionsUrl },
      { method: "POST", url: subscriptionsUrl },
      { method: "GET", url: cursor },
    ]);
  });

  it.each(["mock", "microsoft_graph"])(
    "does no Graph work or configuration lookup without an available Graph mailbox when global provider is %s",
    async (mailProvider) => {
      await db.insert(schema.mailboxConnections).values({
        provider: "mock",
        email: "mock@example.com",
        normalizedEmail: "mock@example.com",
        status: "available",
      });
      const fetcher = vi.fn(async () => {
        throw new Error("No Graph request is authorized by this fixture");
      });
      vi.stubGlobal("fetch", fetcher);
      // Deliberately no Microsoft or token-encryption configuration.
      const services = createWorkflowTaskServices(db, {
        AI_PROVIDER: "mock",
        MAIL_PROVIDER: mailProvider,
        WORKFLOW_PROVIDER: "mock",
      });
      await expect(
        services["drain-graph-webhooks"]({ observedAt: now.toISOString() }),
      ).resolves.toMatchObject({ skipped: true });
      await expect(
        services["maintain-graph-subscriptions"]({
          observedAt: now.toISOString(),
        }),
      ).resolves.toMatchObject({ skipped: true });
      expect(fetcher).not.toHaveBeenCalled();
    },
  );
});

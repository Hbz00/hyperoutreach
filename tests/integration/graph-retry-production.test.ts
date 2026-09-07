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
import type { AppDatabase } from "@/lib/db/types";
import { resolveDatabaseUrls } from "@/lib/db/test-database";
import type { MicrosoftConfig } from "@/lib/microsoft/config";
import {
  GraphApiError,
  MicrosoftGraphClient,
} from "@/lib/microsoft/graph-client";
import { encryptSecret } from "@/lib/microsoft/token-crypto";
import { getMicrosoftAccessToken } from "@/modules/mailboxes/microsoft-oauth-service";
import { graphDeltaHealthKey } from "@/modules/mailboxes/microsoft-graph-inbound-naming";
import {
  reconcileGraphDelta,
  reconcilePendingGraphLifecycleEvents,
  reconcilePendingGraphNotifications,
} from "@/modules/mailboxes/microsoft-graph-sync-service";
import {
  ensureGraphSubscription,
  reauthorizeGraphSubscriptionIfCurrent,
  recoverGraphSubscription,
  renewDueGraphSubscriptions,
} from "@/modules/mailboxes/microsoft-graph-subscription-service";
import { DeterministicReplyClassifier } from "@/modules/replies/reply-classifier";
import { createWorkflowTaskServices } from "@/modules/workflows/service-factory";

const { testUrl } = resolveDatabaseUrls(process.env);
const client = postgres(testUrl, { max: 6 });
const db = drizzle(client, { schema });
const now = new Date("2026-09-05T12:00:00.000Z");
const later = new Date(now.getTime() + 180_000);
const keyring = { activeKeyId: "current", keys: { current: randomBytes(32) } };
const config: MicrosoftConfig = {
  clientId: "synthetic-client",
  clientSecret: "synthetic-secret",
  tenantId: "organizations",
  redirectUri: "https://app.example/api/integrations/microsoft/callback",
  webhookClientState: "synthetic-graph-retry-client-state-1234567890",
  keyring,
  authorizeEndpoint:
    "https://login.microsoftonline.com/organizations/oauth2/v2.0/authorize",
  tokenEndpoint:
    "https://login.microsoftonline.com/organizations/oauth2/v2.0/token",
};
const notificationUrl = "https://app.example/api/webhooks/microsoft";
const classifier = new DeterministicReplyClassifier();
const resource = "me/mailFolders('Inbox')/messages";

function subscriptionContinuationCases() {
  it.each(["match", "cycle", "untrusted"])(
    "handles a later-page %s before creating a subscription",
    async (mode) => {
      const row = await mailbox({
        subscriptionId: null,
        subscriptionExpiresAt: null,
      });
      const calls: string[] = [];
      const pageTwo =
        "https://graph.microsoft.com/v1.0/subscriptions?$skiptoken=second";
      const graph = new MicrosoftGraphClient({
        accessToken: async () => "synthetic-access",
        fetcher: async (url, init) => {
          calls.push(`${init?.method} ${String(url)}`);
          if (init?.method === "POST")
            return Response.json({
              id: "unexpected-new",
              expirationDateTime: later.toISOString(),
            });
          if (calls.length === 1)
            return Response.json({
              value: [],
              "@odata.nextLink":
                mode === "untrusted"
                  ? "https://untrusted.example/subscriptions"
                  : pageTwo,
            });
          return Response.json(
            mode === "match"
              ? {
                  value: [
                    {
                      id: "recovered-second-page",
                      expirationDateTime: later.toISOString(),
                      resource,
                      notificationUrl,
                    },
                  ],
                }
              : { value: [], "@odata.nextLink": pageTwo },
          );
        },
      });
      const result = await ensureGraphSubscription(db, graph, config, row.id, {
        notificationUrl,
        now,
      });
      expect(calls.filter((call) => call.startsWith("POST"))).toEqual([]);
      expect(calls.some((call) => call.includes("untrusted.example"))).toBe(
        false,
      );
      expect(calls).toHaveLength(mode === "untrusted" ? 1 : 2);
      if (mode === "match") {
        expect(result).toMatchObject({ ok: true, disposition: "recovered" });
        expect((await storedMailbox(row.id)).subscriptionId).toBe(
          "recovered-second-page",
        );
      } else {
        expect(result).toMatchObject({ ok: false, code: "PROVIDER_ERROR" });
        expect((await storedMailbox(row.id)).subscriptionId).toBeNull();
      }
    },
  );
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function settled<T>(promise: Promise<T>) {
  return promise.then(
    (value) => ({ status: "fulfilled" as const, value }),
    (reason: unknown) => ({ status: "rejected" as const, reason }),
  );
}
async function mailbox(
  overrides: Partial<typeof schema.mailboxConnections.$inferInsert> = {},
) {
  const email = `retry-${randomUUID()}@example.com`;
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
      syncCursor:
        "https://graph.microsoft.com/v1.0/me/messages/delta?original=1",
      subscriptionId: `subscription-${randomUUID()}`,
      subscriptionExpiresAt: new Date(now.getTime() + 3_600_000),
      subscriptionResource: resource,
      subscriptionClientStateHash: createHash("sha256")
        .update(config.webhookClientState)
        .digest("hex"),
      ...overrides,
    })
    .returning();
  if (!row) throw new Error("Missing mailbox fixture");
  return row;
}
async function receipt(mailboxId: string, subscriptionId: string) {
  const [row] = await db
    .insert(schema.graphNotificationReceipts)
    .values({
      mailboxId,
      subscriptionId,
      deduplicationKey: randomUUID(),
      resourceId: "synthetic-message",
      changeType: "created",
    })
    .returning();
  return row!;
}
async function lifecycle(
  mailboxId: string,
  subscriptionId: string,
  lifecycleEvent = "reauthorizationRequired",
) {
  const [row] = await db
    .insert(schema.workflowEvents)
    .values({
      entityType: "mailbox",
      entityId: mailboxId,
      event: `graph.lifecycle.${lifecycleEvent}`,
      workflowName: "graph_lifecycle_reconciliation",
      status: "scheduled",
      scheduledAt: now,
      payload: { subscriptionId, lifecycleEvent },
    })
    .returning();
  return row!;
}
function transport(response: () => Response) {
  const calls: string[] = [];
  const graph = new MicrosoftGraphClient({
    accessToken: async () => "synthetic-access",
    fetcher: async (input, init) => {
      calls.push(`${init?.method ?? "GET"} ${String(input)}`);
      return response();
    },
  });
  return { graph, calls };
}
const throttled = (status = 429, retryAfter = "180") =>
  Response.json(
    { error: { code: "TooManyRequests" } },
    { status, headers: { "Retry-After": retryAfter } },
  );
async function storedMailbox(id: string) {
  return (
    await db
      .select()
      .from(schema.mailboxConnections)
      .where(eq(schema.mailboxConnections.id, id))
  )[0]!;
}
async function storedEvent(id: string) {
  return (
    await db
      .select()
      .from(schema.workflowEvents)
      .where(eq(schema.workflowEvents.id, id))
  )[0]!;
}
async function storedReceipt(id: string) {
  return (
    await db
      .select()
      .from(schema.graphNotificationReceipts)
      .where(eq(schema.graphNotificationReceipts.id, id))
  )[0]!;
}

// Delegate the actual candidate SELECT once, then pause its JS continuation.
// Other callers use the original db, so their claims and writes remain real.
function pauseCandidateSelect(
  table: typeof schema.workflowEvents | typeof schema.mailboxConnections,
) {
  const selected = deferred();
  const release = deferred();
  const wrapped = new Proxy(db, {
    get(target, key, receiver) {
      if (key !== "select") return Reflect.get(target, key, receiver);
      return (...args: unknown[]) => {
        const builder = Reflect.apply(target.select, target, args);
        const from = builder.from.bind(builder);
        builder.from = ((selectedTable: unknown) => {
          const query = from(selectedTable as never);
          if (selectedTable === table) {
            const then = query.then.bind(query);
            query.then = ((onFulfilled: never, onRejected: never) =>
              then(async (rows: unknown[]) => {
                selected.resolve();
                await release.promise;
                return rows;
              }).then(onFulfilled, onRejected)) as typeof query.then;
          }
          return query;
        }) as typeof builder.from;
        return builder;
      };
    },
  }) as AppDatabase;
  return { db: wrapped, selected: selected.promise, release: release.resolve };
}

describe("Graph durable retry and subscription ownership", () => {
  subscriptionContinuationCases();
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
      throw new Error("Unexpected uninjected provider transport");
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

  it.each([429, 503])(
    "honors %s Retry-After across receipt, subscription, lifecycle, and direct/generic delta entrypoints",
    async (status) => {
      const row = await mailbox();
      const notification = await receipt(row.id, row.subscriptionId!);
      const t = transport(() => throttled(status));
      expect(
        await reconcilePendingGraphNotifications(
          db,
          () => t.graph,
          classifier,
          { now },
        ),
      ).toEqual({ processed: 0, failed: 1 });
      expect((await storedReceipt(notification.id)).nextAttemptAt).toEqual(
        later,
      );
      const event = await lifecycle(row.id, row.subscriptionId!);
      expect(
        await reconcilePendingGraphLifecycleEvents(
          db,
          () => t.graph,
          classifier,
          config,
          { now, notificationUrl },
        ),
      ).toEqual({ processed: 0, failed: 1 });
      expect((await storedEvent(event.id)).scheduledAt).toEqual(later);
      expect(
        await ensureGraphSubscription(db, t.graph, config, row.id, {
          now,
          notificationUrl,
        }),
      ).toMatchObject({ ok: false, retryAt: later });
      expect(
        await recoverGraphSubscription(
          db,
          t.graph,
          config,
          row.id,
          row.subscriptionId!,
          { now, notificationUrl },
        ),
      ).toMatchObject({ ok: false, retryAt: later });
      await expect(
        reconcileGraphDelta(db, t.graph, classifier, row.id),
      ).rejects.toMatchObject({ retryAt: later });
      const services = createWorkflowTaskServices(db, {
        AI_PROVIDER: "mock",
        MAIL_PROVIDER: "mock",
        WORKFLOW_PROVIDER: "mock",
      });
      await expect(
        services["reconcile-inbound-mailbox"]({ mailboxId: row.id }),
      ).rejects.toMatchObject({ retryAt: later });
      expect(t.calls).toHaveLength(1);
      expect((await storedMailbox(row.id)).subscriptionId).toBe(
        row.subscriptionId,
      );
      expect(
        await reconcilePendingGraphNotifications(
          db,
          () => t.graph,
          classifier,
          { now: new Date(later.getTime() - 1) },
        ),
      ).toEqual({ processed: 0, failed: 0 });
      expect(t.calls).toHaveLength(1);
    },
  );

  it("preserves failed health and its deadline until a due direct or generic delta can really execute", async () => {
    const row = await mailbox();
    let fails = true;
    const t = transport(() =>
      fails
        ? throttled(503)
        : Response.json({
            value: [],
            "@odata.deltaLink":
              "https://graph.microsoft.com/v1.0/me/messages/delta?new=1",
          }),
    );
    await expect(
      reconcileGraphDelta(db, t.graph, classifier, row.id),
    ).rejects.toBeInstanceOf(GraphApiError);
    const [health] = await db
      .select()
      .from(schema.workflowEvents)
      .where(
        eq(schema.workflowEvents.idempotencyKey, graphDeltaHealthKey(row.id)),
      );
    expect(health).toMatchObject({ status: "failed", scheduledAt: later });
    await expect(
      reconcileGraphDelta(db, t.graph, classifier, row.id),
    ).rejects.toMatchObject({ retryAt: later });
    const services = createWorkflowTaskServices(db, {
      AI_PROVIDER: "mock",
      MAIL_PROVIDER: "mock",
    });
    await expect(
      services["reconcile-inbound-mailbox"]({ mailboxId: row.id }),
    ).rejects.toMatchObject({ retryAt: later });
    expect(await storedEvent(health!.id)).toEqual(health);
    expect(t.calls).toHaveLength(1);
    fails = false;
    vi.setSystemTime(later);
    await expect(
      reconcileGraphDelta(db, t.graph, classifier, row.id),
    ).resolves.toEqual({ processed: 0, rebaselined: false });
    expect(t.calls).toHaveLength(2);
    expect(await storedEvent(health!.id)).toMatchObject({
      status: "succeeded",
      scheduledAt: null,
    });
  });

  it("rechecks a lifecycle event's due deadline in the claim after another worker has deferred it", async () => {
    const row = await mailbox();
    const event = await lifecycle(row.id, row.subscriptionId!);
    const contender = pauseCandidateSelect(schema.workflowEvents);
    const t = transport(() => throttled());
    const second = settled(
      reconcilePendingGraphLifecycleEvents(
        contender.db,
        () => t.graph,
        classifier,
        config,
        { now, notificationUrl },
      ),
    );
    try {
      expect(
        await Promise.race([contender.selected.then(() => "selected"), second]),
      ).toBe("selected");
      expect(
        await reconcilePendingGraphLifecycleEvents(
          db,
          () => t.graph,
          classifier,
          config,
          { now, notificationUrl },
        ),
      ).toEqual({ processed: 0, failed: 1 });
      const deferredEvent = await storedEvent(event.id);
      contender.release();
      expect(await second).toEqual({
        status: "fulfilled",
        value: { processed: 0, failed: 0 },
      });
      expect(await storedEvent(event.id)).toEqual(deferredEvent);
      expect(t.calls).toHaveLength(1);
    } finally {
      contender.release();
      await second;
    }
  });

  it.each([429, 503])(
    "preserves a current subscription on transient renewal %s and shares the deadline with ensure/recover/reauthorization",
    async (status) => {
      const row = await mailbox();
      const t = transport(() => throttled(status));
      expect(
        await renewDueGraphSubscriptions(db, () => t.graph, { now }),
      ).toMatchObject({ renewed: 0, failed: 1 });
      expect(await storedMailbox(row.id)).toMatchObject({
        subscriptionId: row.subscriptionId,
        subscriptionExpiresAt: row.subscriptionExpiresAt,
      });
      expect(
        await ensureGraphSubscription(db, t.graph, config, row.id, {
          now,
          notificationUrl,
        }),
      ).toMatchObject({ ok: false, retryAt: later });
      expect(
        await recoverGraphSubscription(
          db,
          t.graph,
          config,
          row.id,
          row.subscriptionId!,
          { now, notificationUrl },
        ),
      ).toMatchObject({ ok: false, retryAt: later });
      expect(
        await reauthorizeGraphSubscriptionIfCurrent(
          db,
          t.graph,
          row.id,
          row.subscriptionId!,
          now,
        ),
      ).toMatchObject({ ok: false, retryAt: later });
      await renewDueGraphSubscriptions(db, () => t.graph, { now });
      expect(t.calls).toHaveLength(1);
      expect((await storedMailbox(row.id)).subscriptionId).toBe(
        row.subscriptionId,
      );
      expect(
        await db
          .select()
          .from(schema.workflowEvents)
          .where(
            eq(
              schema.workflowEvents.workflowName,
              "graph_lifecycle_reconciliation",
            ),
          ),
      ).toEqual([]);
    },
  );

  it("stops ensure after a throttled old-subscription DELETE instead of listing or creating immediately", async () => {
    const row = await mailbox({
      subscriptionExpiresAt: new Date(now.getTime() - 1),
    });
    const t = transport(() => throttled());
    expect(
      await ensureGraphSubscription(db, t.graph, config, row.id, {
        now,
        notificationUrl,
      }),
    ).toMatchObject({ ok: false, retryAt: later });
    expect(t.calls).toEqual([
      `DELETE https://graph.microsoft.com/v1.0/subscriptions/${row.subscriptionId}`,
    ]);
    expect((await storedMailbox(row.id)).subscriptionId).toBe(
      row.subscriptionId,
    );
  });

  it("rechecks the current subscription and due time under the mailbox lock for concurrent renewals", async () => {
    const row = await mailbox();
    const entered = deferred();
    const release = deferred();
    let patches = 0;
    const graph = new MicrosoftGraphClient({
      accessToken: async () => "synthetic-access",
      fetcher: async () => {
        patches++;
        entered.resolve();
        await release.promise;
        return Response.json({
          id: row.subscriptionId,
          expirationDateTime: "2026-09-11T12:00:00.000Z",
        });
      },
    });
    const first = settled(renewDueGraphSubscriptions(db, () => graph, { now }));
    const contender = pauseCandidateSelect(schema.mailboxConnections);
    let second: ReturnType<typeof first.then> | undefined;
    try {
      expect(
        await Promise.race([entered.promise.then(() => "entered"), first]),
      ).toBe("entered");
      second = settled(
        renewDueGraphSubscriptions(contender.db, () => graph, { now }),
      );
      await contender.selected;
      contender.release();
      release.resolve();
      expect(await first).toMatchObject({
        status: "fulfilled",
        value: { renewed: 1 },
      });
      expect(await second).toMatchObject({
        status: "fulfilled",
        value: { renewed: 0 },
      });
      expect(patches).toBe(1);
    } finally {
      contender.release();
      release.resolve();
      await Promise.all([first, second]);
    }
  });

  it("does not stamp a late renewal result onto a replacement subscription ID", async () => {
    const row = await mailbox();
    const entered = deferred();
    const release = deferred();
    const graph = new MicrosoftGraphClient({
      accessToken: async () => "synthetic-access",
      fetcher: async () => {
        entered.resolve();
        await release.promise;
        return Response.json({
          id: row.subscriptionId,
          expirationDateTime: "2026-09-11T12:00:00.000Z",
        });
      },
    });
    const renewal = settled(
      renewDueGraphSubscriptions(db, () => graph, { now }),
    );
    try {
      expect(
        await Promise.race([entered.promise.then(() => "entered"), renewal]),
      ).toBe("entered");
      const replacementExpiry = new Date("2026-09-10T12:00:00.000Z");
      // Deliberately bypass the cooperative lock to exercise the SQL owner fence.
      await db
        .update(schema.mailboxConnections)
        .set({
          subscriptionId: "replacement-id",
          subscriptionExpiresAt: replacementExpiry,
        })
        .where(eq(schema.mailboxConnections.id, row.id));
      release.resolve();
      await renewal;
      expect(await storedMailbox(row.id)).toMatchObject({
        subscriptionId: "replacement-id",
        subscriptionExpiresAt: replacementExpiry,
      });
    } finally {
      release.resolve();
      await renewal;
    }
  });

  it.each([404, 410])(
    "recreates a definitively absent reauthorization subscription after %s",
    async (status) => {
      const row = await mailbox();
      const event = await lifecycle(row.id, row.subscriptionId!);
      const calls: string[] = [];
      const graph = new MicrosoftGraphClient({
        accessToken: async () => "synthetic-access",
        fetcher: async (input, init) => {
          calls.push(`${init?.method} ${String(input)}`);
          if (init?.method === "PATCH") return Response.json({}, { status });
          if (init?.method === "POST")
            return Response.json({
              id: "replacement-id",
              expirationDateTime: "2026-09-11T12:00:00.000Z",
            });
          if (String(input).endsWith("/subscriptions"))
            return Response.json({ value: [] });
          return Response.json({
            value: [],
            "@odata.deltaLink":
              "https://graph.microsoft.com/v1.0/me/messages/delta?new=1",
          });
        },
      });
      expect(
        await reconcilePendingGraphLifecycleEvents(
          db,
          () => graph,
          classifier,
          config,
          { now, notificationUrl },
        ),
      ).toEqual({ processed: 1, failed: 0 });
      expect((await storedMailbox(row.id)).subscriptionId).toBe(
        "replacement-id",
      );
      expect((await storedEvent(event.id)).status).toBe("succeeded");
      expect(calls.map((call) => call.split(" ")[0])).toEqual([
        "PATCH",
        "GET",
        "POST",
        "GET",
      ]);
    },
  );

  it("builds subscription Graph token closures from the reserved database facade with a one-session pool", async () => {
    const row = await mailbox({
      subscriptionId: null,
      subscriptionExpiresAt: null,
    });
    const oneClient = postgres(testUrl, { max: 1 });
    const oneDb = drizzle(oneClient, { schema });
    let calls = 0;
    try {
      const result = await ensureGraphSubscription(
        oneDb,
        (lockedDb: AppDatabase) =>
          new MicrosoftGraphClient({
            accessToken: () =>
              getMicrosoftAccessToken(lockedDb, config, row.id, { now }),
            fetcher: async (_input, init) => {
              calls++;
              return init?.method === "GET"
                ? Response.json({ value: [] })
                : Response.json({
                    id: "one-session-sub",
                    expirationDateTime: "2026-09-11T12:00:00.000Z",
                  });
            },
          }),
        config,
        row.id,
        { now, notificationUrl },
      );
      expect(result).toMatchObject({ ok: true, disposition: "created" });
      expect(calls).toBe(2);
    } finally {
      await oneClient.end();
    }
  });

  it.each([
    ["180", 180],
    [later.toUTCString(), 180],
    ["0", 0],
    ["invalid", null],
    ["-1", null],
    ["9".repeat(400), null],
  ])(
    "validates Retry-After %s without nonfinite date arithmetic",
    async (header, expected) => {
      const t = transport(() => throttled(503, String(header)));
      await expect(t.graph.get("/subscriptions")).rejects.toMatchObject({
        retryAfterSeconds: expected,
      });
      expect(t.calls).toHaveLength(1);
    },
  );

  it("starts subscription cooldown when the failed response arrives, including time spent awaiting it", async () => {
    const row = await mailbox();
    const observedAt = new Date(now.getTime() + 15_000);
    const t = transport(() => {
      vi.setSystemTime(observedAt);
      return throttled();
    });
    expect(
      await reauthorizeGraphSubscriptionIfCurrent(
        db,
        t.graph,
        row.id,
        row.subscriptionId!,
        now,
      ),
    ).toMatchObject({ ok: false, retryAt: new Date(later.getTime() + 15_000) });
    expect(t.calls).toHaveLength(1);
  });

  it("retains the larger local retry policy when the provider asks for a shorter wait", async () => {
    const row = await mailbox();
    const notification = await receipt(row.id, row.subscriptionId!);
    await db
      .update(schema.graphNotificationReceipts)
      .set({ attemptCount: 12 })
      .where(eq(schema.graphNotificationReceipts.id, notification.id));
    const t = transport(() => throttled());
    expect(
      await reconcilePendingGraphNotifications(db, () => t.graph, classifier, {
        now,
      }),
    ).toEqual({ processed: 0, failed: 1 });
    expect((await storedReceipt(notification.id)).nextAttemptAt).toEqual(
      new Date(now.getTime() + 3_600_000),
    );
    expect(t.calls).toHaveLength(1);
  });

  it("does not shorten a newer mailbox cooldown when an older in-flight request fails later", async () => {
    const row = await mailbox();
    const notification = await receipt(row.id, row.subscriptionId!);
    const entered = deferred();
    const release = deferred();
    const graph = new MicrosoftGraphClient({
      accessToken: async () => "synthetic-access",
      fetcher: async () => {
        entered.resolve();
        await release.promise;
        return throttled();
      },
    });
    const pending = settled(
      reconcilePendingGraphNotifications(db, () => graph, classifier, { now }),
    );
    try {
      expect(
        await Promise.race([entered.promise.then(() => "entered"), pending]),
      ).toBe("entered");
      const longer = transport(() => throttled(503, "600"));
      await expect(
        reconcileGraphDelta(db, longer.graph, classifier, row.id),
      ).rejects.toBeInstanceOf(GraphApiError);
      release.resolve();
      expect(await pending).toMatchObject({
        status: "fulfilled",
        value: { failed: 1 },
      });
      const deadline = new Date(now.getTime() + 600_000);
      expect((await storedReceipt(notification.id)).nextAttemptAt).toEqual(
        deadline,
      );
      await expect(
        reconcileGraphDelta(db, longer.graph, classifier, row.id),
      ).rejects.toMatchObject({ retryAt: deadline });
      expect(longer.calls).toHaveLength(1);
    } finally {
      release.resolve();
      await pending;
    }
  });

  it.each([404, 410])(
    "queues recovery only after confirmed renewal absence %s and successfully recreates",
    async (status) => {
      const row = await mailbox();
      const methods: string[] = [];
      const graph = new MicrosoftGraphClient({
        accessToken: async () => "synthetic-access",
        fetcher: async (input, init) => {
          methods.push(init?.method ?? "GET");
          if (init?.method === "PATCH") return Response.json({}, { status });
          if (init?.method === "POST")
            return Response.json({
              id: "renewal-replacement",
              expirationDateTime: "2026-09-11T12:00:00.000Z",
            });
          if (String(input).endsWith("/subscriptions"))
            return Response.json({ value: [] });
          return Response.json({
            value: [],
            "@odata.deltaLink":
              "https://graph.microsoft.com/v1.0/me/messages/delta?renewed=1",
          });
        },
      });
      expect(
        await renewDueGraphSubscriptions(db, () => graph, { now }),
      ).toEqual({ renewed: 0, failed: 1 });
      expect(await storedMailbox(row.id)).toMatchObject({
        subscriptionId: null,
        subscriptionExpiresAt: null,
      });
      const [event] = await db
        .select()
        .from(schema.workflowEvents)
        .where(
          eq(
            schema.workflowEvents.workflowName,
            "graph_lifecycle_reconciliation",
          ),
        );
      expect(event).toMatchObject({
        status: "scheduled",
        scheduledAt: now,
        payload: { subscriptionId: row.subscriptionId },
      });
      expect(
        await reconcilePendingGraphLifecycleEvents(
          db,
          () => graph,
          classifier,
          config,
          { now, notificationUrl },
        ),
      ).toEqual({ processed: 1, failed: 0 });
      expect((await storedMailbox(row.id)).subscriptionId).toBe(
        "renewal-replacement",
      );
      expect(methods).toEqual(["PATCH", "GET", "POST", "GET"]);
    },
  );

  it("recovers after a throttled subscription recreation without erasing its structured retry deadline", async () => {
    const row = await mailbox();
    const event = await lifecycle(
      row.id,
      row.subscriptionId!,
      "subscriptionRemoved",
    );
    let fail = true;
    const methods: string[] = [];
    const graph = new MicrosoftGraphClient({
      accessToken: async () => "synthetic-access",
      fetcher: async (input, init) => {
        methods.push(init?.method ?? "GET");
        if (fail) return throttled(503);
        if (init?.method === "POST")
          return Response.json({
            id: "recovered-subscription",
            expirationDateTime: "2026-09-11T12:00:00.000Z",
          });
        if (String(input).endsWith("/subscriptions"))
          return Response.json({ value: [] });
        return Response.json({
          value: [],
          "@odata.deltaLink":
            "https://graph.microsoft.com/v1.0/me/messages/delta?recovered=1",
        });
      },
    });
    expect(
      await reconcilePendingGraphLifecycleEvents(
        db,
        () => graph,
        classifier,
        config,
        { now, notificationUrl },
      ),
    ).toEqual({ processed: 0, failed: 1 });
    expect(await storedEvent(event.id)).toMatchObject({
      status: "failed",
      scheduledAt: later,
    });
    expect(
      await ensureGraphSubscription(db, graph, config, row.id, {
        now,
        notificationUrl,
      }),
    ).toMatchObject({ ok: false, retryAt: later });
    expect(methods).toEqual(["GET"]);
    fail = false;
    vi.setSystemTime(later);
    expect(
      await reconcilePendingGraphLifecycleEvents(
        db,
        () => graph,
        classifier,
        config,
        { now: later, notificationUrl },
      ),
    ).toEqual({ processed: 1, failed: 0 });
    expect((await storedMailbox(row.id)).subscriptionId).toBe(
      "recovered-subscription",
    );
    expect(methods).toEqual(["GET", "GET", "POST", "GET"]);
  });

  it("runs the real Graph registry source after its cooldown despite a mock global outbound provider", async () => {
    const row = await mailbox();
    const t = transport(() => throttled(503));
    await expect(
      reconcileGraphDelta(db, t.graph, classifier, row.id),
    ).rejects.toBeInstanceOf(GraphApiError);
    const services = createWorkflowTaskServices(db, {
      AI_PROVIDER: "mock",
      MAIL_PROVIDER: "mock",
      WORKFLOW_PROVIDER: "mock",
      MICROSOFT_CLIENT_ID: config.clientId,
      MICROSOFT_CLIENT_SECRET: config.clientSecret,
      MICROSOFT_TENANT_ID: config.tenantId,
      MICROSOFT_REDIRECT_URI: config.redirectUri,
      MICROSOFT_GRAPH_WEBHOOK_CLIENT_STATE: config.webhookClientState,
      TOKEN_ENCRYPTION_ACTIVE_KEY_ID: keyring.activeKeyId,
      TOKEN_ENCRYPTION_KEYS: `current:${keyring.keys.current.toString("base64")}`,
    });
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      async (input: string | URL | Request, init?: RequestInit) => {
        expect(String(input)).toBe(row.syncCursor);
        expect(init?.method).toBe("GET");
        expect(new Headers(init?.headers).get("authorization")).toBe(
          "Bearer synthetic-access",
        );
        calls.push(String(input));
        return Response.json({
          value: [],
          "@odata.deltaLink":
            "https://graph.microsoft.com/v1.0/me/messages/delta?generic=1",
        });
      },
    );
    await expect(
      services["reconcile-inbound-mailbox"]({ mailboxId: row.id }),
    ).rejects.toMatchObject({ retryAt: later });
    expect(calls).toEqual([]);
    vi.setSystemTime(later);
    await expect(
      services["reconcile-inbound-mailbox"]({ mailboxId: row.id }),
    ).resolves.toEqual({ processed: 0, rebaselined: false });
    expect(calls).toEqual([row.syncCursor]);
    expect((await storedMailbox(row.id)).syncCursor).toContain("generic=1");
    const [health] = await db
      .select()
      .from(schema.workflowEvents)
      .where(
        eq(schema.workflowEvents.idempotencyKey, graphDeltaHealthKey(row.id)),
      );
    expect(health).toMatchObject({ status: "succeeded", scheduledAt: null });
  });
});

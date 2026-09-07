import { randomBytes, randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { actionLockKey, withActionLocks } from "@/lib/db/action-lock";
import * as schema from "@/lib/db/schema";
import { resolveDatabaseUrls } from "@/lib/db/test-database";
import type { MicrosoftConfig } from "@/lib/microsoft/config";
import { decryptSecret, encryptSecret } from "@/lib/microsoft/token-crypto";
import {
  completeMicrosoftConnection,
  disconnectMicrosoftMailbox,
  getMicrosoftAccessToken,
} from "@/modules/mailboxes/microsoft-oauth-service";

const { testUrl } = resolveDatabaseUrls(process.env);
const applicationName = `graph-disconnect-${randomUUID()}`;
const client = postgres(testUrl, {
  max: 5,
  connection: { application_name: applicationName },
});
const observer = postgres(testUrl, { max: 1 });
const db = drizzle(client, { schema });
const keyring = {
  activeKeyId: "current",
  keys: { current: randomBytes(32) },
};
const config: MicrosoftConfig = {
  clientId: "synthetic-disconnect-client",
  clientSecret: "synthetic-disconnect-secret",
  tenantId: "organizations",
  redirectUri: "https://app.example/api/integrations/microsoft/callback",
  webhookClientState: "synthetic-graph-disconnect-state-1234567890",
  keyring,
  authorizeEndpoint:
    "https://login.microsoftonline.com/organizations/oauth2/v2.0/authorize",
  tokenEndpoint:
    "https://login.microsoftonline.com/organizations/oauth2/v2.0/token",
};
const now = new Date("2026-09-05T10:00:00.000Z");

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function settled<T>(promise: Promise<T>): Promise<PromiseSettledResult<T>> {
  return promise.then(
    (value) => ({ status: "fulfilled", value }),
    (reason: unknown) => ({ status: "rejected", reason }),
  );
}

async function insertMailbox() {
  const email = `disconnect-${randomUUID()}@example.com`;
  const [mailbox] = await db
    .insert(schema.mailboxConnections)
    .values({
      provider: "microsoft_graph",
      email,
      normalizedEmail: email,
      providerUserId: randomUUID(),
      status: "available",
      encryptedRefreshToken: encryptSecret("synthetic-refresh-old", keyring),
      accessTokenCiphertext: encryptSecret("synthetic-access-old", keyring),
      tokenExpiresAt: new Date(now.getTime() - 1_000),
      lastSyncedAt: new Date(now.getTime() - 300_000),
      grantedScopes: [...schema.MICROSOFT_REQUIRED_SCOPES],
      syncCursor: "https://graph.microsoft.com/v1.0/me/messages/delta?old=1",
      subscriptionId: `synthetic-subscription-${randomUUID()}`,
      subscriptionExpiresAt: new Date(now.getTime() + 3_600_000),
      subscriptionClientStateHash: "synthetic-state-hash",
      subscriptionResource: "/me/messages",
    })
    .returning();
  if (!mailbox) throw new Error("Missing disconnect mailbox fixture");
  return mailbox;
}

async function mailboxById(id: string) {
  const [mailbox] = await db
    .select()
    .from(schema.mailboxConnections)
    .where(eq(schema.mailboxConnections.id, id));
  return mailbox;
}

async function expectClearedMailbox(id: string) {
  expect(await mailboxById(id)).toMatchObject({
    status: "disconnected",
    encryptedRefreshToken: null,
    accessTokenCiphertext: null,
    tokenExpiresAt: null,
    grantedScopes: [],
    syncCursor: null,
    subscriptionId: null,
    subscriptionExpiresAt: null,
    subscriptionClientStateHash: null,
    subscriptionResource: null,
  });
}

describe("Microsoft Graph disconnect critical-section ordering", () => {
  beforeAll(async () => {
    // Every provider operation is explicitly injected below; accidental use of
    // a default transport fails before any real network request can be made.
    vi.stubGlobal("fetch", async () => {
      throw new Error("Uninjected network request in disconnect regression");
    });
    await client.unsafe("drop schema if exists public cascade");
    await client.unsafe("drop schema if exists drizzle cascade");
    await client.unsafe("create schema public");
    await migrate(drizzle(client), { migrationsFolder: "drizzle" });
  });

  afterAll(async () => {
    await Promise.all([client.end(), observer.end()]);
    vi.unstubAllGlobals();
  });

  it("waits for the authorized mailbox critical section before remote deletion, local mutation, or success", async () => {
    const mailbox = await insertMailbox();
    const holderEntered = deferred();
    const releaseHolder = deferred();
    let holderReleased = false;
    const holder = settled(
      withActionLocks(db, [actionLockKey.mailbox(mailbox.id)], async () => {
        holderEntered.resolve();
        await releaseHolder.promise;
        holderReleased = true;
      }),
    );
    let disconnectFinished = false;
    const deleteSubscription = vi.fn(async (subscriptionId: string) => {
      expect(subscriptionId).toBe(mailbox.subscriptionId);
      expect(holderReleased).toBe(true);
    });
    let disconnect:
      | Promise<
          PromiseSettledResult<
            Awaited<ReturnType<typeof disconnectMicrosoftMailbox>>
          >
        >
      | undefined;
    try {
      expect(
        await Promise.race([
          holderEntered.promise.then(() => "entered"),
          holder,
        ]),
      ).toBe("entered");
      disconnect = settled(
        disconnectMicrosoftMailbox(db, mailbox.id, { deleteSubscription }),
      ).then((result) => {
        disconnectFinished = true;
        return result;
      });
      // Observe PostgreSQL itself waiting on the real mailbox lock. A mere
      // sleep or pending JS promise could pass without reaching the boundary.
      let observed = "starting";
      for (
        let attempt = 0;
        attempt < 200 && observed === "starting";
        attempt += 1
      ) {
        const [{ count }] = await observer<[{ count: number }]>`
          select count(*)::int as count
          from pg_locks l join pg_stat_activity a on a.pid = l.pid
          where l.locktype = 'advisory' and not l.granted
            and a.datname = current_database()
            and a.application_name = ${applicationName}
        `;
        observed = disconnectFinished
          ? "finished"
          : count > 0
            ? "blocked"
            : "starting";
        if (observed === "starting") {
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
      }
      expect(observed).toBe("blocked");
      expect(disconnectFinished).toBe(false);
      expect(deleteSubscription).not.toHaveBeenCalled();
      expect(await mailboxById(mailbox.id)).toEqual(mailbox);
      expect(
        await db
          .select()
          .from(schema.stateTransitions)
          .where(eq(schema.stateTransitions.entityId, mailbox.id)),
      ).toEqual([]);

      releaseHolder.resolve();
      expect(await holder).toEqual({ status: "fulfilled", value: undefined });
      expect(await disconnect).toEqual({
        status: "fulfilled",
        value: { ok: true, remoteDeleteFailed: false },
      });
      expect(deleteSubscription).toHaveBeenCalledTimes(1);
      await expectClearedMailbox(mailbox.id);
    } finally {
      releaseHolder.resolve();
      await Promise.all([holder, disconnect]);
    }
  });

  it("clears local credentials and records a sanitized transition when remote deletion fails", async () => {
    const mailbox = await insertMailbox();
    const deleteSubscription = vi.fn(async () => {
      throw new Error("synthetic-provider-secret-must-not-be-persisted");
    });
    expect(
      await disconnectMicrosoftMailbox(db, mailbox.id, { deleteSubscription }),
    ).toEqual({ ok: true, remoteDeleteFailed: true });
    expect(deleteSubscription).toHaveBeenCalledExactlyOnceWith(
      mailbox.subscriptionId,
    );
    await expectClearedMailbox(mailbox.id);
    const transitions = await db
      .select()
      .from(schema.stateTransitions)
      .where(eq(schema.stateTransitions.entityId, mailbox.id));
    expect(transitions).toHaveLength(1);
    expect(transitions[0]).toMatchObject({
      fromState: "available",
      toState: "disconnected",
      reason: "microsoft_disconnected_remote_delete_failed",
      actor: "operator",
    });
    expect(JSON.stringify(transitions)).not.toContain(
      "synthetic-provider-secret",
    );
  });

  it("does not let an already pending token refresh restore credentials after disconnect", async () => {
    const mailbox = await insertMailbox();
    const refreshEntered = deferred();
    const releaseRefresh = deferred();
    let tokenRequests = 0;
    const fetcher: typeof fetch = async (input, init) => {
      expect(String(input)).toBe(config.tokenEndpoint);
      expect(init?.method).toBe("POST");
      expect(String(init?.body)).toContain("grant_type=refresh_token");
      tokenRequests += 1;
      refreshEntered.resolve();
      await releaseRefresh.promise;
      return Response.json({
        access_token: "synthetic-access-late",
        refresh_token: "synthetic-refresh-late",
        expires_in: 3600,
        scope: "Mail.ReadWrite Mail.Send offline_access openid profile email",
      });
    };
    const refresh = settled(
      getMicrosoftAccessToken(db, config, mailbox.id, { fetcher, now }),
    );
    try {
      expect(
        await Promise.race([
          refreshEntered.promise.then(() => "entered"),
          refresh,
        ]),
      ).toBe("entered");
      expect(await disconnectMicrosoftMailbox(db, mailbox.id)).toEqual({
        ok: true,
        remoteDeleteFailed: false,
      });
      await expectClearedMailbox(mailbox.id);
      releaseRefresh.resolve();
      const result = await refresh;
      expect(result.status).toBe("rejected");
      if (result.status === "rejected") {
        expect(result.reason).toEqual(
          new Error("Microsoft token rotation ownership changed"),
        );
      }
      expect(tokenRequests).toBe(1);
      await expectClearedMailbox(mailbox.id);
    } finally {
      releaseRefresh.resolve();
      await refresh;
    }
  });

  it("allows an overlapping reconnect to complete before the pending disconnect takes effect", async () => {
    const mailbox = await insertMailbox();
    const deleteEntered = deferred();
    const releaseDelete = deferred();
    const disconnect = settled(
      disconnectMicrosoftMailbox(db, mailbox.id, {
        deleteSubscription: async (subscriptionId) => {
          expect(subscriptionId).toBe(mailbox.subscriptionId);
          deleteEntered.resolve();
          await releaseDelete.promise;
        },
      }),
    );
    const transportCalls: string[] = [];
    const fetcher: typeof fetch = async (input, init) => {
      const url = String(input);
      transportCalls.push(url);
      if (url === config.tokenEndpoint) {
        expect(init?.method).toBe("POST");
        expect(String(init?.body)).toContain("grant_type=authorization_code");
        return Response.json({
          access_token: "synthetic-access-reconnected",
          refresh_token: "synthetic-refresh-reconnected",
          expires_in: 3600,
          scope: "Mail.ReadWrite Mail.Send offline_access openid profile email",
        });
      }
      expect(url).toBe(
        "https://graph.microsoft.com/v1.0/me?$select=id,mail,userPrincipalName",
      );
      return Response.json({
        id: mailbox.providerUserId,
        mail: mailbox.email,
        userPrincipalName: mailbox.email,
      });
    };
    try {
      expect(
        await Promise.race([
          deleteEntered.promise.then(() => "entered"),
          disconnect,
        ]),
      ).toBe("entered");
      const reconnect = await completeMicrosoftConnection(
        db,
        config,
        { code: "synthetic-authorization-code", codeVerifier: "v".repeat(64) },
        { fetcher, now },
      );
      expect(reconnect.ok).toBe(true);
      const reconnected = await mailboxById(mailbox.id);
      expect(reconnected?.status).toBe("available");
      expect(
        decryptSecret(reconnected!.encryptedRefreshToken!, keyring).plaintext,
      ).toBe("synthetic-refresh-reconnected");
      expect(transportCalls).toEqual([
        config.tokenEndpoint,
        "https://graph.microsoft.com/v1.0/me?$select=id,mail,userPrincipalName",
      ]);

      // These operations overlap. Reconnect completing first, followed by
      // disconnect clearing it, is a valid order; disconnect is not complete
      // until its pending remote deletion and local credential clearing settle.
      releaseDelete.resolve();
      expect(await disconnect).toEqual({
        status: "fulfilled",
        value: { ok: true, remoteDeleteFailed: false },
      });
      await expectClearedMailbox(mailbox.id);
    } finally {
      releaseDelete.resolve();
      await disconnect;
    }
  });
});

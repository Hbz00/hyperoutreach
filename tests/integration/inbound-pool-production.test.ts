import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

import postgres from "postgres";
import { describe, expect, it } from "vitest";

import { resolveDatabaseUrls } from "@/lib/db/test-database";

const { testUrl } = resolveDatabaseUrls(process.env);

// These cases deliberately exhaust the real production-sized pool. Run the
// work in its own process: a regressed reserve() may never settle, even after
// client.end(), so ordinary test teardown cannot reliably reclaim it.
async function runIsolated(body: string, poolSize = 5) {
  const applicationName = `inbound-pool-${randomUUID()}`;
  const observer = postgres(testUrl, { max: 1 });
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "-e", `${fixture}\n${body}`],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        INBOUND_POOL_TEST_URL: testUrl,
        INBOUND_POOL_APPLICATION_NAME: applicationName,
        INBOUND_POOL_TEST_MAX: String(poolSize),
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let output = "";
  child.stdout.on("data", (data: Buffer) => {
    output += data.toString();
  });
  child.stderr.on("data", (data: Buffer) => {
    output += data.toString();
  });
  let timedOut = false;
  let snapshot: unknown;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const closed = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  const timer = setTimeout(() => {
    timedOut = true;
    // Database observation is evidence, never a prerequisite for reclaiming
    // the child. A broken observer must not disable the process deadline.
    killTimer = setTimeout(() => child.kill("SIGKILL"), 250);
    void observer`
      select count(distinct a.pid)::int as sessions,
        count(*) filter (where l.locktype = 'advisory' and l.granted)::int as held,
        count(*) filter (where l.locktype = 'advisory' and not l.granted)::int as waiting
      from pg_stat_activity a left join pg_locks l on l.pid = a.pid
      where a.datname = current_database() and a.application_name = ${applicationName}
    `
      .then((rows) => {
        snapshot = rows;
      })
      .catch((error: unknown) => {
        snapshot = String(error);
      })
      .finally(() => child.kill("SIGKILL"));
  }, 6_000);
  try {
    const exitCode = await closed;
    if (timedOut)
      console.log(JSON.stringify({ applicationName, snapshot, output }));
    expect({ timedOut, exitCode, output }).toEqual({
      timedOut: false,
      exitCode: 0,
      output: "PASS\n",
    });
  } finally {
    clearTimeout(timer);
    clearTimeout(killTimer);
    if (child.exitCode === null && child.signalCode === null)
      child.kill("SIGKILL");
    await closed;
    // Only observe this child's unique application name. Killing its own PID
    // closes its TCP sessions; never cancel another suite's database work.
    let sessions = 1;
    for (let attempt = 0; attempt < 100 && sessions; attempt += 1) {
      const [row] = await observer`
        select count(*)::int as sessions from pg_stat_activity
        where datname = current_database() and application_name = ${applicationName}
      `;
      sessions = Number(row?.sessions);
      if (sessions) await new Promise((resolve) => setTimeout(resolve, 10));
    }
    try {
      await observer`
        delete from workflow_events where entity_id in (
          select id from mailbox_connections where email like ${`${applicationName}-%`}
        )
      `;
      await observer`delete from mailbox_connections where email like ${`${applicationName}-%`}`;
    } finally {
      await observer.end();
    }
    expect(
      sessions,
      "The isolated child must leave no PostgreSQL sessions",
    ).toBe(0);
  }
}

const fixture = `
import assert from 'node:assert/strict';
import { inArray, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import * as schema from './src/lib/db/schema.ts';
import { withActionLocks, ActionLockBusyError } from './src/lib/db/action-lock.ts';
import { withInboundReconciliationHealth, defaultInboundNaming, defaultInboundCursorEvents } from './src/modules/mailboxes/inbound-reconciliation.ts';
import { createWorkflowTaskServices } from './src/modules/workflows/service-factory.ts';
import { registerInboundProvider } from './src/modules/mailboxes/inbound-source-registry.ts';
import { reconcileGraphDelta } from './src/modules/mailboxes/microsoft-graph-sync-service.ts';
import { MicrosoftGraphClient } from './src/lib/microsoft/graph-client.ts';
import { DeterministicReplyClassifier } from './src/modules/replies/reply-classifier.ts';
import { createMailboxGraphClient } from './src/modules/mailboxes/microsoft-oauth-service.ts';
import { encryptSecret } from './src/lib/microsoft/token-crypto.ts';

const client = postgres(process.env.INBOUND_POOL_TEST_URL, {
  max: Number(process.env.INBOUND_POOL_TEST_MAX),
  connection: { application_name: process.env.INBOUND_POOL_APPLICATION_NAME, lock_timeout: 3000 },
  onnotice: () => {},
});
const db = drizzle(client, { schema });
await migrate(db, { migrationsFolder: 'drizzle' });
const observer = postgres(process.env.INBOUND_POOL_TEST_URL, { max: 1 });
const prefix = process.env.INBOUND_POOL_APPLICATION_NAME;
const mailboxes = await db.insert(schema.mailboxConnections).values(
  Array.from({ length: 5 }, (_, index) => ({
    provider: 'microsoft_graph', email: prefix + '-' + index + '@example.test',
    normalizedEmail: prefix + '-' + index + '@example.test', status: 'available',
    syncCursor: 'https://graph.microsoft.com/v1.0/me/delta?fixture=' + index,
    lastSyncedAt: new Date('2026-09-05T00:00:00Z'),
  }))
).returning();
function synchronizeReservations() {
  const reserve = client.reserve.bind(client);
  let release;
  const ready = new Promise((resolve) => { release = resolve; });
  let reservations = 0;
  client.reserve = async () => {
    const connection = await reserve();
    reservations += 1;
    if (reservations === 5) release();
    if (reservations <= 5) await ready;
    return connection;
  };
  return () => reservations;
}
async function finish() {
  const [{ count }] = await observer\`
    select count(*)::int as count from pg_locks l join pg_stat_activity a on a.pid = l.pid
    where a.application_name = \${process.env.INBOUND_POOL_APPLICATION_NAME} and l.locktype = 'advisory'
  \`;
  assert.equal(count, 0, 'All advisory locks must be released');
  assert.equal((await client\`show lock_timeout\`)[0].lock_timeout, '3s');
  await client.end();
  await observer.end();
  console.log('PASS');
}
`;

describe("production inbound pool ownership", () => {
  it("completes five distinct mailbox health rounds using five sessions", async () => {
    await runIsolated(`
      const reservations = synchronizeReservations();
      let callbacks = 0;
      await Promise.all(mailboxes.map((mailbox) => withInboundReconciliationHealth(
        db, mailbox.id, defaultInboundNaming('microsoft_graph', mailbox.id), async () => { callbacks += 1; },
      )));
      assert.equal(callbacks, 5);
      assert.equal(reservations(), 5);
      const events = await db.select().from(schema.workflowEvents);
      for (const mailbox of mailboxes) assert.ok(events.some((event) => event.entityId === mailbox.id && event.status === 'succeeded'));
      await finish();
    `);
  });

  it("runs the real workflow callback, source SQL, ingestion reads and cursor transaction on those sessions", async () => {
    await runIsolated(`
      const reservations = synchronizeReservations();
      let sources = 0;
      registerInboundProvider('microsoft_graph', {
        naming: (id) => defaultInboundNaming('microsoft_graph', id),
        cursorEvents: () => defaultInboundCursorEvents('microsoft_graph'),
        createSource: async (sourceDb, mailbox) => {
          await sourceDb.execute(sql\`select 1\`);
          sources += 1;
          return { kind: 'microsoft_graph', async fetchSince(cursor, ingestPage) {
            await ingestPage([{
              mailboxId: mailbox.id, providerMessageId: prefix, inReplyTo: '<unmatched@example.test>',
              sender: 'reply@example.test', recipient: 'operator@example.test', subject: 'Fixture',
              body: 'Fixture only', receivedAt: new Date(),
            }]);
            return { nextCursor: 'completed:' + mailbox.id, rebaselined: false };
          }};
        },
      });
      const services = createWorkflowTaskServices(db, { AI_PROVIDER: 'mock', MAIL_PROVIDER: 'mock', WORKFLOW_PROVIDER: 'mock' });
      const results = await Promise.all(mailboxes.map((mailbox) => services['reconcile-inbound-mailbox']({ mailboxId: mailbox.id })));
      assert.equal(sources, 5);
      assert.equal(reservations(), 5);
      assert.ok(results.every((result) => result.processed === 1));
      const current = await db.select().from(schema.mailboxConnections);
      for (const mailbox of mailboxes) assert.equal(current.find((row) => row.id === mailbox.id).syncCursor, 'completed:' + mailbox.id);
      await finish();
    `);
  });

  it("runs the direct Graph delta callback and cursor transaction with a full five-session pool", async () => {
    await runIsolated(`
      const reservations = synchronizeReservations();
      let requests = 0;
      const graph = new MicrosoftGraphClient({ accessToken: async () => 'fixture', fetcher: async () => {
        requests += 1;
        return Response.json({ value: [], '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/me/delta?done=1' });
      }});
      await Promise.all(mailboxes.map((mailbox) => reconcileGraphDelta(db, graph, new DeterministicReplyClassifier(), mailbox.id)));
      assert.equal(requests, 5);
      assert.equal(reservations(), 5);
      await finish();
    `);
  });

  it("keeps outer and repeated locks through inner failure and restores the session timeout", async () => {
    await runIsolated(`
      const outerKey = 'outer:' + prefix;
      const innerKey = 'inner:' + prefix;
      const failure = new ActionLockBusyError();
      let callbacks = 0;
      await withActionLocks(db, [outerKey], async (outerDb) => {
        const [{ pid: outerPid }] = await outerDb.execute(sql\`select pg_backend_pid() as pid\`);
        await assert.rejects(withActionLocks(outerDb, [outerKey, innerKey, innerKey], async (innerDb) => {
          callbacks += 1;
          assert.equal((await innerDb.execute(sql\`select pg_backend_pid() as pid\`))[0].pid, outerPid);
          assert.equal((await innerDb.execute(sql\`show lock_timeout\`))[0].lock_timeout, '3s');
          throw failure;
        }, { globalAttempts: 3, globalRetryDelayMs: 0, unlock: async (key, unlock) => {
          if (key === innerKey) throw new Error('injected inner cleanup failure');
          await unlock();
        }}), (error) => error === failure);
        assert.equal(callbacks, 1);
        assert.equal((await observer\`select pg_try_advisory_lock(hashtextextended(\${outerKey}, 0)) as acquired\`)[0].acquired, false);
        assert.equal((await observer\`select pg_try_advisory_lock(hashtextextended(\${innerKey}, 0)) as acquired\`)[0].acquired, true);
        await observer\`select pg_advisory_unlock_all()\`;
        await outerDb.transaction(async (tx) => { await tx.execute(sql\`select 1\`); });
      });
      await finish();
    `);
  });

  it("binds direct Graph token acquisition to the round session before requesting its delta page", async () => {
    await runIsolated(`
      const keyring = { activeKeyId: 'fixture', keys: { fixture: Buffer.alloc(32, 1) } };
      await db.update(schema.mailboxConnections).set({
        encryptedRefreshToken: encryptSecret('fixture-refresh', keyring),
        accessTokenCiphertext: encryptSecret('fixture-access', keyring),
        tokenExpiresAt: new Date(Date.now() + 3_600_000),
      }).where(inArray(schema.mailboxConnections.id, mailboxes.map((mailbox) => mailbox.id)));
      const reservations = synchronizeReservations();
      let requests = 0;
      globalThis.fetch = async (url, init) => {
        assert.ok(String(url).startsWith('https://graph.microsoft.com/v1.0/'));
        assert.equal(init.method, 'GET');
        assert.equal(init.headers.Authorization, 'Bearer fixture-access');
        requests += 1;
        return Response.json({ value: [], '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/me/delta?token-fixture=1' });
      };
      await Promise.all(mailboxes.map((mailbox) => reconcileGraphDelta(
        db, (roundDb) => createMailboxGraphClient(roundDb, { keyring }, mailbox.id), new DeterministicReplyClassifier(), mailbox.id,
      )));
      assert.equal(requests, 5);
      assert.equal(reservations(), 5);
      await finish();
    `);
  });

  it("records failed health for every mailbox without reacquiring pool capacity or replaying work", async () => {
    await runIsolated(`
      const reservations = synchronizeReservations();
      const failure = new Error('fixture round failure');
      let callbacks = 0;
      const results = await Promise.allSettled(mailboxes.map((mailbox) => withInboundReconciliationHealth(
        db, mailbox.id, defaultInboundNaming('microsoft_graph', mailbox.id), async (roundDb) => {
          callbacks += 1;
          await roundDb.transaction(async (tx) => { await tx.execute(sql\`select 1\`); });
          throw failure;
        },
      )));
      assert.ok(results.every((result) => result.status === 'rejected' && result.reason === failure));
      assert.equal(callbacks, 5);
      assert.equal(reservations(), 5);
      const events = await db.select().from(schema.workflowEvents);
      for (const mailbox of mailboxes) {
        const event = events.find((event) => event.entityId === mailbox.id);
        assert.equal(event.status, 'failed');
        assert.equal(event.error, 'Inbound reconciliation failed');
        assert.ok(event.scheduledAt > event.completedAt);
      }
      await finish();
    `);
  });

  it("retains the outer lock while a partially acquired inner scope times out and retries", async () => {
    await runIsolated(`
      const outerKey = 'outer:' + prefix;
      const firstKey = 'a:' + prefix;
      const heldKey = 'z:' + prefix;
      await observer\`select pg_advisory_lock(hashtextextended(\${heldKey}, 0))\`;
      await withActionLocks(db, [outerKey], async (outerDb) => {
        let calls = 0;
        let partialReleased;
        const released = new Promise((resolve) => { partialReleased = resolve; });
        let continueAfterProbe;
        const probeFinished = new Promise((resolve) => { continueAfterProbe = resolve; });
        const waiting = withActionLocks(outerDb, [heldKey, firstKey], async (innerDb) => {
          calls += 1;
          assert.equal((await innerDb.execute(sql\`show lock_timeout\`))[0].lock_timeout, '3s');
        }, { unlock: async (key, unlock) => {
          await unlock();
          if (key === firstKey) { partialReleased(); await probeFinished; }
        }});
        await released;
        assert.equal(calls, 0);
        assert.equal((await observer\`select pg_try_advisory_lock(hashtextextended(\${outerKey}, 0)) as acquired\`)[0].acquired, false);
        assert.equal((await observer\`select pg_try_advisory_lock(hashtextextended(\${firstKey}, 0)) as acquired\`)[0].acquired, true);
        await observer\`select pg_advisory_unlock_all()\`;
        continueAfterProbe();
        await waiting;
        assert.equal(calls, 1);
        assert.equal((await observer\`select pg_try_advisory_lock(hashtextextended(\${outerKey}, 0)) as acquired\`)[0].acquired, false);
      });
      await finish();
    `);
  });

  it("preserves the next borrower's timeout when acquisition is cancelled", async () => {
    await runIsolated(
      `
      const heldKey = 'cleanup:' + prefix;
      await observer\`select pg_advisory_lock(hashtextextended(\${heldKey}, 0))\`;
      const reserve = client.reserve.bind(client);
      client.reserve = async () => {
        const connection = await reserve();
        return new Proxy(connection, { apply(target, thisArg, args) {
          const [strings, ...values] = args;
          if (strings[0].includes('pg_advisory_lock')) {
            // Give the observer a deterministic cancellation window while
            // executing the actual acquisition statement against PostgreSQL.
            const delayed = strings.map((part) => part.replace("'100ms'", "'30s'"));
            delayed.raw = delayed;
            return Reflect.apply(target, thisArg, [delayed, ...values]);
          }
          return Reflect.apply(target, thisArg, args);
        }});
      };
      let callbacks = 0;
      const action = withActionLocks(db, [heldKey], async () => { callbacks += 1; })
        .then(() => ({ code: 'unexpected-success' }), (error) => ({ code: error.code }));
      let acquiringPid;
      for (let attempt = 0; attempt < 200 && !acquiringPid; attempt += 1) {
        const rows = await observer\`
          select pid from pg_stat_activity where application_name = \${prefix}
            and wait_event_type = 'Lock' and wait_event = 'advisory'
        \`;
        acquiringPid = rows[0]?.pid;
        if (!acquiringPid) await new Promise((resolve) => setTimeout(resolve, 5));
      }
      assert.ok(acquiringPid, 'Must observe the actual blocked acquisition before cancelling it');
      const nextReservation = reserve();
      await observer\`select pg_cancel_backend(\${acquiringPid})\`;
      const reclaimed = await nextReservation;
      const timeout = (await reclaimed\`show lock_timeout\`)[0].lock_timeout;
      reclaimed.release();
      await observer\`select pg_advisory_unlock_all()\`;
      assert.deepEqual(await action, { code: '57014' });
      assert.equal(callbacks, 0);
      assert.equal(timeout, '3s', 'Cancellation must never leak the acquisition timeout to the next borrower');
      await finish();
    `,
      1,
    );
  });

  it("preserves an explicit transaction's local timeout across successful nested acquisition", async () => {
    await runIsolated(
      `
      await withActionLocks(db, ['outer:' + prefix], async (outerDb) => {
        await outerDb.transaction(async (tx) => {
          await tx.execute(sql\`select set_config('lock_timeout', '5s', true)\`);
          await withActionLocks(tx, ['inner:' + prefix], async (innerDb) => {
            assert.equal((await innerDb.execute(sql\`show lock_timeout\`))[0].lock_timeout, '5s');
          });
          assert.equal((await tx.execute(sql\`show lock_timeout\`))[0].lock_timeout, '5s');
        });
        assert.equal((await outerDb.execute(sql\`show lock_timeout\`))[0].lock_timeout, '3s');
      });
      await finish();
    `,
      1,
    );
  });
});

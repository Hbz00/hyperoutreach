import assert from "node:assert/strict";
import { createRequire } from "node:module";
import postgresEsm from "postgres";

const postgres =
  process.argv[2] === "cjs"
    ? createRequire(import.meta.url)("postgres")
    : postgresEsm;
const testUrl = process.env.TEST_DATABASE_URL;
if (!testUrl || !new URL(testUrl).pathname.endsWith("_test")) {
  throw new Error("A disposable test database is required");
}
let signalClose;
const closed = new Promise((resolve) => (signalClose = resolve));
const client = postgres(testUrl, {
  max: 1,
  max_pipeline: 1,
  onclose: () => signalClose(),
});
const observer = postgres(testUrl, { max: 1 });
try {
  const reserved = await client.reserve();
  const [{ pid }] =
    await reserved`select pg_backend_pid() as pid, pg_advisory_lock(719197)`;
  const work = [
    reserved`select pg_sleep(300)`,
    reserved`select 1`,
    reserved`select 2`,
  ];
  const settledWork = Promise.allSettled(work);
  let sleeping = false;
  for (let attempt = 0; attempt < 200; attempt++) {
    const [row] =
      await observer`select wait_event from pg_stat_activity where pid=${pid}`;
    if (row?.wait_event === "PgSleep") {
      sleeping = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(
    sleeping,
    true,
    "the first query must be active before connection loss",
  );
  await observer`select pg_terminate_backend(${pid})`;
  await closed;
  const results = await settledWork;
  assert.deepEqual(
    results.map((result) => result.status),
    ["rejected", "rejected", "rejected"],
  );
  await assert.rejects(reserved`select 1`, { code: "CONNECTION_CLOSED" });
  reserved.release();
  const [{ locks }] = await observer`
    select count(*)::int as locks from pg_locks where pid=${pid} and locktype='advisory'
  `;
  assert.equal(locks, 0);
  const [{ replacement }] =
    await client`select pg_backend_pid() as replacement`;
  assert.notEqual(replacement, pid);
  assert.ok(replacement > 0);
  // A stale handle must not execute on the reconnected physical pool slot or
  // release another caller's new reservation.
  const current = await client.reserve();
  reserved.release();
  await assert.rejects(reserved`select 1`, { code: "CONNECTION_CLOSED" });
  assert.equal(
    (await current`select pg_backend_pid() as pid`)[0].pid,
    replacement,
  );
  current.release();
  assert.equal((await client`select 42 as answer`)[0].answer, 42);
  console.log(
    JSON.stringify({ entryPoint: process.argv[2], locks, replaced: true }),
  );
} finally {
  await client.end({ timeout: 1 });
  await observer.end({ timeout: 1 });
}

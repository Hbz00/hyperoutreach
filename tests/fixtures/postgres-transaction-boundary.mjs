import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createConnection } from "node:net";
import postgresEsm from "postgres";

const postgres =
  process.argv[2] === "cjs"
    ? createRequire(import.meta.url)("postgres")
    : postgresEsm;
const testUrl = process.env.TEST_DATABASE_URL;
if (!testUrl || !new URL(testUrl).pathname.endsWith("_test"))
  throw new Error("A disposable test database is required");
const backpressureMode = process.argv[3] === "backpressure";
const pipeline = backpressureMode ? 100 : Number(process.argv[3]);
assert.ok(pipeline === 1 || pipeline === 100);
let nativeBackpressure = false;
const endpoint = new URL(testUrl);
const client = postgres(testUrl, {
  max: 1,
  max_pipeline: pipeline,
  ...(backpressureMode
    ? {
        socket: async () => {
          const socket = createConnection({
            host: endpoint.hostname,
            port: Number(endpoint.port),
            highWaterMark: 16,
          });
          await new Promise((resolve, reject) => {
            socket.once("connect", resolve);
            socket.once("error", reject);
          });
          const write = socket.write;
          socket.write = function (chunk, ...args) {
            const result = Reflect.apply(write, this, [chunk, ...args]);
            if (
              Buffer.isBuffer(chunk) &&
              chunk.includes(Buffer.from("begin ")) &&
              result === false
            )
              nativeBackpressure = true;
            return result;
          };
          return socket;
        },
      }
    : {}),
});
const observer = postgres(testUrl, { max: 1 });
const unhandled = [];
const recordUnhandled = (error) => unhandled.push(String(error));
process.on("unhandledRejection", recordUnhandled);
let deadline;
let work;
try {
  const [{ pid }] = await client`select pg_backend_pid() as pid`;
  // All writes and database responses are native. The first query keeps the
  // connection busy while BEGIN reaches the exact pipeline boundary.
  const pending = backpressureMode
    ? []
    : [client`select pg_sleep(0.2)`.execute()];
  if (!backpressureMode)
    for (let index = 1; index < pipeline; index++)
      pending.push(client`select 1`.execute());
  let callbackCount = 0;
  let unrelated;
  const transaction = client.begin(
    backpressureMode ? " ".repeat(1024 * 1024) : "",
    async (tx) => {
      callbackCount++;
      await tx`create temporary table boundary_marker (value integer) on commit delete rows`;
      await tx`insert into boundary_marker values (1)`;
      // Ordinary pool work must wait for COMMIT; sharing the transaction would
      // expose its uncommitted marker and permit another request to affect it.
      unrelated = Promise.resolve(
        client`select count(*)::int as count from boundary_marker`.execute(),
      );
      unrelated.catch(() => {});
      const [{ value }] = await tx`select 42 as value`;
      return value;
    },
  );
  work = Promise.allSettled([...pending, transaction]);
  const results = await Promise.race([
    work,
    new Promise(
      (_, reject) =>
        (deadline = setTimeout(
          () => reject(new Error("transaction did not settle")),
          3000,
        )),
    ),
  ]);
  const pooledRows = await unrelated;
  const [activity] =
    await observer`select state from pg_stat_activity where pid=${pid}`;
  console.log(
    JSON.stringify({
      entryPoint: process.argv[2],
      pipeline: backpressureMode ? "backpressure" : pipeline,
      nativeBackpressure,
      callbackCount,
      statuses: results.map((result) => result.status),
      state: activity?.state,
      unhandled,
    }),
  );
  if (backpressureMode)
    assert.equal(
      nativeBackpressure,
      true,
      "native socket.write must actually report backpressure",
    );
  assert.equal(results.at(-1).status, "fulfilled");
  assert.equal(results.at(-1).value, 42);
  assert.equal(callbackCount, 1);
  assert.equal(pooledRows[0].count, 0);
  assert.equal(activity.state, "idle");
  assert.equal((await client`select 43 as value`)[0].value, 43);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(unhandled, []);
} finally {
  clearTimeout(deadline);
  await client.end({ timeout: 0 });
  await observer.end({ timeout: 1 });
  await work;
  await new Promise((resolve) => setImmediate(resolve));
  process.off("unhandledRejection", recordUnhandled);
}

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// postgres 3.4.9 keeps reserved handles attached to a physical connection after
// onclose. Their next query can crash on socket.write(null), and release can
// return a closed or newly reserved connection to the pool. Keep this patch
// version- and source-pinned until an upstream release covers the regressions
// in tests/integration/action-lock-cleanup-production.test.ts.
const directory = new URL("../node_modules/postgres/", import.meta.url);
const version = JSON.parse(
  readFileSync(new URL("package.json", directory), "utf8"),
).version;
if (version !== "3.4.9")
  throw new Error("Review the PostgreSQL reservation patch for this version");

// The runtime checks the imported constructor, including when Next bundles it.
// Both files must carry this repair: an interrupted install must not certify an
// index.js whose connection.js still lacks the lifecycle/transaction fixes.
const revision = "hyperoutreach-postgres-3.4.9-v1";
const indexMarker = `  hyperoutreachReservationPatch: Connection.hyperoutreachReservationPatch === '${revision}' ? '${revision}' : undefined,\n`;
const connectionMarker = `Connection.hyperoutreachReservationPatch = '${revision}'\n\n`;

const before = `    move(c, reserved)
    c.reserved = () => queue.length
      ? c.execute(queue.shift())
      : move(c, reserved)
    c.reserved.release = true

    const sql = Sql(handler)
    sql.release = () => {
      c.reserved = null
      onopen(c)
    }

    return sql

    function handler(q) {
      c.queue === full
        ? queue.push(q)
        : c.execute(q) || move(c, full)
    }
`;
const after = `    move(c, reserved)
    const reservation = () => queue.length
      ? c.execute(queue.shift())
      : move(c, reserved)
    reservation.release = true
    c.reserved = reservation
    const lost = error => {
      while (queue.length)
        queue.shift().reject(error)
    }
    c.onclose = lost

    const sql = Sql(handler)
    sql.release = () => {
      if (c.reserved !== reservation)
        return
      c.onclose === lost && (c.onclose = null)
      c.reserved = null
      onopen(c)
    }

    return sql

    function handler(q) {
      if (c.reserved !== reservation)
        return q.reject(Errors.connection('CONNECTION_CLOSED', options))
      c.queue === full
        ? queue.push(q)
        : c.execute(q) || move(c, full)
    }
`;
const closedBefore = `    !hadError && (query || sent.length) && error(Errors.connection('CONNECTION_CLOSED', options, socket))
    closedTime = performance.now()
`;
const closedAfter = `    !hadError && (query || sent.length) && error(Errors.connection('CONNECTION_CLOSED', options, socket))
    query = results = errorResponse = null
    result = new Result()
    closedTime = performance.now()
`;
const executeBefore = `      return write(toBuffer(q))
        && !q.describeFirst
        && !q.cursorFn
        && sent.length < max_pipeline
        && (!q.options.onexecute || q.options.onexecute(connection))
`;
const executeAfter = `      const writable = write(toBuffer(q))
      if (!q.describeFirst && !q.cursorFn && q.options.onexecute) {
        q.options.onexecute(connection)
        return false
      }
      return writable
        && !q.describeFirst
        && !q.cursorFn
        && sent.length < max_pipeline
`;
const sources = [
  [
    "src/index.js",
    "4e21f5733e70d79cffc10d10d4ef01031de4a9ac862210e43f8870029fd103ed",
    before,
    after,
  ],
  [
    "cjs/src/index.js",
    "d8fea1a5311c47e65004646bc81f57305ac64d48f99004a5b3ca27bcfc6babf8",
    before,
    after,
  ],
  [
    "cf/src/index.js",
    "aca9c247b7ddb2aedf90d20ce8e6f52ac6ebd95865056599ca05ed4dab4baad7",
    before,
    after,
  ],
  [
    "src/connection.js",
    "ee3a218d9aa6a6f2887c1a19da50009335fe84c11a5431d5cab72d6bc528632f",
    closedBefore,
    closedAfter,
  ],
  [
    "cjs/src/connection.js",
    "ce6d375809baad79963ef9b3773e6ac757bcf6da2362d4d85482bb14c2c751be",
    closedBefore,
    closedAfter,
  ],
  [
    "cf/src/connection.js",
    "3efad812b825f76708f2e62e8dd00088900206e04afed2dc4b75b9aecd435fa9",
    closedBefore,
    closedAfter,
  ],
].map(([relative, expected, originalText, patchedText]) => {
  const path = new URL(relative, directory);
  const current = readFileSync(path, "utf8");
  const isConnection = relative.endsWith("connection.js");
  const unmarked = current.replace(
    isConnection ? connectionMarker : indexMarker,
    "",
  );
  let original = unmarked.includes(patchedText)
    ? unmarked.replace(patchedText, originalText)
    : unmarked;
  if (relative.endsWith("connection.js"))
    original = original.replace(executeAfter, executeBefore);
  const hash = createHash("sha256").update(original).digest("hex");
  if (hash !== expected || original.split(originalText).length !== 2) {
    throw new Error(`Unexpected PostgreSQL source: ${fileURLToPath(path)}`);
  }
  let patched = original.replace(originalText, patchedText);
  if (relative.endsWith("connection.js")) {
    if (original.split(executeBefore).length !== 2)
      throw new Error(`Unexpected PostgreSQL execution boundary: ${relative}`);
    patched = patched.replace(executeBefore, executeAfter);
  }
  patched = isConnection
    ? patched.replace("let uid = 1\n", `${connectionMarker}let uid = 1\n`)
    : patched.replace(
        "Object.assign(Postgres, {\n",
        `Object.assign(Postgres, {\n${indexMarker}`,
      );
  return {
    path,
    current,
    patched,
  };
});

for (const { path, current, patched } of sources) {
  if (current !== patched) writeFileSync(path, patched);
}
console.log(
  "Verified PostgreSQL 3.4.9 reservation lifecycle patch (ESM, CJS, CF)",
);

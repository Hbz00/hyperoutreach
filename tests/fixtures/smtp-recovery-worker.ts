import assert from "node:assert/strict";

import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import * as schema from "@/lib/db/schema";
import { resolveDatabaseUrls } from "@/lib/db/test-database";
import { readTransport } from "@/lib/smtp-imap/transport-config";
import { createMailProviderForMailbox } from "@/modules/mailboxes/provider-factory";
import { WorkflowEventsSendJournal } from "@/modules/mailboxes/smtp-send-journal";
import { sendApprovedMessage } from "@/modules/messages/send-service";
import { createWorkflowTaskServices } from "@/modules/workflows/service-factory";
import { assertControlledDatabase } from "../support/smtp-controlled-fixture";

const [mode, messageId] = process.argv.slice(2);
assert.ok(mode);
assert.ok(
  [
    "after-acceptance",
    "before-acceptance",
    "reconcile",
    "recover-stale",
  ].includes(mode),
);
assert.ok(messageId);
const { testUrl } = resolveDatabaseUrls(process.env);
assertControlledDatabase(testUrl);
assert.equal(process.env.NODE_TLS_REJECT_UNAUTHORIZED, "0");
const client = postgres(testUrl, { max: 4 });
const db = drizzle(client, { schema });
try {
  const [row] = await db
    .select({ message: schema.messages, mailbox: schema.mailboxConnections })
    .from(schema.messages)
    .innerJoin(
      schema.mailboxConnections,
      eq(schema.mailboxConnections.id, schema.messages.mailboxId),
    )
    .where(eq(schema.messages.id, messageId));
  assert.ok(row);
  const transport = readTransport(row.mailbox.settings);
  assert.ok(transport);
  assert.equal(transport.imap.host, "127.0.0.1");
  assert.equal(transport.imap.port, 3993);
  assert.equal(transport.smtp.host, "127.0.0.1");
  assert.equal(transport.smtp.port, 3587);
  assert.ok(row.message.recipient.endsWith(".test"));
  assert.ok(row.mailbox.email.endsWith(".test"));
  if (mode === "after-acceptance" || mode === "before-acceptance") {
    const record = WorkflowEventsSendJournal.prototype.recordAcceptance;
    WorkflowEventsSendJournal.prototype.recordAcceptance = async function (
      key: string,
    ) {
      if (mode === "after-acceptance") await record.call(this, key);
      assert.ok(process.send);
      process.send({ boundary: mode, messageId, messageKey: key });
      // Pause only at the fault-injection boundary, after a real SMTP response.
      // The parent must kill this owned process; no transport result is forged.
      await new Promise<void>(() => {
        setInterval(() => {}, 1000);
      });
    };
  }
  if (mode === "recover-stale") {
    // Advance only the scheduler's observation to select a stale claim;
    // the production send service still reads its own real wall clock.
    const workflow = await createWorkflowTaskServices(db, process.env)[
      "recover-stale-work"
    ]({
      observedAt: new Date(Date.now() + 6 * 60_000).toISOString(),
      limit: 1,
    });
    process.send?.({ workflow });
    if (!process.send) console.log(JSON.stringify({ workflow }));
  } else {
    const provider = await createMailProviderForMailbox(db, row.mailbox.id, {
      environment: process.env,
    });
    const result = await sendApprovedMessage(db, provider, { messageId });
    process.send?.({ result });
    if (!process.send) console.log(JSON.stringify({ result }));
  }
} finally {
  await client.end({ timeout: 5 });
}

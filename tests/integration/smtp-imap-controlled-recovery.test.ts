import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import net from "node:net";

import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import * as schema from "@/lib/db/schema";
import { resolveDatabaseUrls } from "@/lib/db/test-database";
import { outreachMessageId } from "@/lib/smtp-imap/message-id";
import {
  readTransport,
  writeTransport,
} from "@/lib/smtp-imap/transport-config";
import { defaultInboundNaming } from "@/modules/mailboxes/inbound-reconciliation";
import { createMailProviderForMailbox } from "@/modules/mailboxes/provider-factory";
import { WorkflowEventsSendJournal } from "@/modules/mailboxes/smtp-send-journal";
import { sendApprovedMessage } from "@/modules/messages/send-service";
import { createWorkflowTaskServices } from "@/modules/workflows/service-factory";
import {
  assertControlledDatabase,
  cleanupControlledMailbox,
  controlledMessages,
  deliverControlledMessage,
  prepareControlledMessage,
  withControlledImap,
} from "../support/smtp-controlled-fixture";
import { controlledWorker } from "../support/smtp-controlled-process";

const { testUrl } = resolveDatabaseUrls(process.env);
// Own the synthetic credentials in this isolated Vitest worker, including the
// environment inherited by the real child processes. Never depend on a local
// operator's provider selection or encryption keyring to run this fixture.
vi.stubEnv("AI_PROVIDER", "mock");
vi.stubEnv("MAIL_PROVIDER", "mock");
vi.stubEnv("WORKFLOW_PROVIDER", "mock");
vi.stubEnv("TOKEN_ENCRYPTION_ACTIVE_KEY_ID", "controlled-recovery");
vi.stubEnv(
  "TOKEN_ENCRYPTION_KEYS",
  `controlled-recovery:${randomBytes(32).toString("base64")}`,
);
vi.stubEnv("TEST_DATABASE_URL", testUrl);
vi.stubEnv("NODE_TLS_REJECT_UNAUTHORIZED", "0");
assertControlledDatabase(testUrl);
const client = postgres(testUrl, { max: 4, onnotice: () => {} });
const db = drizzle(client, { schema });
const ownedMailboxes = new Set<string>();
async function fixture() {
  return prepareControlledMessage(db, ownedMailboxes);
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const key = (f: Fixture) =>
  outreachMessageId(f.outreachId, f.operator.split("@")[1]!);
async function send(f: Fixture) {
  const provider = await createMailProviderForMailbox(db, f.mailboxId, {
    environment: process.env,
  });
  const result = await sendApprovedMessage(db, provider, {
    messageId: f.messageId,
  });
  expect(result).toMatchObject({ ok: true, disposition: "sent" });
  return result;
}
async function row(f: Fixture) {
  const [message] = await db
    .select()
    .from(schema.messages)
    .where(eq(schema.messages.id, f.messageId));
  assert.ok(message);
  return message;
}
async function mailbox(f: Fixture) {
  const [value] = await db
    .select()
    .from(schema.mailboxConnections)
    .where(eq(schema.mailboxConnections.id, f.mailboxId));
  assert.ok(value);
  return value;
}

describe("controlled real SMTP/IMAP recovery across process boundaries", () => {
  beforeAll(async () => {
    // Required dependency: deliberately fail if GreenMail is absent, never skip.
    await withControlledImap("readiness@controlled.test", async (imap) => {
      await imap.mailboxOpen("INBOX");
    });
    await client.unsafe("drop schema if exists public cascade");
    await client.unsafe("drop schema if exists drizzle cascade");
    await client.unsafe("create schema public");
    await migrate(drizzle(client), { migrationsFolder: "drizzle" });
  });
  afterAll(async () => {
    const failures: unknown[] = [];
    try {
      for (const email of ownedMailboxes) {
        try {
          await cleanupControlledMailbox(email);
        } catch (error) {
          failures.push(error);
        }
      }
      try {
        await client.end({ timeout: 5 });
      } catch (error) {
        failures.push(error);
      }
    } finally {
      vi.unstubAllEnvs();
    }
    if (failures.length)
      throw new AggregateError(failures, "Controlled recovery cleanup failed");
  });

  it("finalizes a SIGKILL after durable SMTP acceptance in a fresh process without a second delivery", async () => {
    const f = await fixture();
    let acceptedAttemptToken: string | null = null;
    await controlledWorker("after-acceptance", f.messageId, async (packet) => {
      expect(packet.boundary).toBe("after-acceptance");
      expect(packet.messageKey).toBe(key(f));
      expect(
        await new WorkflowEventsSendJournal(db).hasAcceptance(key(f)),
      ).toBe(true);
      acceptedAttemptToken = (await row(f)).sendAttemptToken;
      expect(acceptedAttemptToken).toBeTruthy();
      expect(await row(f)).toMatchObject({
        status: "sending",
        attemptCount: 1,
      });
      expect(
        await controlledMessages(f.recipient, "INBOX", key(f)),
      ).toHaveLength(1);
      expect(
        await controlledMessages(f.operator, "Drafts", key(f)),
      ).toHaveLength(1);
      expect(await controlledMessages(f.operator, "Sent", key(f))).toHaveLength(
        0,
      );
    });
    expect(
      (await controlledWorker("recover-stale", f.messageId)).workflow,
    ).toMatchObject({
      messagesRecovered: [
        { ok: true, disposition: "sent", message: { id: f.messageId } },
      ],
    });
    expect((await controlledWorker("reconcile", f.messageId)).result?.ok).toBe(
      true,
    );
    expect(await row(f)).toMatchObject({
      status: "sent",
      attemptCount: 1,
      sendAttemptToken: acceptedAttemptToken,
    });
    expect(await controlledMessages(f.recipient, "INBOX", key(f))).toHaveLength(
      1,
    );
    expect(await controlledMessages(f.operator, "Sent", key(f))).toHaveLength(
      1,
    );
    expect(await controlledMessages(f.operator, "Drafts", key(f))).toHaveLength(
      0,
    );
  }, 30000);

  it("keeps an SMTP-accepted send uncertain after SIGKILL before its acceptance journal commit", async () => {
    const f = await fixture();
    await controlledWorker("before-acceptance", f.messageId, async (packet) => {
      expect(packet.boundary).toBe("before-acceptance");
      const journal = new WorkflowEventsSendJournal(db);
      expect(await journal.hasAttempt(key(f))).toBe(true);
      expect(await journal.hasAcceptance(key(f))).toBe(false);
      expect(
        await controlledMessages(f.recipient, "INBOX", key(f)),
      ).toHaveLength(1);
    });
    for (let attempt = 0; attempt < 2; attempt++)
      expect(
        (await controlledWorker("reconcile", f.messageId)).result,
      ).toMatchObject({ ok: false, code: "DELIVERY_UNCERTAIN" });
    expect(await row(f)).toMatchObject({
      status: "delivery_uncertain",
      attemptCount: 1,
    });
    expect(await controlledMessages(f.recipient, "INBOX", key(f))).toHaveLength(
      1,
    );
    expect(await controlledMessages(f.operator, "Sent", key(f))).toHaveLength(
      0,
    );
  }, 30000);

  it.each([
    {
      kind: "hard",
      action: "failed",
      status: "5.1.1",
      state: "bounced",
      suppression: "hard_bounce",
    },
    {
      kind: "soft",
      action: "failed",
      status: "4.2.2",
      state: "manual_review",
      suppression: null,
    },
    {
      kind: "delayed",
      action: "delayed",
      status: "4.2.0",
      state: "sent",
      suppression: null,
    },
    {
      kind: "unsubscribe",
      action: "",
      status: "",
      state: "opted_out",
      suppression: "unsubscribe",
    },
  ])(
    "processes a real SMTP-delivered $kind reply and repeated inbox sweeps idempotently",
    async (scenario) => {
      const f = await fixture();
      await send(f);
      const [before] = await db
        .select()
        .from(schema.enrollments)
        .where(eq(schema.enrollments.id, f.enrollmentId));
      assert.ok(before);
      const id = `<inbound-${randomUUID()}@controlled.test>`;
      const sender =
        scenario.kind === "unsubscribe"
          ? f.recipient
          : "mailer-daemon@controlled.test";
      const raw =
        scenario.kind === "unsubscribe"
          ? [
              `From: ${sender}`,
              `To: ${f.operator}`,
              `Message-ID: ${id}`,
              `In-Reply-To: ${key(f)}`,
              `References: ${key(f)}`,
              "Subject: Please unsubscribe me",
              "MIME-Version: 1.0",
              "Content-Type: text/plain; charset=utf-8",
              "",
              "Please stop emailing me and remove me from your list.",
            ].join("\r\n")
          : [
              `From: ${sender}`,
              `To: ${f.operator}`,
              `Message-ID: ${id}`,
              "Subject: Delivery status",
              "MIME-Version: 1.0",
              'Content-Type: multipart/report; report-type=delivery-status; boundary="controlled-dsn"',
              "",
              "--controlled-dsn",
              "Content-Type: text/plain; charset=utf-8",
              "",
              "Controlled delivery report.",
              "--controlled-dsn",
              "Content-Type: message/delivery-status",
              "",
              "Reporting-MTA: dns; controlled.test",
              "",
              `Final-Recipient: rfc822; ${f.recipient}`,
              `Action: ${scenario.action}`,
              `Status: ${scenario.status}`,
              "--controlled-dsn",
              "Content-Type: message/rfc822",
              "",
              `From: ${f.operator}`,
              `To: ${f.recipient}`,
              `Message-ID: ${key(f)}`,
              `X-Outreach-ID: ${f.outreachId}`,
              "Subject: Original message",
              "",
              f.body,
              "--controlled-dsn--",
              "",
            ].join("\r\n");
      await deliverControlledMessage(sender, f.operator, raw);
      const deliveredSources = await controlledMessages(
        f.operator,
        "INBOX",
        id,
      );
      expect(deliveredSources).toHaveLength(1);
      const deliveredSource = deliveredSources[0];
      assert.ok(deliveredSource);
      const services = createWorkflowTaskServices(db, process.env);
      await services["reconcile-inbound-mailbox"]({ mailboxId: f.mailboxId });
      const cursor = (await mailbox(f)).syncCursor;
      expect(cursor).toBeTruthy();
      // Replay the exact delivered bytes under a second UID. A second SMTP
      // transaction adds different Received headers and is a distinct message.
      const replay = await withControlledImap(f.operator, async (imap) => {
        return imap.append("INBOX", deliveredSource);
      });
      assert.ok(replay && replay.uid && replay.uidValidity);
      expect(await controlledMessages(f.operator, "INBOX", id)).toEqual([
        deliveredSource,
        deliveredSource,
      ]);
      await services["reconcile-inbound-mailbox"]({ mailboxId: f.mailboxId });
      expect((await mailbox(f)).syncCursor).toBe(
        `${replay.uidValidity}:${replay.uid}`,
      );
      expect((await mailbox(f)).syncCursor).not.toBe(cursor);
      await services["reconcile-inbound-mailbox"]({ mailboxId: f.mailboxId });
      const replies = await db
        .select()
        .from(schema.replies)
        .where(eq(schema.replies.messageId, f.messageId));
      expect(replies).toHaveLength(1);
      expect(replies[0]).toMatchObject({
        classification:
          scenario.kind === "unsubscribe" ? "unsubscribe" : "bounce",
        bounceKind: scenario.kind === "unsubscribe" ? null : scenario.kind,
      });
      const [enrollment] = await db
        .select()
        .from(schema.enrollments)
        .where(eq(schema.enrollments.id, f.enrollmentId));
      assert.ok(enrollment);
      expect(enrollment.state).toBe(
        scenario.kind === "delayed" ? before.state : scenario.state,
      );
      if (scenario.kind === "delayed")
        expect(enrollment.nextActionAt).toEqual(before.nextActionAt);
      else expect(enrollment.nextActionAt).toBeNull();
      const suppressed = await db
        .select()
        .from(schema.suppressionEntries)
        .where(eq(schema.suppressionEntries.normalizedValue, f.recipient));
      expect(suppressed).toHaveLength(scenario.suppression ? 1 : 0);
      if (scenario.suppression) {
        assert.ok(suppressed[0]);
        expect(suppressed[0].reason).toBe(scenario.suppression);
      }
      expect(
        await db
          .select()
          .from(schema.suppressionEntries)
          .where(
            eq(
              schema.suppressionEntries.normalizedValue,
              "mailer-daemon@controlled.test",
            ),
          ),
      ).toHaveLength(0);
      expect(
        await controlledMessages(f.recipient, "INBOX", key(f)),
      ).toHaveLength(1);
    },
    30000,
  );

  it("ingests an opt-out that arrives over SMTP while the IMAP endpoint is down", async () => {
    const f = await fixture();
    await send(f);
    const original = await mailbox(f);
    const transport = readTransport(original.settings);
    assert.ok(transport);
    const sockets = new Set<net.Socket>();
    const proxy = net.createServer((socket) => {
      const upstream = net.connect(3993, "127.0.0.1");
      sockets.add(socket);
      sockets.add(upstream);
      socket.pipe(upstream).pipe(socket);
      socket.on("error", () => upstream.destroy());
      upstream.on("error", () => socket.destroy());
      socket.on("close", () => {
        sockets.delete(socket);
        upstream.destroy();
      });
      upstream.on("close", () => {
        sockets.delete(upstream);
        socket.destroy();
      });
    });
    await new Promise<void>((resolve, reject) => {
      proxy.once("error", reject);
      proxy.listen(3105, "127.0.0.1", resolve);
    });
    await new Promise<void>((resolve) => proxy.close(() => resolve()));
    try {
      await db
        .update(schema.mailboxConnections)
        .set({
          settings: writeTransport(original.settings, {
            ...transport,
            imap: { ...transport.imap, port: 3105 },
          }),
        })
        .where(eq(schema.mailboxConnections.id, f.mailboxId));
      const services = createWorkflowTaskServices(db, process.env);
      await expect(
        services["reconcile-inbound-mailbox"]({ mailboxId: f.mailboxId }),
      ).rejects.toThrow();
      const id = `<offline-${randomUUID()}@controlled.test>`;
      await deliverControlledMessage(
        f.recipient,
        f.operator,
        [
          `From: ${f.recipient}`,
          `To: ${f.operator}`,
          `Message-ID: ${id}`,
          `In-Reply-To: ${key(f)}`,
          "Subject: Unsubscribe",
          "MIME-Version: 1.0",
          "Content-Type: text/plain; charset=utf-8",
          "",
          "Please stop emailing me.",
        ].join("\r\n"),
      );
      expect(await controlledMessages(f.operator, "INBOX", id)).toHaveLength(1);
      expect((await mailbox(f)).syncCursor).toBe(original.syncCursor);
      expect(
        await db
          .select()
          .from(schema.replies)
          .where(eq(schema.replies.messageId, f.messageId)),
      ).toHaveLength(0);
      await new Promise<void>((resolve, reject) => {
        proxy.once("error", reject);
        proxy.listen(3105, "127.0.0.1", resolve);
      });
      await services["reconcile-inbound-mailbox"]({ mailboxId: f.mailboxId });
      expect((await mailbox(f)).syncCursor).not.toBe(original.syncCursor);
      await services["reconcile-inbound-mailbox"]({ mailboxId: f.mailboxId });
      const replies = await db
        .select()
        .from(schema.replies)
        .where(eq(schema.replies.messageId, f.messageId));
      expect(replies).toHaveLength(1);
      expect(replies[0]).toMatchObject({ classification: "unsubscribe" });
      const [enrollment] = await db
        .select()
        .from(schema.enrollments)
        .where(eq(schema.enrollments.id, f.enrollmentId));
      expect(enrollment).toMatchObject({
        state: "opted_out",
        nextActionAt: null,
      });
      expect(
        await controlledMessages(f.recipient, "INBOX", key(f)),
      ).toHaveLength(1);
    } finally {
      for (const socket of sockets) socket.destroy();
      try {
        if (proxy.listening)
          await new Promise<void>((resolve, reject) =>
            proxy.close((error) => (error ? reject(error) : resolve())),
          );
      } finally {
        await db
          .update(schema.mailboxConnections)
          .set({ settings: original.settings })
          .where(eq(schema.mailboxConnections.id, f.mailboxId));
      }
    }
  }, 30000);

  it("blocks sends while IMAP is unavailable and restores the send gate through the same endpoint", async () => {
    const f = await fixture();
    const original = await mailbox(f);
    const transport = readTransport(original.settings);
    assert.ok(transport);
    const sockets = new Set<net.Socket>();
    const proxy = net.createServer((socket) => {
      const upstream = net.connect(3993, "127.0.0.1");
      sockets.add(socket);
      sockets.add(upstream);
      socket.pipe(upstream).pipe(socket);
      socket.on("error", () => upstream.destroy());
      upstream.on("error", () => socket.destroy());
      socket.on("close", () => {
        sockets.delete(socket);
        upstream.destroy();
      });
      upstream.on("close", () => {
        sockets.delete(upstream);
        socket.destroy();
      });
    });
    // Reserve/check the owned endpoint before using it as the failed target.
    await new Promise<void>((resolve, reject) => {
      proxy.once("error", reject);
      proxy.listen(3105, "127.0.0.1", resolve);
    });
    await new Promise<void>((resolve, reject) =>
      proxy.close((error) => (error ? reject(error) : resolve())),
    );
    try {
      await db
        .update(schema.mailboxConnections)
        .set({
          settings: writeTransport(original.settings, {
            ...transport,
            imap: { ...transport.imap, port: 3105 },
          }),
        })
        .where(eq(schema.mailboxConnections.id, f.mailboxId));
      const services = createWorkflowTaskServices(db, process.env);
      await expect(
        services["reconcile-inbound-mailbox"]({ mailboxId: f.mailboxId }),
      ).rejects.toThrow();
      expect((await mailbox(f)).syncCursor).toBe(original.syncCursor);
      const [health] = await db
        .select()
        .from(schema.workflowEvents)
        .where(
          eq(
            schema.workflowEvents.idempotencyKey,
            defaultInboundNaming("smtp_imap", f.mailboxId).healthKey,
          ),
        );
      assert.ok(health);
      expect(health.status).toBe("failed");
      const provider = await createMailProviderForMailbox(db, f.mailboxId, {
        environment: process.env,
      });
      expect(
        await sendApprovedMessage(db, provider, { messageId: f.messageId }),
      ).toMatchObject({ ok: false, code: "REPLY_PENDING" });
      expect(
        await controlledMessages(f.recipient, "INBOX", key(f)),
      ).toHaveLength(0);
      await new Promise<void>((resolve, reject) => {
        proxy.once("error", reject);
        proxy.listen(3105, "127.0.0.1", resolve);
      });
      await services["reconcile-inbound-mailbox"]({ mailboxId: f.mailboxId });
      const [healthy] = await db
        .select()
        .from(schema.workflowEvents)
        .where(
          eq(
            schema.workflowEvents.idempotencyKey,
            defaultInboundNaming("smtp_imap", f.mailboxId).healthKey,
          ),
        );
      assert.ok(healthy);
      expect(healthy.status).toBe("succeeded");
      await send(f);
      expect(
        await controlledMessages(f.recipient, "INBOX", key(f)),
      ).toHaveLength(1);
    } finally {
      for (const socket of sockets) socket.destroy();
      try {
        if (proxy.listening)
          await new Promise<void>((resolve, reject) =>
            proxy.close((error) => (error ? reject(error) : resolve())),
          );
      } finally {
        await db
          .update(schema.mailboxConnections)
          .set({ settings: original.settings })
          .where(eq(schema.mailboxConnections.id, f.mailboxId));
      }
    }
  }, 30000);
});

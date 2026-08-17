import { desc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import * as schema from "@/lib/db/schema";
import { resolveDatabaseUrls } from "@/lib/db/test-database";

// `route.ts` reaches `@/lib/db/client`, which imports the real `server-only`
// package — an unconditional throw outside a Next.js react-server bundle. The
// same shadowing trick the other route tests use.
vi.mock("server-only", () => ({}));

/**
 * `after` throws outside a request scope, and this suite drives the handler
 * directly rather than through a server. Capturing the callback instead of
 * running it is also what makes the assertion meaningful: the point of the kick
 * is that it is scheduled *after* the operator's response, so the test holds it
 * and runs it itself.
 *
 * Spread over the real module: the route's graph imports other things from
 * `next/server`, and replacing it wholesale would break them.
 */
const scheduled: Array<() => Promise<unknown>> = [];
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  after: (task: () => Promise<unknown>) => {
    scheduled.push(task);
  },
}));

/** The cycle itself is not under test here — only that one was asked for. */
const dispatch = vi.fn(
  async (request: { task: string; idempotencyKey: string }) => ({
    runId: `run_${request.task}`,
    duplicate: false,
  }),
);
vi.mock("@/modules/workflows/dispatcher-factory", () => ({
  createWorkflowDispatcher: () => ({ dispatch }),
}));

const { testUrl } = resolveDatabaseUrls(process.env);
const client = postgres(testUrl, { max: 4 });
const db = drizzle(client, { schema });

// Set before the route is imported: `getDatabase()` reads `DATABASE_URL` when
// it first opens a connection.
process.env.DATABASE_URL = testUrl;
process.env.OPERATOR_EMAIL = "operator@kick.example";
process.env.OPERATOR_PASSWORD = "at-least-twelve-characters";
process.env.SESSION_SECRET = "k".repeat(32);

const { POST } = await import("@/app/api/operator/commands/[command]/route");
const { createOperatorSession, OPERATOR_SESSION_COOKIE } =
  await import("@/lib/operator-auth");

type Click = { status: number; notice: string | null };

async function click(
  command: string,
  fields: Record<string, string>,
): Promise<Click> {
  const { token, session } = createOperatorSession(process.env);
  const formData = new FormData();
  formData.set("csrf", session.csrfToken);
  for (const [key, value] of Object.entries(fields)) formData.set(key, value);
  const response = await POST(
    new Request(`http://operator.local/api/operator/commands/${command}`, {
      method: "POST",
      body: formData,
      headers: { cookie: `${OPERATOR_SESSION_COOKIE}=${token}` },
    }),
    { params: Promise.resolve({ command }) },
  );
  const location = response.headers.get("location");
  return {
    status: response.status,
    notice: location
      ? new URL(location, "http://operator.local").searchParams.get("notice")
      : null,
  };
}

/** Runs what the response scheduled, which is what the server would do. */
async function drainScheduled(): Promise<void> {
  const tasks = scheduled.splice(0, scheduled.length);
  for (const task of tasks) await task();
}

function requestedCycles(): string[] {
  return dispatch.mock.calls.map(([request]) => request.idempotencyKey);
}

let previousProvider: string | undefined;
let previousMaintenance: string | undefined;

beforeEach(() => {
  previousProvider = process.env.WORKFLOW_PROVIDER;
  previousMaintenance = process.env.LOCAL_MAINTENANCE_ENABLED;
  delete process.env.WORKFLOW_PROVIDER;
  delete process.env.LOCAL_MAINTENANCE_ENABLED;
  scheduled.length = 0;
  dispatch.mockClear();
});

afterEach(() => {
  if (previousProvider === undefined) delete process.env.WORKFLOW_PROVIDER;
  else process.env.WORKFLOW_PROVIDER = previousProvider;
  if (previousMaintenance === undefined) {
    delete process.env.LOCAL_MAINTENANCE_ENABLED;
  } else process.env.LOCAL_MAINTENANCE_ENABLED = previousMaintenance;
});

afterAll(async () => {
  await client.end({ timeout: 5 });
});

describe("queued operator work asks for a maintenance pass", () => {
  it("schedules one immediate cycle after the page is handed back", async () => {
    const result = await click("discover-accounts", {
      icp: "European software companies with a public engineering blog",
      limit: "3",
    });

    expect(result.status).toBe(303);
    expect(result.notice).toBe(
      "Account discovery queued — it starts as soon as the maintenance pass is free",
    );
    // Scheduled, not run: the operator's redirect must not wait on a cycle
    // that can hold the ChatGPT window for ten minutes.
    expect(dispatch).not.toHaveBeenCalled();
    expect(scheduled).toHaveLength(1);

    await drainScheduled();

    expect(dispatch).toHaveBeenCalledOnce();
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ task: "maintenance-cycle" }),
    );
    // The on-demand key, not the minute key: a cycle asked for inside a minute
    // the worker already used must not deduplicate into a silent no-op.
    expect(requestedCycles()[0]).toMatch(/^maintenance:cycle:immediate:/);
  });

  it("asks again when the same work is queued twice", async () => {
    const shared = {
      icp: "Seed-stage fintech",
      requestToken: crypto.randomUUID(),
    };

    await click("discover-accounts", shared);
    const second = await click("discover-accounts", shared);

    expect(second.notice).toBe("Account discovery is already queued");
    await drainScheduled();
    // Two presses, two requests. The second row was a duplicate; the request is
    // not, because the pass it asks for may be the one that lifts a wait.
    expect(requestedCycles()).toHaveLength(2);
    expect(new Set(requestedCycles()).size).toBe(2);
  });

  it("asks for nothing when the command was rejected", async () => {
    const result = await click("discover-accounts", { limit: "3" });

    expect(result.notice).toBe("ICP is required");
    expect(scheduled).toHaveLength(0);
  });

  it("asks again for a command the operator retries", async () => {
    const [abandoned] = await db
      .insert(schema.operatorCommands)
      .values({
        command: "research-account",
        task: "account-research",
        payload: { accountId: crypto.randomUUID() },
        requestedBy: "operator",
        status: "abandoned",
        error: "NOT_FOUND",
        dedupeKey: `retry-kick:${crypto.randomUUID()}`,
      })
      .returning();

    const result = await click("retry-command", { commandId: abandoned!.id });

    expect(result.notice).toBe(
      "Queued again — it starts as soon as the maintenance pass is free",
    );
    await drainScheduled();
    expect(dispatch).toHaveBeenCalledOnce();
  });

  it("asks for nothing when there was no command to retry", async () => {
    const result = await click("retry-command", {
      commandId: crypto.randomUUID(),
    });

    expect(result.notice).toBe("That command is not waiting for a retry");
    expect(scheduled).toHaveLength(0);
  });

  // A failing cycle is the maintenance area's own problem to report: it writes
  // its failure to `maintenance_state`, which "What goes out" reads. Letting it
  // escape here would only add an unhandled rejection to a request that
  // succeeded.
  it("survives a cycle that fails", async () => {
    dispatch.mockRejectedValueOnce(new Error("Workflow task failed"));

    const result = await click("discover-accounts", { icp: "Anything" });

    expect(result.status).toBe(303);
    await expect(drainScheduled()).resolves.toBeUndefined();
  });

  describe("declines to start a pass the installation did not ask for", () => {
    it("stays out of the way when the operator drives its own cycles", async () => {
      process.env.LOCAL_MAINTENANCE_ENABLED = "false";

      await click("discover-accounts", { icp: "Anything" });

      expect(scheduled).toHaveLength(0);
    });

    // The scheduled task reads `payload.timestamp`, which only the Trigger
    // scheduler sends. A cycle asked for from here would arrive unreadable.
    it("leaves the schedule to Trigger when Trigger owns it", async () => {
      process.env.WORKFLOW_PROVIDER = "trigger";

      await click("discover-accounts", { icp: "Anything" });

      expect(scheduled).toHaveLength(0);
    });

    // Asking is an optimisation on top of a durable row. A misconfiguration
    // that stops it must cost the operator a minute of latency, not a notice
    // telling them their work was refused when it is sitting in the queue.
    it("still queues the work when it cannot even ask", async () => {
      process.env.WORKFLOW_PROVIDER = "not-a-provider";

      const result = await click("discover-accounts", { icp: "Anything" });

      expect(result.notice).toBe(
        "Account discovery queued — it starts as soon as the maintenance pass is free",
      );
      expect(scheduled).toHaveLength(0);
      const [row] = await db
        .select({ id: schema.operatorCommands.id })
        .from(schema.operatorCommands)
        .where(eq(schema.operatorCommands.command, "discover-accounts"))
        .orderBy(desc(schema.operatorCommands.createdAt))
        .limit(1);
      expect(row).toBeDefined();
    });
  });

  it("records the work it asked a pass to run", async () => {
    await click("resolve-email", { contactId: crypto.randomUUID() });

    const [row] = await db
      .select({ command: schema.operatorCommands.command })
      .from(schema.operatorCommands)
      .where(eq(schema.operatorCommands.command, "resolve-email"))
      .orderBy(desc(schema.operatorCommands.createdAt))
      .limit(1);
    expect(row?.command).toBe("resolve-email");
    expect(scheduled).toHaveLength(1);
  });
});

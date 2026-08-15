import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { afterEach, describe, expect, it, vi } from "vitest";

// The production runtime intentionally remains dependency-free Node ESM.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore -- the runtime is JavaScript by design
import * as localMaintenanceRuntime from "../../scripts/local-maintenance-runtime.mjs";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore -- the worker is JavaScript by design
import { createLocalMaintenanceWorker } from "../../scripts/local-maintenance-worker.mjs";

const {
  LocalMaintenanceConfigurationError,
  loadAndResolveLocalMaintenanceConfig,
  resolveLocalMaintenanceConfig,
} = localMaintenanceRuntime;

const TOKEN = "a-valid-operator-api-token-with-32-characters";
const execFileAsync = promisify(execFile);

function enabledConfig(overrides: Record<string, unknown> = {}) {
  return {
    mode: "enabled",
    provider: "local",
    token: TOKEN,
    port: 3000,
    baseUrl: "http://127.0.0.1:3000",
    healthUrl: "http://127.0.0.1:3000/api/health",
    maintenanceUrl: "http://127.0.0.1:3000/api/internal/workflows/reconcile",
    intervalMs: 60_000,
    requestTimeoutMs: 840_000,
    shutdownGraceMs: 30_000,
    healthRetryIntervalMs: 1_000,
    healthWaitTimeoutMs: 120_000,
    ...overrides,
  };
}

function response(status: number): Response {
  return new Response(null, { status });
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("local maintenance preflight", () => {
  it.each([
    ["development", true, "http://development.example"],
    ["production", false, "http://production.example"],
  ] as const)(
    "loads the %s mode env instead of .env.test when launched with NODE_ENV=test",
    async (_mode, dev, expectedBaseUrl) => {
      const projectDir = await mkdtemp(join(tmpdir(), "maintenance-mode-env-"));
      await Promise.all([
        writeFile(
          join(projectDir, ".env"),
          ["WORKFLOW_PROVIDER=local", `OPERATOR_API_TOKEN=${TOKEN}`].join("\n"),
        ),
        writeFile(
          join(projectDir, ".env.development"),
          "LOCAL_MAINTENANCE_BASE_URL=http://development.example",
        ),
        writeFile(
          join(projectDir, ".env.production"),
          "LOCAL_MAINTENANCE_BASE_URL=http://production.example",
        ),
        writeFile(
          join(projectDir, ".env.test"),
          "LOCAL_MAINTENANCE_BASE_URL=http://test.example",
        ),
      ]);
      const childEnvironment: NodeJS.ProcessEnv = {
        ...process.env,
        NODE_ENV: "test",
      };
      delete childEnvironment.OPERATOR_API_TOKEN;
      delete childEnvironment.LOCAL_MAINTENANCE_BASE_URL;
      delete childEnvironment.WORKFLOW_PROVIDER;
      delete childEnvironment.__NEXT_PROCESSED_ENV;

      try {
        const runtimeUrl = pathToFileURL(
          join(process.cwd(), "scripts/local-maintenance-runtime.mjs"),
        ).href;
        const { stdout } = await execFileAsync(
          process.execPath,
          [
            "--input-type=module",
            "-e",
            `import { loadAndResolveLocalMaintenanceConfig } from ${JSON.stringify(runtimeUrl)};
const config = loadAndResolveLocalMaintenanceConfig({ projectDir: ${JSON.stringify(projectDir)}, dev: ${JSON.stringify(dev)} });
console.log(JSON.stringify({ baseUrl: config.baseUrl, nodeEnvironment: process.env.NODE_ENV }));`,
          ],
          { cwd: process.cwd(), env: childEnvironment, encoding: "utf8" },
        );

        expect(JSON.parse(stdout)).toEqual({
          baseUrl: expectedBaseUrl,
          nodeEnvironment: "test",
        });
      } finally {
        await rm(projectDir, { recursive: true, force: true });
      }
    },
  );

  it("loads .env.local before validation but never takes PORT from an env file", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "maintenance-env-"));
    await writeFile(
      join(projectDir, ".env.local"),
      [
        "WORKFLOW_PROVIDER=local",
        `OPERATOR_API_TOKEN=${TOKEN}`,
        "PORT=4555",
        "LOCAL_MAINTENANCE_BASE_URL=http://localhost:4777",
      ].join("\n"),
    );
    const childEnvironment: NodeJS.ProcessEnv = {
      ...process.env,
      NODE_ENV: "development",
    };
    delete childEnvironment.PORT;
    delete childEnvironment.OPERATOR_API_TOKEN;
    delete childEnvironment.LOCAL_MAINTENANCE_BASE_URL;
    delete childEnvironment.__NEXT_PROCESSED_ENV;

    try {
      const runtimeUrl = pathToFileURL(
        join(process.cwd(), "scripts/local-maintenance-runtime.mjs"),
      ).href;
      const { stdout } = await execFileAsync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `import { loadAndResolveLocalMaintenanceConfig } from ${JSON.stringify(runtimeUrl)};
const config = loadAndResolveLocalMaintenanceConfig({ projectDir: ${JSON.stringify(projectDir)}, dev: true });
console.log(JSON.stringify({ config, token: process.env.OPERATOR_API_TOKEN, port: process.env.PORT }));`,
        ],
        { cwd: process.cwd(), env: childEnvironment, encoding: "utf8" },
      );
      const result = JSON.parse(stdout);

      expect(result.config).toMatchObject({
        mode: "enabled",
        port: 3000,
        baseUrl: "http://localhost:4777",
      });
      expect(result.token).toBe(TOKEN);
      expect(result.port).toBeUndefined();
    } finally {
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  it("preserves only a PORT supplied by the launching process", () => {
    const environment: Record<string, string | undefined> = {
      PORT: "4100",
    };
    const loadEnvConfig = vi.fn(() => {
      environment.PORT = "4555";
      environment.WORKFLOW_PROVIDER = "local";
      environment.OPERATOR_API_TOKEN = TOKEN;
    });

    const config = loadAndResolveLocalMaintenanceConfig({
      environment,
      loadEnvConfig,
    });

    expect(loadEnvConfig).toHaveBeenCalledOnce();
    expect(config.port).toBe(4100);
    expect(config.baseUrl).toBe("http://127.0.0.1:4100");
    expect(environment.PORT).toBe("4100");
  });

  it.each([undefined, "too-short"])(
    "fails once with an actionable error for an invalid enabled token (%s)",
    (token) => {
      expect(() =>
        resolveLocalMaintenanceConfig({
          WORKFLOW_PROVIDER: "local",
          OPERATOR_API_TOKEN: token,
        }),
      ).toThrowError(
        new LocalMaintenanceConfigurationError(
          "OPERATOR_API_TOKEN must contain at least 32 characters when local maintenance is enabled",
        ),
      );
    },
  );

  it.each([
    [{ WORKFLOW_PROVIDER: "trigger" }, "trigger"],
    [
      {
        WORKFLOW_PROVIDER: "local",
        LOCAL_MAINTENANCE_ENABLED: "false",
      },
      "explicit",
    ],
  ] as const)("disables polling for %j", (environment, reason) => {
    expect(resolveLocalMaintenanceConfig(environment)).toMatchObject({
      mode: "disabled",
      reason,
    });
  });

  it.each(["0", "65536", "1.5", "not-a-port"])(
    "rejects invalid launch PORT=%s",
    (port) => {
      expect(() =>
        resolveLocalMaintenanceConfig({
          WORKFLOW_PROVIDER: "local",
          LOCAL_MAINTENANCE_ENABLED: "false",
          PORT: port,
        }),
      ).toThrowError(/PORT must be an integer between 1 and 65535/);
    },
  );

  it("derives fixed endpoints from the default or explicit HTTP(S) origin", () => {
    expect(
      resolveLocalMaintenanceConfig({
        WORKFLOW_PROVIDER: "mock",
        OPERATOR_API_TOKEN: TOKEN,
        PORT: "4310",
      }),
    ).toMatchObject({
      provider: "local",
      baseUrl: "http://127.0.0.1:4310",
      healthUrl: "http://127.0.0.1:4310/api/health",
      maintenanceUrl: "http://127.0.0.1:4310/api/internal/workflows/reconcile",
    });

    expect(
      resolveLocalMaintenanceConfig({
        WORKFLOW_PROVIDER: "local",
        OPERATOR_API_TOKEN: TOKEN,
        LOCAL_MAINTENANCE_BASE_URL: "https://internal.example/proxy?q=x",
      }),
    ).toMatchObject({
      baseUrl: "https://internal.example",
      healthUrl: "https://internal.example/api/health",
      maintenanceUrl:
        "https://internal.example/api/internal/workflows/reconcile",
    });

    expect(() =>
      resolveLocalMaintenanceConfig({
        WORKFLOW_PROVIDER: "local",
        OPERATOR_API_TOKEN: TOKEN,
        LOCAL_MAINTENANCE_BASE_URL: "ftp://internal.example",
      }),
    ).toThrowError(/absolute HTTP\(S\) URL/);
  });

  it("uses the shared timing contract and a research-aware request timeout", () => {
    expect(
      resolveLocalMaintenanceConfig({
        WORKFLOW_PROVIDER: "local",
        OPERATOR_API_TOKEN: TOKEN,
      }),
    ).toMatchObject({
      intervalMs: 60_000,
      heartbeatIntervalMs: 30_000,
      staleLeaseMs: 120_000,
      requestTimeoutMs: 840_000,
      shutdownGraceMs: 30_000,
    });
    expect(
      resolveLocalMaintenanceConfig({
        WORKFLOW_PROVIDER: "local",
        OPERATOR_API_TOKEN: TOKEN,
        AI_RESEARCH_TIMEOUT_MS: "900000",
      }).requestTimeoutMs,
    ).toBe(960_000);
  });
});

describe("local maintenance worker", () => {
  it("waits for a healthy application before offering its immediate cycle", async () => {
    vi.useFakeTimers();
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      calls.push(url);
      if (url.endsWith("/api/health") && calls.length === 1) {
        return response(503);
      }
      return response(url.endsWith("/api/health") ? 200 : 202);
    });
    const worker = createLocalMaintenanceWorker({
      config: enabledConfig(),
      fetchImpl,
      logger: { info: vi.fn(), error: vi.fn() },
    });

    const starting = worker.start();
    await vi.advanceTimersByTimeAsync(999);
    expect(calls).toEqual(["http://127.0.0.1:3000/api/health"]);
    await vi.advanceTimersByTimeAsync(1);
    await starting;
    await vi.waitFor(() => expect(calls).toHaveLength(3));

    expect(calls).toEqual([
      "http://127.0.0.1:3000/api/health",
      "http://127.0.0.1:3000/api/health",
      "http://127.0.0.1:3000/api/internal/workflows/reconcile",
    ]);
    await worker.stop();
  });

  it("fails a bounded health wait instead of polling forever", async () => {
    vi.useFakeTimers();
    const worker = createLocalMaintenanceWorker({
      config: enabledConfig({ healthWaitTimeoutMs: 2_000 }),
      fetchImpl: vi.fn(async () => response(503)),
      logger: { info: vi.fn(), error: vi.fn() },
    });

    const starting = worker.start();
    const expected = expect(starting).rejects.toThrowError(
      /application health check did not succeed within 2000ms/i,
    );
    await vi.advanceTimersByTimeAsync(2_000);
    await expected;
  });

  it("makes the next minute a neutral busy no-op while a long cycle is active", async () => {
    vi.useFakeTimers();
    let releaseFirstCycle!: () => void;
    let active = 0;
    let maximumConcurrency = 0;
    let cycleCount = 0;
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      if (String(input).endsWith("/api/health")) return response(200);
      cycleCount += 1;
      active += 1;
      maximumConcurrency = Math.max(maximumConcurrency, active);
      if (cycleCount === 1) {
        await new Promise<void>((resolve) => {
          releaseFirstCycle = resolve;
        });
      }
      active -= 1;
      return response(202);
    });
    const logger = { info: vi.fn(), error: vi.fn() };
    const worker = createLocalMaintenanceWorker({
      config: enabledConfig(),
      fetchImpl,
      logger,
    });

    await worker.start();
    await vi.waitFor(() => expect(cycleCount).toBe(1));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await worker.offerTick()).toEqual({ outcome: "busy" });
    expect(cycleCount).toBe(1);
    expect(maximumConcurrency).toBe(1);
    expect(logger.error).not.toHaveBeenCalled();

    releaseFirstCycle();
    await vi.waitFor(() => expect(active).toBe(0));
    await vi.advanceTimersByTimeAsync(0);
    expect(await worker.offerTick()).toEqual({ outcome: "completed" });

    expect(cycleCount).toBe(2);
    expect(maximumConcurrency).toBe(1);
    await worker.stop();
  });

  it("never includes the bearer token in failure logs", async () => {
    const messages: string[] = [];
    const logger = {
      info: vi.fn(),
      error: vi.fn((message: string) => messages.push(message)),
    };
    const worker = createLocalMaintenanceWorker({
      config: enabledConfig(),
      fetchImpl: vi.fn(async (input: string | URL | Request) =>
        response(String(input).endsWith("/api/health") ? 200 : 500),
      ),
      logger,
    });

    await worker.start();
    await vi.waitFor(() => expect(logger.error).toHaveBeenCalledOnce());
    await worker.stop();

    expect(messages.join("\n")).not.toContain(TOKEN);
    expect(messages.join("\n")).toContain("HTTP 500");
  });

  it("releases the overlap guard after a synchronous transport failure", async () => {
    const logger = { info: vi.fn(), error: vi.fn() };
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(response(200))
      .mockImplementationOnce(() => {
        throw new Error(`transport failed ${TOKEN}`);
      })
      .mockResolvedValueOnce(response(202));
    const worker = createLocalMaintenanceWorker({
      config: enabledConfig(),
      fetchImpl,
      logger,
    });

    await worker.start();
    await vi.waitFor(() => expect(logger.error).toHaveBeenCalledOnce());

    expect(await worker.offerTick()).toEqual({ outcome: "completed" });
    expect(logger.error.mock.calls.flat().join(" ")).not.toContain(TOKEN);
    await worker.stop();
  });

  it("stops new ticks, drains for the grace period, then aborts an active request", async () => {
    vi.useFakeTimers();
    let aborted = false;
    const fetchImpl = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        if (String(input).endsWith("/api/health")) return response(200);
        return await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            aborted = true;
            reject(new DOMException("Aborted", "AbortError"));
          });
        });
      },
    );
    const logger = { info: vi.fn(), error: vi.fn() };
    const worker = createLocalMaintenanceWorker({
      config: enabledConfig(),
      fetchImpl,
      logger,
    });

    await worker.start();
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(2));
    const stopping = worker.stop();
    expect(await worker.offerTick()).toEqual({ outcome: "stopped" });
    await vi.advanceTimersByTimeAsync(29_999);
    expect(aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await stopping;

    expect(aborted).toBe(true);
    expect(logger.error).not.toHaveBeenCalled();
  });
});

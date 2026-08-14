import { spawn as spawnReal } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import playwrightConfig from "../../playwright.config";
// The production supervisor intentionally remains plain Node ESM.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore -- the supervisor is JavaScript by design
import { createLocalStackSupervisor } from "../../scripts/run-local-stack.mjs";

const TOKEN = "a-valid-operator-api-token-with-32-characters";
let nextFakePid = 48_000;

class FakeChildProcess extends EventEmitter {
  readonly pid = nextFakePid++;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly kills: NodeJS.Signals[] = [];

  constructor(
    readonly label: string,
    private readonly exitSignals: NodeJS.Signals[] = [
      "SIGINT",
      "SIGTERM",
      "SIGKILL",
    ],
  ) {
    super();
  }

  kill(signal: NodeJS.Signals = "SIGTERM") {
    this.kills.push(signal);
    if (this.exitSignals.includes(signal)) this.exit(null, signal);
    return true;
  }

  exit(code: number | null, signal: NodeJS.Signals | null = null) {
    if (this.exitCode !== null || this.signalCode !== null) return;
    this.exitCode = code;
    this.signalCode = signal;
    this.emit("exit", code, signal);
  }
}

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
    nextShutdownGraceMs: 30_000,
    healthRetryIntervalMs: 1_000,
    healthWaitTimeoutMs: 120_000,
    ...overrides,
  };
}

function disabledConfig(reason: "trigger" | "explicit") {
  return {
    ...enabledConfig(),
    mode: "disabled",
    reason,
    provider: reason === "trigger" ? "trigger" : "local",
  };
}

function harness(options: {
  config?: ReturnType<typeof enabledConfig> | ReturnType<typeof disabledConfig>;
  mode?: "dev" | "start";
  args?: string[];
  children?: FakeChildProcess[];
  logger?: { info: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> };
  environment?: Record<string, string | undefined>;
}) {
  const children = options.children ?? [
    new FakeChildProcess("web"),
    new FakeChildProcess("worker"),
  ];
  const allChildren = [...children];
  const spawnProcess = vi.fn(
    (
      _command: string,
      _args: string[],
      _spawnOptions: Record<string, unknown>,
    ) => {
      void _command;
      void _args;
      void _spawnOptions;
      const child = children.shift();
      if (!child) throw new Error("Unexpected spawn");
      return child;
    },
  );
  const logger = options.logger ?? { info: vi.fn(), error: vi.fn() };
  const loadConfig = vi.fn(() => options.config ?? enabledConfig());
  const signalProcess = vi.fn((target: number, signal: NodeJS.Signals) => {
    const child = allChildren.find(({ pid }) => pid === Math.abs(target));
    if (!child) {
      const error = new Error("No such process") as NodeJS.ErrnoException;
      error.code = "ESRCH";
      throw error;
    }
    child.kill(signal);
    return true;
  });
  const supervisor = createLocalStackSupervisor({
    mode: options.mode ?? "dev",
    args: options.args ?? [],
    environment: options.environment ?? {
      NODE_ENV: options.mode === "start" ? "production" : "development",
      PORT: "3000",
    },
    projectDir: process.cwd(),
    loadConfig,
    spawnProcess,
    platform: "darwin",
    signalProcess,
    logger,
  });
  return { supervisor, spawnProcess, loadConfig, signalProcess, logger };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("local stack supervisor startup", () => {
  it("starts Next and the worker in local mode and forwards Next arguments", async () => {
    const web = new FakeChildProcess("web");
    const worker = new FakeChildProcess("worker");
    const { supervisor, spawnProcess, loadConfig } = harness({
      mode: "dev",
      args: ["--hostname", "127.0.0.1", "--webpack"],
      children: [web, worker],
    });

    await supervisor.start();

    expect(loadConfig).toHaveBeenCalledWith(
      expect.objectContaining({ dev: true, projectDir: process.cwd() }),
    );
    expect(spawnProcess).toHaveBeenCalledTimes(2);
    expect(spawnProcess.mock.calls[0]?.[0]).toBe(process.execPath);
    expect(spawnProcess.mock.calls[0]?.[1]).toEqual([
      join(process.cwd(), "node_modules/next/dist/bin/next"),
      "dev",
      "--hostname",
      "127.0.0.1",
      "--webpack",
    ]);
    expect(spawnProcess.mock.calls[0]?.[2]).toMatchObject({
      detached: process.platform !== "win32",
    });
    expect(spawnProcess.mock.calls[1]?.[1]).toEqual([
      join(process.cwd(), "scripts/local-maintenance-worker.mjs"),
    ]);

    await supervisor.shutdown("SIGTERM");
    await expect(supervisor.done).resolves.toBe(0);
    expect(worker.kills).toEqual(["SIGTERM"]);
    expect(web.kills).toEqual(["SIGTERM"]);
  });

  it.each([
    ["start", {}, "production"],
    ["start", { NODE_ENV: "development" }, "production"],
    ["start", { NODE_ENV: "test" }, "production"],
    ["dev", { NODE_ENV: "production" }, "development"],
    ["dev", { NODE_ENV: "test" }, "development"],
  ] as const)(
    "pins NODE_ENV for %s when the launch environment is %j",
    async (mode, environment, expectedNodeEnvironment) => {
      const web = new FakeChildProcess("web");
      const worker = new FakeChildProcess("worker");
      const { supervisor, spawnProcess, loadConfig } = harness({
        mode,
        environment,
        children: [web, worker],
      });

      await supervisor.start();

      const webEnvironment = spawnProcess.mock.calls[0]?.[2].env;
      const workerEnvironment = spawnProcess.mock.calls[1]?.[2].env;
      expect(webEnvironment).toMatchObject({
        NODE_ENV: expectedNodeEnvironment,
        PORT: "3000",
      });
      expect(workerEnvironment).toEqual(webEnvironment);
      expect(loadConfig).toHaveBeenCalledWith(
        expect.objectContaining({
          dev: mode === "dev",
          environment: expect.objectContaining({
            NODE_ENV: expectedNodeEnvironment,
          }),
        }),
      );

      await supervisor.shutdown("SIGTERM");
    },
  );

  it.each([
    [disabledConfig("trigger"), "Trigger.dev owns scheduling"],
    [disabledConfig("explicit"), "LOCAL_MAINTENANCE_ENABLED=false"],
  ] as const)(
    "starts only Next and logs one notice when maintenance is disabled (%s)",
    async (config, expectedNotice) => {
      const web = new FakeChildProcess("web");
      const logger = { info: vi.fn(), error: vi.fn() };
      const { supervisor, spawnProcess } = harness({
        config,
        children: [web],
        logger,
      });

      await supervisor.start();

      expect(spawnProcess).toHaveBeenCalledOnce();
      expect(logger.info).toHaveBeenCalledOnce();
      expect(logger.info).toHaveBeenCalledWith(
        expect.stringContaining(expectedNotice),
      );
      await supervisor.shutdown("SIGINT");
      expect(web.kills).toEqual(["SIGINT"]);
    },
  );

  it("fails preflight once before starting any child when the token is invalid", async () => {
    const spawnProcess = vi.fn();
    const loadConfig = vi.fn(() => {
      throw new Error(
        "OPERATOR_API_TOKEN must contain at least 32 characters when local maintenance is enabled",
      );
    });
    const supervisor = createLocalStackSupervisor({
      mode: "dev",
      environment: { WORKFLOW_PROVIDER: "local" },
      projectDir: process.cwd(),
      loadConfig,
      spawnProcess,
      logger: { info: vi.fn(), error: vi.fn() },
    });

    await expect(supervisor.start()).rejects.toThrowError(
      /OPERATOR_API_TOKEN must contain at least 32 characters/,
    );
    expect(loadConfig).toHaveBeenCalledOnce();
    expect(spawnProcess).not.toHaveBeenCalled();
  });

  it.each([
    ["--port", "4100"],
    ["--port=4100"],
    ["-p", "4100"],
    ["-p4100"],
    ["-p4100ignored-by-parseInt"],
  ])(
    "rejects Next port arguments in local maintenance mode: %s",
    async (...args) => {
      const spawnProcess = vi.fn(() => {
        throw new Error("must not spawn");
      });
      const supervisor = createLocalStackSupervisor({
        mode: "dev",
        args,
        environment: { PORT: "3000" },
        projectDir: process.cwd(),
        loadConfig: vi.fn(() => enabledConfig()),
        spawnProcess,
        logger: { info: vi.fn(), error: vi.fn() },
      });

      await expect(supervisor.start()).rejects.toThrowError(
        /set PORT in the launching environment instead/i,
      );
      expect(spawnProcess).not.toHaveBeenCalled();
    },
  );

  it("does not treat an unrelated short argument beginning with -p as a valid compact port", async () => {
    const web = new FakeChildProcess("web");
    const worker = new FakeChildProcess("worker");
    const { supervisor, spawnProcess } = harness({
      args: ["-profile"],
      children: [web, worker],
    });

    await supervisor.start();
    expect(spawnProcess.mock.calls[0]?.[1]).toContain("-profile");
    await supervisor.shutdown("SIGTERM");
  });

  it("reaps Next if the worker cannot be spawned", async () => {
    const web = new FakeChildProcess("web");
    const spawnProcess = vi
      .fn()
      .mockReturnValueOnce(web)
      .mockImplementationOnce(() => {
        throw new Error("worker spawn failed");
      });
    const supervisor = createLocalStackSupervisor({
      mode: "dev",
      environment: { PORT: "3000" },
      projectDir: process.cwd(),
      loadConfig: vi.fn(() => enabledConfig()),
      spawnProcess,
      platform: "darwin",
      signalProcess: (_target: number, signal: NodeJS.Signals) =>
        web.kill(signal),
      logger: { info: vi.fn(), error: vi.fn() },
    });

    await expect(supervisor.start()).rejects.toThrowError(
      "worker spawn failed",
    );
    expect(web.kills).toEqual(["SIGTERM"]);
  });

  it("forwards non-port production arguments to next start", async () => {
    const web = new FakeChildProcess("web");
    const worker = new FakeChildProcess("worker");
    const { supervisor, spawnProcess } = harness({
      mode: "start",
      args: ["--hostname", "127.0.0.1"],
      children: [web, worker],
    });

    await supervisor.start();

    expect(spawnProcess.mock.calls[0]?.[1]).toEqual([
      join(process.cwd(), "node_modules/next/dist/bin/next"),
      "start",
      "--hostname",
      "127.0.0.1",
    ]);
    await supervisor.shutdown("SIGTERM");
  });

  it("still forwards port arguments when Trigger owns scheduling", async () => {
    const web = new FakeChildProcess("web");
    const { supervisor, spawnProcess } = harness({
      args: ["--port=4100"],
      config: disabledConfig("trigger"),
      children: [web],
    });

    await supervisor.start();
    expect(spawnProcess.mock.calls[0]?.[1]).toContain("--port=4100");
    await supervisor.shutdown("SIGTERM");
  });

  it("pins the canonical PORT so an occupied port makes Next exit and stops the worker", async () => {
    const web = new FakeChildProcess("web");
    const worker = new FakeChildProcess("worker");
    const { supervisor, spawnProcess } = harness({
      environment: { NODE_ENV: "development" },
      children: [web, worker],
    });

    await supervisor.start();
    expect(spawnProcess.mock.calls[0]?.[2]).toMatchObject({
      env: expect.objectContaining({ PORT: "3000" }),
    });

    web.exit(1);
    await expect(supervisor.done).resolves.toBe(1);
    expect(worker.kills).toEqual(["SIGTERM"]);
  });
});

describe("local stack supervisor lifecycle", () => {
  it.each(["web", "worker"] as const)(
    "terminates the sibling and returns non-zero when %s exits unexpectedly",
    async (which) => {
      const web = new FakeChildProcess("web");
      const worker = new FakeChildProcess("worker");
      const { supervisor } = harness({ children: [web, worker] });
      await supervisor.start();

      (which === "web" ? web : worker).exit(0);

      await expect(supervisor.done).resolves.toBe(1);
      expect(which === "web" ? worker.kills : web.kills).toEqual(["SIGTERM"]);
    },
  );

  it("gives the worker its grace first, then gives Next its separate grace", async () => {
    vi.useFakeTimers();
    const order: string[] = [];
    class OrderedChild extends FakeChildProcess {
      override kill(signal: NodeJS.Signals = "SIGTERM") {
        order.push(`${this.label}:${signal}`);
        return super.kill(signal);
      }
    }
    const web = new OrderedChild("web", ["SIGKILL"]);
    const worker = new OrderedChild("worker", ["SIGKILL"]);
    const { supervisor, signalProcess } = harness({ children: [web, worker] });
    await supervisor.start();

    const shutdown = supervisor.shutdown("SIGTERM");
    expect(order).toEqual(["worker:SIGTERM"]);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(order).toEqual(["worker:SIGTERM"]);
    await vi.advanceTimersByTimeAsync(1);
    expect(order).toEqual(["worker:SIGTERM", "worker:SIGKILL", "web:SIGTERM"]);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(order).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(1);
    await shutdown;

    expect(order).toEqual([
      "worker:SIGTERM",
      "worker:SIGKILL",
      "web:SIGTERM",
      "web:SIGKILL",
    ]);
    expect(signalProcess.mock.calls).toEqual([
      [-worker.pid, "SIGTERM"],
      [-worker.pid, "SIGKILL"],
      [-web.pid, "SIGTERM"],
      [-web.pid, "SIGKILL"],
    ]);
    await expect(supervisor.done).resolves.toBe(0);
  });

  it("treats an already-gone POSIX process group as a successful signal", async () => {
    const web = new FakeChildProcess("web");
    const signalProcess = vi.fn((_target: number, signal: NodeJS.Signals) => {
      queueMicrotask(() => web.exit(null, signal));
      const error = new Error("No such process") as NodeJS.ErrnoException;
      error.code = "ESRCH";
      throw error;
    });
    const supervisor = createLocalStackSupervisor({
      mode: "dev",
      projectDir: process.cwd(),
      loadConfig: vi.fn(() => disabledConfig("explicit")),
      spawnProcess: vi.fn(() => web),
      platform: "darwin",
      signalProcess,
      logger: { info: vi.fn(), error: vi.fn() },
    });
    await supervisor.start();

    await expect(supervisor.shutdown("SIGTERM")).resolves.toBeUndefined();
    expect(signalProcess).toHaveBeenCalledWith(-web.pid, "SIGTERM");
  });

  it("never targets the supervisor itself as a POSIX process group", async () => {
    const web = new FakeChildProcess("web");
    Object.defineProperty(web, "pid", { value: process.pid });
    const signalProcess = vi.fn();
    const supervisor = createLocalStackSupervisor({
      mode: "dev",
      projectDir: process.cwd(),
      loadConfig: vi.fn(() => disabledConfig("explicit")),
      spawnProcess: vi.fn(() => web),
      platform: "darwin",
      signalProcess,
      logger: { info: vi.fn(), error: vi.fn() },
    });
    await supervisor.start();

    await supervisor.shutdown("SIGTERM");
    expect(signalProcess).not.toHaveBeenCalled();
    expect(web.kills).toEqual(["SIGTERM"]);
  });

  it.skipIf(process.platform === "win32")(
    "kills a real detached process tree after graceful shutdown expires",
    async () => {
      let leader: ReturnType<typeof spawnReal> | undefined;
      let descendantPid: number | undefined;
      try {
        const spawnProcess = vi.fn(
          (
            _command: string,
            _args: string[],
            spawnOptions: Parameters<typeof spawnReal>[2],
          ) => {
            leader = spawnReal(
              process.execPath,
              [
                "-e",
                `const { spawn } = require("node:child_process");
const child = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdio: "ignore" });
console.log(child.pid);
process.on("SIGTERM", () => {});
setInterval(() => {}, 1000);`,
              ],
              { ...spawnOptions, stdio: ["ignore", "pipe", "ignore"] },
            );
            return leader;
          },
        );
        const supervisor = createLocalStackSupervisor({
          mode: "dev",
          projectDir: process.cwd(),
          loadConfig: vi.fn(() => ({
            ...disabledConfig("explicit"),
            nextShutdownGraceMs: 25,
          })),
          spawnProcess,
          logger: { info: vi.fn(), error: vi.fn() },
        });
        await supervisor.start();
        const stdout = leader?.stdout;
        if (!stdout) throw new Error("leader stdout is unavailable");
        const [chunk] = await once(stdout, "data");
        descendantPid = Number(String(chunk).trim());

        await supervisor.shutdown("SIGTERM");

        await expect
          .poll(
            () => {
              try {
                process.kill(descendantPid!, 0);
                return true;
              } catch (error) {
                return (error as NodeJS.ErrnoException).code !== "ESRCH";
              }
            },
            { timeout: 2_000 },
          )
          .toBe(false);
      } finally {
        if (leader?.pid) {
          try {
            process.kill(-leader.pid, "SIGKILL");
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
          }
        }
      }
    },
  );
});

describe("local stack package contract", () => {
  it("keeps the supervisor production-runnable and E2E maintenance disabled", async () => {
    const packageJson = JSON.parse(
      await readFile(join(process.cwd(), "package.json"), "utf8"),
    );

    expect(packageJson.dependencies["@next/env"]).toBe("16.3.0");
    expect(packageJson.scripts).toMatchObject({
      dev: "node scripts/run-local-stack.mjs dev",
      "dev:web": "next dev",
      start: "node scripts/run-local-stack.mjs start",
      "start:web": "next start",
      "maintenance:local": "node scripts/local-maintenance-worker.mjs",
    });
    expect(
      (playwrightConfig.webServer as { env?: Record<string, string> }).env
        ?.LOCAL_MAINTENANCE_ENABLED,
    ).toBe("false");
  });
});

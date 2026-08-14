import { spawn } from "node:child_process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import maintenanceTiming from "../config/maintenance.json" with { type: "json" };
import { loadAndResolveLocalMaintenanceConfig } from "./local-maintenance-runtime.mjs";

const SIGNALS = ["SIGINT", "SIGTERM"];

const defaultTimers = {
  setTimeout: (...arguments_) => globalThis.setTimeout(...arguments_),
  clearTimeout: (...arguments_) => globalThis.clearTimeout(...arguments_),
};

function hasExited(child) {
  return child.exitCode !== null || child.signalCode !== null;
}

function waitForExit(child) {
  if (hasExited(child)) return Promise.resolve();
  return new Promise((resolve) => child.once("exit", resolve));
}

async function waitForExitWithin(child, durationMs, timers) {
  if (hasExited(child)) return true;

  return await new Promise((resolve) => {
    let timeoutHandle;
    const onExit = () => {
      timers.clearTimeout(timeoutHandle);
      resolve(true);
    };
    child.once("exit", onExit);
    timeoutHandle = timers.setTimeout(() => {
      child.removeListener("exit", onExit);
      resolve(false);
    }, durationMs);
  });
}

async function stopChild(child, signal, graceMs, timers, signalChild) {
  if (!child || hasExited(child)) return;

  signalChild(child, signal);
  if (await waitForExitWithin(child, graceMs, timers)) return;

  const exited = waitForExit(child);
  signalChild(child, "SIGKILL");
  await exited;
}

function hasNextPortArgument(args) {
  return args.some((argument) => {
    if (
      argument === "--port" ||
      argument.startsWith("--port=") ||
      argument === "-p"
    ) {
      return true;
    }
    if (!argument.startsWith("-p") || argument.startsWith("--")) {
      return false;
    }

    // Commander combines compact short-option values (`-p4100`) and
    // Next's parser accepts any suffix that parseInt resolves non-negative.
    const compactPort = Number.parseInt(argument.slice(2), 10);
    return Number.isFinite(compactPort) && compactPort >= 0;
  });
}

function disabledNotice(reason) {
  return reason === "trigger"
    ? "[maintenance] local worker disabled because Trigger.dev owns scheduling"
    : "[maintenance] local worker disabled by LOCAL_MAINTENANCE_ENABLED=false";
}

export function createLocalStackSupervisor(options) {
  const mode = options.mode;
  if (mode !== "dev" && mode !== "start") {
    throw new Error("Local stack mode must be dev or start");
  }

  const projectDir = options.projectDir ?? process.cwd();
  const environment = options.environment ?? process.env;
  const logger = options.logger ?? console;
  const timers = options.timers ?? defaultTimers;
  const spawnProcess = options.spawnProcess ?? spawn;
  const platform = options.platform ?? process.platform;
  const signalProcess = options.signalProcess ?? process.kill;
  const loadConfig = options.loadConfig ?? loadAndResolveLocalMaintenanceConfig;
  const args = options.args ?? [];

  let config;
  let webChild;
  let workerChild;
  let started = false;
  let shuttingDown = false;
  let shutdownPromise;
  let resolvedChildEnvironment;
  let resolveDone;
  const done = new Promise((resolve) => {
    resolveDone = resolve;
  });

  const spawnOptions = () => ({
    cwd: projectDir,
    // Keep terminal signals at the supervisor so it can drain the worker
    // before asking Next.js to stop. Windows does not support POSIX groups.
    detached: platform !== "win32",
    env: { ...resolvedChildEnvironment },
    stdio: "inherit",
  });

  function signalChild(child, signal) {
    const canSignalGroup =
      platform !== "win32" &&
      Number.isSafeInteger(child.pid) &&
      child.pid > 0 &&
      child.pid !== process.pid;
    if (!canSignalGroup) {
      child.kill(signal);
      return;
    }

    try {
      signalProcess(-child.pid, signal);
    } catch (error) {
      if (error instanceof Error && error.code === "ESRCH") return;
      throw error;
    }
  }

  function monitor(child, label) {
    child.once("error", (error) => {
      if (shuttingDown) return;
      logger.error(`[local-stack] ${label} failed: ${error.message}`);
      void unexpectedExit(child, label);
    });
    child.once("exit", (code, signal) => {
      if (shuttingDown) return;
      const detail = signal ? `signal ${signal}` : `code ${code ?? "unknown"}`;
      logger.error(`[local-stack] ${label} exited unexpectedly (${detail})`);
      void unexpectedExit(child, label);
    });
  }

  async function unexpectedExit(exitedChild) {
    if (shuttingDown) return;
    shuttingDown = true;

    if (exitedChild === webChild) {
      await stopChild(
        workerChild,
        "SIGTERM",
        config?.shutdownGraceMs ?? maintenanceTiming.workerShutdownGraceMs,
        timers,
        signalChild,
      );
    } else {
      await stopChild(
        webChild,
        "SIGTERM",
        config?.nextShutdownGraceMs ?? maintenanceTiming.nextShutdownGraceMs,
        timers,
        signalChild,
      );
    }
    resolveDone(1);
  }

  async function start() {
    if (started) return { config, webChild, workerChild };

    const canonicalNodeEnvironment =
      mode === "start" ? "production" : "development";
    resolvedChildEnvironment = {
      ...environment,
      NODE_ENV: canonicalNodeEnvironment,
    };
    config = loadConfig({
      projectDir,
      dev: mode === "dev",
      environment: resolvedChildEnvironment,
    });
    if (config.mode === "enabled" && hasNextPortArgument(args)) {
      throw new Error(
        "Next.js port flags are not supported while local maintenance is enabled; set PORT in the launching environment instead",
      );
    }
    resolvedChildEnvironment = {
      ...resolvedChildEnvironment,
      PORT: String(config.port),
    };

    const nextCli = join(projectDir, "node_modules/next/dist/bin/next");
    webChild = spawnProcess(
      process.execPath,
      [nextCli, mode, ...args],
      spawnOptions(),
    );
    monitor(webChild, "Next.js");

    if (config.mode === "enabled") {
      try {
        workerChild = spawnProcess(
          process.execPath,
          [join(projectDir, "scripts/local-maintenance-worker.mjs")],
          spawnOptions(),
        );
        monitor(workerChild, "maintenance worker");
      } catch (error) {
        shuttingDown = true;
        await stopChild(
          webChild,
          "SIGTERM",
          config?.nextShutdownGraceMs ?? maintenanceTiming.nextShutdownGraceMs,
          timers,
          signalChild,
        );
        throw error;
      }
    } else {
      logger.info(disabledNotice(config.reason));
    }

    started = true;
    return { config, webChild, workerChild };
  }

  function shutdown(signal = "SIGTERM") {
    if (shutdownPromise) return shutdownPromise;
    shuttingDown = true;
    shutdownPromise = (async () => {
      await stopChild(
        workerChild,
        signal,
        config?.shutdownGraceMs ?? maintenanceTiming.workerShutdownGraceMs,
        timers,
        signalChild,
      );
      await stopChild(
        webChild,
        signal,
        config?.nextShutdownGraceMs ?? maintenanceTiming.nextShutdownGraceMs,
        timers,
        signalChild,
      );
      resolveDone(0);
    })();
    return shutdownPromise;
  }

  return { start, shutdown, done };
}

export async function runLocalStackCli(
  argv = process.argv.slice(2),
  options = {},
) {
  const logger = options.logger ?? console;
  if (argv[0] === "--help" || argv[0] === "-h") {
    logger.info(
      "Usage: node scripts/run-local-stack.mjs <dev|start> [Next.js arguments]",
    );
    return 0;
  }

  const [mode, ...args] = argv;
  if (mode !== "dev" && mode !== "start") {
    logger.error("[local-stack] expected dev or start");
    return 1;
  }

  let supervisor;
  try {
    supervisor = createLocalStackSupervisor({
      mode,
      args,
      projectDir: options.projectDir,
      environment: options.environment,
      logger,
      timers: options.timers,
      spawnProcess: options.spawnProcess,
      loadConfig: options.loadConfig,
    });
    await supervisor.start();
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown error";
    logger.error(`[local-stack] startup failed: ${message}`);
    return 1;
  }

  const handlers = new Map();
  for (const signal of SIGNALS) {
    const handler = () => {
      void supervisor.shutdown(signal);
    };
    handlers.set(signal, handler);
    process.once(signal, handler);
  }

  const exitCode = await supervisor.done;
  for (const [signal, handler] of handlers) {
    process.removeListener(signal, handler);
  }
  return exitCode;
}

const launchedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (launchedDirectly) {
  process.exitCode = await runLocalStackCli();
}

import { pathToFileURL } from "node:url";

import {
  LocalMaintenanceConfigurationError,
  loadAndResolveLocalMaintenanceConfig,
} from "./local-maintenance-runtime.mjs";

const defaultTimers = {
  setInterval: (...arguments_) => globalThis.setInterval(...arguments_),
  clearInterval: (...arguments_) => globalThis.clearInterval(...arguments_),
  setTimeout: (...arguments_) => globalThis.setTimeout(...arguments_),
  clearTimeout: (...arguments_) => globalThis.clearTimeout(...arguments_),
};

function aborted(error) {
  return error instanceof Error && error.name === "AbortError";
}

function sanitizedMessage(error, token) {
  const raw = error instanceof Error ? error.message : "unknown error";
  return token ? raw.replaceAll(token, "[redacted]") : raw;
}

// The health payload already carries a machine-readable reason. Repeating it in
// the timeout message keeps the operator from having to probe the endpoint by
// hand to learn why the application never came up.
async function healthFailureReason(result) {
  try {
    const body = await result.json();
    if (body?.schema === "outdated") {
      return `database schema is outdated (${body.appliedMigrations}/${body.expectedMigrations} migrations applied); run npm run db:migrate`;
    }
    if (body?.database === "unreachable") return "database is unreachable";
  } catch {
    // A health response without a JSON body carries no extra detail.
  }
  return undefined;
}

export function createLocalMaintenanceWorker(options) {
  const { config } = options;
  if (config.mode !== "enabled") {
    throw new LocalMaintenanceConfigurationError(
      "The local maintenance worker requires enabled local maintenance configuration",
    );
  }

  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const logger = options.logger ?? console;
  const timers = options.timers ?? defaultTimers;
  const now = options.now ?? Date.now;

  let stopped = false;
  let started = false;
  let intervalHandle;
  let healthController;
  let activeController;
  let activeRequest;

  function delay(durationMs) {
    return new Promise((resolve) => {
      timers.setTimeout(resolve, durationMs);
    });
  }

  async function waitForHealth() {
    const deadline = now() + config.healthWaitTimeoutMs;
    let lastReason;

    while (!stopped) {
      const remainingMs = deadline - now();
      if (remainingMs < 0) break;

      healthController = new AbortController();
      const healthTimeout = timers.setTimeout(
        () => healthController?.abort(),
        Math.max(1, remainingMs),
      );
      try {
        const result = await fetchImpl(config.healthUrl, {
          method: "GET",
          signal: healthController.signal,
        });
        if (result.ok) return;
        lastReason = await healthFailureReason(result);
      } catch (error) {
        if (stopped && aborted(error)) return;
      } finally {
        timers.clearTimeout(healthTimeout);
        healthController = undefined;
      }

      const delayMs = Math.min(
        config.healthRetryIntervalMs,
        Math.max(0, deadline - now()),
      );
      if (delayMs === 0) break;
      await delay(delayMs);
    }

    if (stopped) return;
    throw new Error(
      `Application health check did not succeed within ${config.healthWaitTimeoutMs}ms${
        lastReason ? `: ${lastReason}` : ""
      }`,
    );
  }

  function offerTick() {
    if (stopped) return Promise.resolve({ outcome: "stopped" });
    if (activeRequest) return Promise.resolve({ outcome: "busy" });

    const controller = new AbortController();
    activeController = controller;
    let requestTimedOut = false;
    const requestTimeout = timers.setTimeout(() => {
      requestTimedOut = true;
      controller.abort();
    }, config.requestTimeoutMs);

    const request = Promise.resolve().then(async () => {
      try {
        const result = await fetchImpl(config.maintenanceUrl, {
          method: "POST",
          headers: {
            authorization: `Bearer ${config.token}`,
          },
          signal: controller.signal,
        });
        if (!result.ok) {
          throw new Error(
            `Maintenance request failed with HTTP ${result.status}`,
          );
        }
        logger.info("[maintenance] cycle request completed");
        return { outcome: "completed" };
      } catch (error) {
        if (stopped && aborted(error)) return { outcome: "stopped" };
        const message = requestTimedOut
          ? `Maintenance request timed out after ${config.requestTimeoutMs}ms`
          : sanitizedMessage(error, config.token);
        logger.error(`[maintenance] ${message}`);
        return { outcome: "failed" };
      } finally {
        timers.clearTimeout(requestTimeout);
        if (activeRequest === request) {
          activeRequest = undefined;
          activeController = undefined;
        }
      }
    });
    activeRequest = request;
    return request;
  }

  async function start() {
    if (started) return;
    started = true;
    await waitForHealth();
    if (stopped) return;

    logger.info("[maintenance] application is healthy; worker started");
    void offerTick();
    intervalHandle = timers.setInterval(() => {
      void offerTick();
    }, config.intervalMs);
  }

  async function stop() {
    if (stopped) return;
    stopped = true;
    if (intervalHandle !== undefined) {
      timers.clearInterval(intervalHandle);
      intervalHandle = undefined;
    }
    healthController?.abort();

    const request = activeRequest;
    if (!request) return;

    let graceHandle;
    const drained = await Promise.race([
      request.then(() => true),
      new Promise((resolve) => {
        graceHandle = timers.setTimeout(
          () => resolve(false),
          config.shutdownGraceMs,
        );
      }),
    ]);
    if (graceHandle !== undefined) timers.clearTimeout(graceHandle);
    if (!drained) activeController?.abort();
    await request;
  }

  return { start, stop, offerTick };
}

export async function runLocalMaintenanceWorker(options = {}) {
  const logger = options.logger ?? console;
  const config = loadAndResolveLocalMaintenanceConfig({
    projectDir: options.projectDir,
    dev: options.dev,
    environment: options.environment,
  });
  if (config.mode === "disabled") {
    logger.info(
      config.reason === "trigger"
        ? "[maintenance] local worker disabled because Trigger.dev owns scheduling"
        : "[maintenance] local worker disabled by LOCAL_MAINTENANCE_ENABLED=false",
    );
    return { mode: "disabled", reason: config.reason };
  }

  const worker = createLocalMaintenanceWorker({
    config,
    fetchImpl: options.fetchImpl,
    logger,
  });
  let stopping;
  const stop = () => {
    stopping ??= worker.stop();
    return stopping;
  };
  const handleSignal = () => {
    void stop();
  };
  process.once("SIGINT", handleSignal);
  process.once("SIGTERM", handleSignal);
  await worker.start();
  return { mode: "enabled", worker, stop };
}

const launchedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (launchedDirectly) {
  runLocalMaintenanceWorker().catch((error) => {
    const message =
      error instanceof Error
        ? error.message
        : "Unknown maintenance worker error";
    console.error(`[maintenance] startup failed: ${message}`);
    process.exitCode = 1;
  });
}

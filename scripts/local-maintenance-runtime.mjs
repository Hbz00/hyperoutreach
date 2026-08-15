import nextEnvironment from "@next/env";

import maintenanceTiming from "../config/maintenance.json" with { type: "json" };

const DEFAULT_PORT = 3000;
const DEFAULT_AI_RESEARCH_TIMEOUT_MS = 600_000;
const MINIMUM_TOKEN_LENGTH = 32;
const HEALTH_RETRY_INTERVAL_MS = 1_000;
const HEALTH_WAIT_TIMEOUT_MS = 120_000;

export class LocalMaintenanceConfigurationError extends Error {
  name = "LocalMaintenanceConfigurationError";
}

function parsePort(rawPort) {
  const value = rawPort?.trim();
  if (!value) return DEFAULT_PORT;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new LocalMaintenanceConfigurationError(
      "PORT must be an integer between 1 and 65535",
    );
  }
  return port;
}

function parseResearchTimeout(rawTimeout) {
  const value = rawTimeout?.trim();
  if (!value) return DEFAULT_AI_RESEARCH_TIMEOUT_MS;
  const timeout = Number(value);
  if (!Number.isSafeInteger(timeout) || timeout < 1) {
    throw new LocalMaintenanceConfigurationError(
      "AI_RESEARCH_TIMEOUT_MS must be a positive integer",
    );
  }
  return timeout;
}

function resolveProvider(rawProvider) {
  const provider = rawProvider?.trim() || "local";
  if (provider === "local" || provider === "mock") return "local";
  if (provider === "trigger") return "trigger";
  throw new LocalMaintenanceConfigurationError(
    "WORKFLOW_PROVIDER must be one of: local, mock, trigger",
  );
}

function maintenanceEnabled(rawEnabled) {
  const enabled = rawEnabled?.trim().toLowerCase();
  if (!enabled || enabled === "true") return true;
  if (enabled === "false") return false;
  throw new LocalMaintenanceConfigurationError(
    "LOCAL_MAINTENANCE_ENABLED must be true or false",
  );
}

function resolveBaseUrl(rawBaseUrl, port) {
  if (!rawBaseUrl?.trim()) return `http://127.0.0.1:${port}`;

  let url;
  try {
    url = new URL(rawBaseUrl.trim());
  } catch {
    throw new LocalMaintenanceConfigurationError(
      "LOCAL_MAINTENANCE_BASE_URL must be an absolute HTTP(S) URL",
    );
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username ||
    url.password
  ) {
    throw new LocalMaintenanceConfigurationError(
      "LOCAL_MAINTENANCE_BASE_URL must be an absolute HTTP(S) URL without credentials",
    );
  }
  return url.origin;
}

export function resolveLocalMaintenanceConfig(environment = process.env) {
  const provider = resolveProvider(environment.WORKFLOW_PROVIDER);
  const port = parsePort(environment.PORT);
  const baseUrl = resolveBaseUrl(environment.LOCAL_MAINTENANCE_BASE_URL, port);
  const common = {
    provider,
    port,
    baseUrl,
    healthUrl: new URL("/api/health", baseUrl).toString(),
    maintenanceUrl: new URL(
      "/api/internal/workflows/reconcile",
      baseUrl,
    ).toString(),
    intervalMs: maintenanceTiming.intervalMs,
    heartbeatIntervalMs: maintenanceTiming.heartbeatIntervalMs,
    staleLeaseMs: maintenanceTiming.staleLeaseMs,
    requestTimeoutMs: Math.max(
      maintenanceTiming.aggregateBudgetMs,
      parseResearchTimeout(environment.AI_RESEARCH_TIMEOUT_MS) +
        maintenanceTiming.transportMarginMs,
    ),
    shutdownGraceMs: maintenanceTiming.workerShutdownGraceMs,
    healthRetryIntervalMs: HEALTH_RETRY_INTERVAL_MS,
    healthWaitTimeoutMs: HEALTH_WAIT_TIMEOUT_MS,
  };

  if (provider === "trigger") {
    return { ...common, mode: "disabled", reason: "trigger" };
  }
  if (!maintenanceEnabled(environment.LOCAL_MAINTENANCE_ENABLED)) {
    return { ...common, mode: "disabled", reason: "explicit" };
  }

  const token = environment.OPERATOR_API_TOKEN;
  if (!token || token.trim().length < MINIMUM_TOKEN_LENGTH) {
    throw new LocalMaintenanceConfigurationError(
      "OPERATOR_API_TOKEN must contain at least 32 characters when local maintenance is enabled",
    );
  }
  return { ...common, mode: "enabled", token };
}

export function loadAndResolveLocalMaintenanceConfig(options = {}) {
  const environment = options.environment ?? process.env;
  const launchPort = environment.PORT;
  const loadEnvConfig = options.loadEnvConfig ?? nextEnvironment.loadEnvConfig;
  const useRealLoader = loadEnvConfig === nextEnvironment.loadEnvConfig;
  const dev = options.dev ?? environment.NODE_ENV !== "production";
  const canonicalNodeEnvironment = dev ? "development" : "production";
  const originalProcessNodeEnvironment = process.env.NODE_ENV;
  const hadInitialEnvironment = nextEnvironment.initialEnv !== undefined;
  const originalInitialNodeEnvironment = nextEnvironment.initialEnv?.NODE_ENV;

  if (useRealLoader) {
    process.env.NODE_ENV = canonicalNodeEnvironment;
    if (hadInitialEnvironment) {
      nextEnvironment.updateInitialEnv({
        NODE_ENV: canonicalNodeEnvironment,
      });
    }
  }

  try {
    const loaded = loadEnvConfig(
      options.projectDir ?? process.cwd(),
      dev,
      console,
      true,
    );
    if (environment !== process.env && loaded?.combinedEnv) {
      Object.assign(environment, loaded.combinedEnv);
    }
  } finally {
    if (useRealLoader) {
      if (nextEnvironment.initialEnv !== undefined) {
        nextEnvironment.updateInitialEnv({
          NODE_ENV: hadInitialEnvironment
            ? originalInitialNodeEnvironment
            : originalProcessNodeEnvironment,
        });
      }
      if (environment !== process.env) nextEnvironment.resetEnv();
      if (originalProcessNodeEnvironment === undefined) {
        delete process.env.NODE_ENV;
      } else {
        process.env.NODE_ENV = originalProcessNodeEnvironment;
      }
    }
  }

  if (launchPort === undefined) delete environment.PORT;
  else environment.PORT = launchPort;

  return resolveLocalMaintenanceConfig(environment);
}

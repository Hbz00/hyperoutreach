import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { promisify } from "node:util";

import {
  isCdpPortOpen,
  listCdpTargets,
  type CdpTarget,
} from "@/lib/chatgpt-desktop/cdp";
import { ChatGptDesktopError } from "@/lib/chatgpt-desktop/errors";

const execFileAsync = promisify(execFile);

const FALLBACK_CDP_PORT = 9333;
export const DEFAULT_APP_PATH = "/Applications/ChatGPT.app";

/**
 * `CHATGPT_DESKTOP_CDP_PORT` is read here rather than in the CLI so every
 * entry point — library, CLI and doctor — agrees on the port.
 */
export function defaultCdpPort(
  environment: Record<string, string | undefined> = process.env,
): number {
  const configured = Number.parseInt(
    environment.CHATGPT_DESKTOP_CDP_PORT ?? "",
    10,
  );
  return Number.isInteger(configured) && configured > 0 && configured < 65_536
    ? configured
    : FALLBACK_CDP_PORT;
}

/**
 * The app shell renderer, which hosts the Chat surface — the same one the
 * model picker and composer belong to. Its network traffic goes through the
 * main process over private IPC, so the app itself performs every integrity
 * step; this client only drives the surface.
 */
const RENDERER_URL_PREFIX = "app://-/index.html";
const RENDERER_URL_EXCLUDES = ["avatar-overlay"];
/** How long an already-answering app is given to show its renderer. */
const WARM_RENDERER_GRACE_MS = 5_000;

export type DesktopAppOptions = {
  port?: number;
  appPath?: string;
  /** Launch the app (hidden, unfocused) when the debug port is closed. */
  autoLaunch?: boolean;
  launchTimeoutMs?: number;
};

async function isAppInstalled(appPath: string): Promise<boolean> {
  try {
    await access(appPath);
    return true;
  } catch {
    return false;
  }
}

async function isAppRunning(appPath: string): Promise<boolean> {
  try {
    await execFileAsync("/usr/bin/pgrep", ["-f", `${appPath}/Contents/MacOS/`]);
    return true;
  } catch {
    return false;
  }
}

async function launchHidden(appPath: string, port: number): Promise<void> {
  // `-g` keeps the app from stealing focus, `-j` starts it hidden. Passing the
  // switch only works on a cold start: macOS ignores `--args` when the app is
  // already running, which is why a running app without the port is a hard stop.
  await execFileAsync("/usr/bin/open", [
    "-g",
    "-j",
    "-a",
    appPath,
    "--args",
    `--remote-debugging-port=${port}`,
  ]);
}

async function waitForPort(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isCdpPortOpen(port)) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new ChatGptDesktopError(
    "ChatGPT desktop did not expose its debug port in time",
    "timeout",
  );
}

/**
 * Waits for the renderer to exist, not merely for the port to answer.
 *
 * On a cold start the debug port opens before the app has a Chat surface: for
 * the first second or so `/json/list` offers only the avatar overlay, which
 * `selectRendererTarget` correctly refuses. Reading the list once at that
 * moment produced `renderer_missing` about a second after launch — the whole
 * failure mode of a discovery command that ran while ChatGPT happened to be
 * closed, which is exactly when the client launches the app itself.
 *
 * The clock and the sleep are injected so the policy can be tested without
 * waiting for real time or opening a socket.
 */
export async function waitForRendererTarget(
  listTargets: () => Promise<CdpTarget[]>,
  options: {
    timeoutMs: number;
    intervalMs?: number;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
  },
): Promise<CdpTarget> {
  const now = options.now ?? (() => Date.now());
  const sleep =
    options.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const intervalMs = options.intervalMs ?? 500;
  const deadline = now() + Math.max(0, options.timeoutMs);
  // At least one attempt, however little budget is left: a warm app answers on
  // the first read, and refusing to look at all would turn a working
  // installation into an error because an earlier step used up the clock.
  let lastError: unknown = null;
  for (;;) {
    // A cold-starting app can refuse a devtools listing for a moment before it
    // serves one. Treating that first refusal as fatal would reintroduce the
    // failure this loop exists to prevent, by a different door, so a transient
    // error is retried like an empty listing and only reported if the deadline
    // arrives with nothing better.
    let targets: CdpTarget[] = [];
    try {
      targets = await listTargets();
      lastError = null;
    } catch (error) {
      lastError = error;
    }
    const target = selectRendererTarget(targets);
    if (target?.webSocketDebuggerUrl) return target;
    if (now() >= deadline) {
      if (lastError) throw lastError;
      throw new ChatGptDesktopError(
        "ChatGPT desktop renderer was not found",
        "renderer_missing",
        `no ${RENDERER_URL_PREFIX} page appeared within ${Math.max(0, options.timeoutMs)} ms`,
      );
    }
    await sleep(intervalMs);
  }
}

export function selectRendererTarget(targets: CdpTarget[]): CdpTarget | null {
  return (
    targets.find(
      (target) =>
        target.type === "page" &&
        target.url.startsWith(RENDERER_URL_PREFIX) &&
        !RENDERER_URL_EXCLUDES.some((excluded) =>
          target.url.includes(excluded),
        ) &&
        typeof target.webSocketDebuggerUrl === "string",
    ) ?? null
  );
}

/**
 * How long to wait for the chat surface, given whether this client just started
 * the app.
 *
 * A cold start gets whatever remains of the launch budget, because the surface
 * it needs is still being built and cutting that short is the regression this
 * whole path exists to fix. An app that was already answering gets a short
 * grace instead: its renderer exists by definition, so if it is missing now the
 * installation is wrong and waiting three quarters of a minute to say so helps
 * nobody.
 *
 * Extracted and exported because the two arms are one ternary apart, and
 * swapping them restores the original bug while every test still passes. A pure
 * function can be pinned; an expression buried in an I/O path cannot.
 */
export function rendererBudgetMs(
  launched: boolean,
  remainingMs: number,
): number {
  const remaining = Math.max(0, remainingMs);
  return launched ? remaining : Math.min(WARM_RENDERER_GRACE_MS, remaining);
}

export async function resolveRenderer(
  options: DesktopAppOptions = {},
): Promise<{ port: number; target: CdpTarget }> {
  const port = options.port ?? defaultCdpPort();
  const appPath = options.appPath ?? DEFAULT_APP_PATH;
  const launchTimeoutMs = options.launchTimeoutMs ?? 45_000;
  // One budget for the whole startup, shared by both waits, so fixing the
  // renderer race does not silently double how long a broken installation
  // takes to say so.
  const deadline = Date.now() + launchTimeoutMs;
  let launched = false;

  if (!(await isCdpPortOpen(port))) {
    if (!(await isAppInstalled(appPath))) {
      throw new ChatGptDesktopError(
        `ChatGPT desktop is not installed at ${appPath}`,
        "app_not_installed",
      );
    }
    if (await isAppRunning(appPath)) {
      throw new ChatGptDesktopError(
        "ChatGPT desktop is running without a debug port; quit it and let this client relaunch it",
        "app_without_debug_port",
        `expected --remote-debugging-port=${port}`,
      );
    }
    if (options.autoLaunch === false) {
      throw new ChatGptDesktopError(
        "ChatGPT desktop is not running",
        "app_unreachable",
      );
    }
    await launchHidden(appPath, port);
    await waitForPort(port, deadline - Date.now());
    launched = true;
  }

  const target = await waitForRendererTarget(() => listCdpTargets(port), {
    timeoutMs: rendererBudgetMs(launched, deadline - Date.now()),
  });
  return { port, target };
}

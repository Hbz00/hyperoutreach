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

export async function resolveRenderer(
  options: DesktopAppOptions = {},
): Promise<{ port: number; target: CdpTarget }> {
  const port = options.port ?? defaultCdpPort();
  const appPath = options.appPath ?? DEFAULT_APP_PATH;

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
    await waitForPort(port, options.launchTimeoutMs ?? 45_000);
  }

  const target = selectRendererTarget(await listCdpTargets(port));
  if (!target?.webSocketDebuggerUrl) {
    throw new ChatGptDesktopError(
      "ChatGPT desktop renderer was not found",
      "renderer_missing",
      `no ${RENDERER_URL_PREFIX} page on port ${port}`,
    );
  }
  return { port, target };
}

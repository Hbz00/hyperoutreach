import { isCdpPortOpen } from "@/lib/chatgpt-desktop/cdp";
import { defaultCdpPort } from "@/lib/chatgpt-desktop/desktop-app";
import {
  AIProviderConfigurationError,
  resolveAIProviderMode,
} from "@/lib/ai/provider-config";

export type AiSurfaceHealth = {
  mode: "mock" | "chatgpt_desktop" | "misconfigured";
  /** `null` when there is nothing to reach, or nothing valid to reach it with. */
  reachable: boolean | null;
  detail: string;
};

/**
 * Whether the surface every AI task runs on is there at all.
 *
 * Deliberately a port probe and nothing more. Asking the app itself — a real
 * turn, a model list, a surface read — goes through the same single-window
 * serialization queue as production work, so a page render could sit behind a
 * ten-minute research turn. `isCdpPortOpen` is a plain HTTP request with its
 * own short timeout and never enters that queue.
 */
export async function probeAiSurface(
  options: {
    environment?: Record<string, string | undefined>;
    probePort?: (port: number) => Promise<boolean>;
  } = {},
): Promise<AiSurfaceHealth> {
  const environment = options.environment ?? process.env;
  const probePort = options.probePort ?? isCdpPortOpen;

  let mode: "mock" | "chatgpt_desktop";
  try {
    mode = resolveAIProviderMode(environment);
  } catch (error) {
    return {
      mode: "misconfigured",
      reachable: null,
      detail:
        error instanceof AIProviderConfigurationError
          ? error.message
          : "AI_PROVIDER is not a value this build understands",
    };
  }

  if (mode === "mock") {
    return {
      mode,
      reachable: null,
      detail: "Deterministic mock agents. No application is driven.",
    };
  }

  const port = defaultCdpPort(environment);
  const reachable = await probePort(port);
  return {
    mode,
    reachable,
    detail: reachable
      ? `ChatGPT desktop is answering on port ${port}.`
      : `ChatGPT desktop is not answering on port ${port}. Quit it, then relaunch with --remote-debugging-port=${port}.`,
  };
}

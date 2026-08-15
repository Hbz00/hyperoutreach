import { CdpSession } from "@/lib/chatgpt-desktop/cdp";
import {
  awaitAnswer,
  countAssistantMessages,
  listEfforts,
  listModels,
  readSelectedModel,
  readSurface,
  selectEffort,
  selectModel,
  setTemporary,
  startNewChat,
  SELECTORS,
  submitPrompt,
} from "@/lib/chatgpt-desktop/chat-surface";
import {
  resolveRenderer,
  type DesktopAppOptions,
} from "@/lib/chatgpt-desktop/desktop-app";
import { ChatGptDesktopError } from "@/lib/chatgpt-desktop/errors";
import { wait } from "@/lib/chatgpt-desktop/input";

export type ChatGptDesktopRequest = {
  prompt: string;
  /** Display name as shown in the picker, e.g. "GPT-5.6 Sol". */
  model?: string;
  /** Reasoning effort as shown in the picker, e.g. "High". */
  effort?: string;
  /** Temporary chat, so the turn leaves no history. Defaults to true. */
  temporary?: boolean;
  timeoutMs?: number;
};

export type ChatGptDesktopResult = {
  text: string;
  model: string | null;
  effort: string | null;
  temporary: boolean | null;
};

const DEFAULT_TIMEOUT_MS = 300_000;

/**
 * The Chat surface is a single shared window, so overlapping turns would type
 * into each other. Requests queue instead.
 */
let queue: Promise<unknown> = Promise.resolve();

function serialize<T>(task: () => Promise<T>): Promise<T> {
  const result = queue.then(task, task);
  queue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

async function withSurface<T>(
  options: DesktopAppOptions,
  run: (session: CdpSession) => Promise<T>,
): Promise<T> {
  const { target } = await resolveRenderer(options);
  const session = await CdpSession.attach(
    target.webSocketDebuggerUrl as string,
  );
  try {
    return await run(session);
  } finally {
    session.close();
  }
}

export async function askChatGptDesktop(
  request: ChatGptDesktopRequest,
  options: DesktopAppOptions = {},
): Promise<ChatGptDesktopResult> {
  if (request.prompt.trim() === "") {
    throw new ChatGptDesktopError("Prompt must not be empty", "request");
  }
  const temporary = request.temporary ?? true;
  return serialize(() =>
    withSurface(options, async (session) => {
      if (!(await readSurface(session)).hasComposer) {
        throw new ChatGptDesktopError(
          "ChatGPT desktop is not showing the Chat surface",
          "renderer_missing",
          "open the Chat tab once, then retry",
        );
      }

      // The temporary-chat toggle only exists on an empty chat, so the new
      // chat has to come first — both to read the current mode and to set it.
      await startNewChat(session);
      const before = await readSurface(session);
      const outcome = await setTemporary(session, temporary);
      if (outcome === "unavailable") {
        throw new ChatGptDesktopError(
          `ChatGPT desktop could not confirm temporary chat is ${temporary ? "on" : "off"}`,
          "evaluate",
          `no "${SELECTORS.temporaryOn}" control on the surface; refusing to send rather than risk persisting the turn`,
        );
      }

      try {
        if (request.model) await selectModel(session, request.model);
        if (request.effort) await selectEffort(session, request.effort);
        const model =
          request.model ?? (await readSelectedModel(session)) ?? null;
        // `setTemporary` reports that it clicked the control, not that the
        // surface obeyed it. This read already happens, one step before the
        // prompt is sent, so confirming it costs nothing on the happy path.
        // A reading of `null` is left alone — `setTemporary` already confirmed
        // the control was there — and a contradiction is re-read once, because
        // the picker has just closed and its animation should not be able to
        // fail a turn that is in fact correctly configured.
        let state = await readSurface(session);
        if (state.temporary !== null && state.temporary !== temporary) {
          await wait(600);
          state = await readSurface(session);
        }
        if (state.temporary !== null && state.temporary !== temporary) {
          throw new ChatGptDesktopError(
            `ChatGPT desktop did not switch temporary chat ${temporary ? "on" : "off"}`,
            "evaluate",
            "the control was clicked but the surface still reports the other mode",
          );
        }

        const baselineCount = await countAssistantMessages(session);
        await submitPrompt(session, request.prompt);
        const text = await awaitAnswer(session, {
          timeoutMs: request.timeoutMs ?? DEFAULT_TIMEOUT_MS,
          baselineCount,
        });
        return {
          text,
          model,
          effort: state.effort,
          temporary: state.temporary,
        };
      } finally {
        if (outcome === "toggled") {
          // Restoring needs the empty-chat surface the toggle lives on.
          await startNewChat(session);
          await setTemporary(session, before.temporary ?? false);
        }
      }
    }),
  );
}

export function listChatGptDesktopModels(
  options: DesktopAppOptions = {},
): Promise<string[]> {
  return serialize(() => withSurface(options, listModels));
}

export function listChatGptDesktopEfforts(
  options: DesktopAppOptions = {},
): Promise<string[]> {
  return serialize(() => withSurface(options, listEfforts));
}

export function readChatGptDesktopSurface(options: DesktopAppOptions = {}) {
  return serialize(() => withSurface(options, readSurface));
}

import { afterEach, describe, expect, it, vi } from "vitest";

import { CdpSession } from "@/lib/chatgpt-desktop/cdp";
import { ChatGptDesktopError } from "@/lib/chatgpt-desktop/errors";

class LocalSocket extends EventTarget {
  static latest: LocalSocket;
  send = vi.fn<(data: string) => void>();
  constructor() {
    super();
    LocalSocket.latest = this;
    queueMicrotask(() => this.dispatchEvent(new Event("open")));
  }
  close() {
    this.dispatchEvent(new Event("close"));
  }
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("CDP command resource cleanup", () => {
  it.each(["send", "serialization"])(
    "cleans a synchronous %s failure without retaining a request deadline or raw detail",
    async (failure) => {
      vi.useFakeTimers();
      vi.stubGlobal("WebSocket", LocalSocket);
      const session = await CdpSession.attach("ws://synthetic.invalid");
      try {
        const params: Record<string, unknown> = {};
        if (failure === "send") {
          LocalSocket.latest.send.mockImplementation(() => {
            throw new Error("synthetic-private-response-canary");
          });
        } else {
          params.self = params;
        }
        const error = await session
          .command("Runtime.evaluate", params)
          .catch((error: unknown) => error);
        expect(vi.getTimerCount()).toBe(0);
        expect(error).toBeInstanceOf(ChatGptDesktopError);
        expect(error).toMatchObject({ code: "app_unreachable" });
        expect(String(error)).not.toContain(
          "synthetic-private-response-canary",
        );
      } finally {
        session.close();
      }
    },
  );

  it("settles an unanswered command at its deadline and permits a later response", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", LocalSocket);
    const session = await CdpSession.attach("ws://synthetic.invalid");
    try {
      const pending = session.command("Runtime.evaluate", {}, 100);
      const failure = pending.catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(100);
      expect(await failure).toMatchObject({ code: "timeout" });
      expect(vi.getTimerCount()).toBe(0);
      const following = session.command("Runtime.evaluate", {}, 100);
      const sent = JSON.parse(LocalSocket.latest.send.mock.calls.at(-1)![0]);
      LocalSocket.latest.dispatchEvent(
        new MessageEvent("message", {
          data: JSON.stringify({
            id: sent.id,
            result: { result: { value: 7 } },
          }),
        }),
      );
      expect(await following).toMatchObject({
        result: { result: { value: 7 } },
      });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      session.close();
    }
  });
});

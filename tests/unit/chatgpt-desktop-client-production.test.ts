import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const surface = vi.hoisted(() => ({
  readSurface: vi.fn(),
  startNewChat: vi.fn(),
  setTemporary: vi.fn(),
  selectModel: vi.fn(),
  selectEffort: vi.fn(),
  readSelectedModel: vi.fn(),
  countAssistantMessages: vi.fn(),
  submitPrompt: vi.fn(),
  awaitAnswer: vi.fn(),
  close: vi.fn(),
}));

vi.mock("@/lib/chatgpt-desktop/cdp", () => ({
  CdpSession: { attach: async () => ({ close: surface.close }) },
}));
vi.mock("@/lib/chatgpt-desktop/desktop-app", () => ({
  resolveRenderer: async () => ({
    target: { webSocketDebuggerUrl: "ws://127.0.0.1:33105/fixture" },
  }),
}));
vi.mock("@/lib/chatgpt-desktop/chat-surface", () => ({
  ...surface,
  SELECTORS: { temporaryOn: "Turn on temporary chat" },
  listModels: vi.fn(),
  listEfforts: vi.fn(),
}));
vi.mock("@/lib/chatgpt-desktop/input", () => ({ wait: async () => undefined }));

import { askChatGptDesktop } from "@/lib/chatgpt-desktop/client";

const ready = {
  hasComposer: true,
  model: null,
  effort: "Low",
  temporary: true,
};
const request = {
  prompt: "Synthetic audit fixture only",
  model: "Fixture model",
  effort: "Low",
  temporary: true,
};

beforeEach(() => {
  vi.resetAllMocks();
  surface.readSurface.mockResolvedValue(ready);
  surface.startNewChat.mockResolvedValue(true);
  surface.setTemporary.mockResolvedValue("already");
  surface.readSelectedModel.mockResolvedValue("Fixture model");
  surface.countAssistantMessages.mockResolvedValue(0);
  surface.awaitAnswer.mockResolvedValue("Fixture answer");
});

afterEach(() => vi.restoreAllMocks());

describe("desktop client state confirmation before prompt submission", () => {
  it("refuses when the new-chat action cannot be performed", async () => {
    surface.startNewChat.mockResolvedValue(false);
    await expect(askChatGptDesktop(request)).rejects.toThrow(/new chat/i);
    expect(surface.submitPrompt).not.toHaveBeenCalled();
    expect(surface.awaitAnswer).not.toHaveBeenCalled();
    expect(surface.close).toHaveBeenCalledOnce();
  });

  it("refuses a clicked new-chat action that leaves prior assistant content", async () => {
    surface.countAssistantMessages.mockResolvedValue(2);
    await expect(askChatGptDesktop(request)).rejects.toThrow(/empty chat/i);
    expect(surface.submitPrompt).not.toHaveBeenCalled();
    expect(surface.close).toHaveBeenCalledOnce();
  });

  it.each([null, false])(
    "refuses an unconfirmed temporary state %s immediately before submission",
    async (temporary) => {
      surface.readSurface
        .mockResolvedValueOnce(ready)
        .mockResolvedValueOnce(ready)
        .mockResolvedValue({ ...ready, temporary });
      await expect(askChatGptDesktop(request)).rejects.toThrow(
        /temporary chat/i,
      );
      expect(surface.submitPrompt).not.toHaveBeenCalled();
      expect(surface.close).toHaveBeenCalledOnce();
    },
  );

  it.each([null, "Another model"])(
    "refuses when the requested model was not confirmed: %s",
    async (model) => {
      surface.readSelectedModel.mockResolvedValue(model);
      await expect(askChatGptDesktop(request)).rejects.toThrow(/model/i);
      expect(surface.selectModel).toHaveBeenCalledOnce();
      expect(surface.submitPrompt).not.toHaveBeenCalled();
      expect(surface.close).toHaveBeenCalledOnce();
    },
  );

  it.each([null, "High"])(
    "refuses when the requested effort was not confirmed: %s",
    async (effort) => {
      surface.readSurface.mockResolvedValue({ ...ready, effort });
      await expect(askChatGptDesktop(request)).rejects.toThrow(/effort/i);
      expect(surface.selectEffort).toHaveBeenCalledOnce();
      expect(surface.submitPrompt).not.toHaveBeenCalled();
      expect(surface.close).toHaveBeenCalledOnce();
    },
  );

  it("submits once with confirmed state and reports the observed model", async () => {
    surface.readSelectedModel.mockResolvedValue("FIXTURE MODEL");
    await expect(askChatGptDesktop(request)).resolves.toEqual({
      text: "Fixture answer",
      model: "FIXTURE MODEL",
      effort: "Low",
      temporary: true,
    });
    expect(surface.submitPrompt).toHaveBeenCalledExactlyOnceWith(
      expect.anything(),
      request.prompt,
    );
    expect(surface.close).toHaveBeenCalledOnce();
  });

  it("allows an explicitly non-temporary request after confirming it", async () => {
    surface.readSurface.mockResolvedValue({ ...ready, temporary: false });
    await expect(
      askChatGptDesktop({ ...request, temporary: false }),
    ).resolves.toMatchObject({ temporary: false });
    expect(surface.submitPrompt).toHaveBeenCalledOnce();
  });

  it("releases the shared queue after refusing a turn", async () => {
    surface.startNewChat.mockResolvedValueOnce(false);
    const first = askChatGptDesktop(request);
    const second = askChatGptDesktop(request);
    await expect(first).rejects.toThrow(/new chat/i);
    await expect(second).resolves.toMatchObject({ text: "Fixture answer" });
    expect(surface.submitPrompt).toHaveBeenCalledOnce();
    expect(surface.close).toHaveBeenCalledTimes(2);
  });

  it("does not submit when surface preparation has consumed the deadline", async () => {
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    surface.selectModel.mockImplementation(async () => {
      now = 101;
    });
    await expect(
      askChatGptDesktop({ ...request, timeoutMs: 100 }),
    ).rejects.toThrow(/timed out/i);
    expect(surface.submitPrompt).not.toHaveBeenCalled();
    expect(surface.close).toHaveBeenCalledOnce();
  });

  it("gives answer collection only the unspent part of the deadline", async () => {
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    surface.submitPrompt.mockImplementation(async () => {
      now = 75;
    });
    await expect(
      askChatGptDesktop({ ...request, timeoutMs: 100 }),
    ).resolves.toMatchObject({ text: "Fixture answer" });
    expect(surface.awaitAnswer).toHaveBeenCalledExactlyOnceWith(
      expect.anything(),
      { timeoutMs: 25, baselineCount: 0 },
    );
  });

  it("refuses an expired queued request before touching its surface", async () => {
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    surface.awaitAnswer.mockImplementationOnce(async () => {
      await held;
      return "First answer";
    });
    const first = askChatGptDesktop({ ...request, timeoutMs: 1_000 });
    const second = askChatGptDesktop({ ...request, timeoutMs: 100 });
    try {
      await vi.waitFor(() =>
        expect(surface.awaitAnswer).toHaveBeenCalledOnce(),
      );
      now = 101;
      release();
      await expect(first).resolves.toMatchObject({ text: "First answer" });
      await expect(second).rejects.toThrow(/timed out/i);
      expect(surface.startNewChat).toHaveBeenCalledOnce();
      expect(surface.submitPrompt).toHaveBeenCalledOnce();
    } finally {
      release();
      await Promise.allSettled([first, second]);
    }
  });
});

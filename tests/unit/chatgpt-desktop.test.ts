import { describe, expect, it } from "vitest";

import type { CdpSession, CdpTarget } from "@/lib/chatgpt-desktop/cdp";
import { ChatGptDesktopError } from "@/lib/chatgpt-desktop/errors";
import {
  awaitAnswer,
  EXTRACT_ANSWER,
  SELECTORS,
} from "@/lib/chatgpt-desktop/chat-surface";
import {
  defaultCdpPort,
  selectRendererTarget,
} from "@/lib/chatgpt-desktop/desktop-app";

function target(overrides: Partial<CdpTarget>): CdpTarget {
  return {
    id: "id",
    type: "page",
    title: "Codex",
    url: "app://-/index.html",
    webSocketDebuggerUrl: "ws://127.0.0.1:9333/devtools/page/id",
    ...overrides,
  };
}

describe("selectRendererTarget", () => {
  it("picks the app shell page that hosts the chat surface", () => {
    const shell = target({ id: "shell" });
    expect(
      selectRendererTarget([
        target({
          id: "webview",
          type: "webview",
          url: "https://chatgpt.com/",
        }),
        shell,
      ]),
    ).toBe(shell);
  });

  it("ignores the avatar overlay window", () => {
    expect(
      selectRendererTarget([
        target({
          id: "overlay",
          url: "app://-/index.html?initialRoute=%2Favatar-overlay",
        }),
      ]),
    ).toBeNull();
  });

  it("ignores the bundled chatgpt.com webview", () => {
    // That context reaches the backend only through the web integrity path,
    // which this client deliberately does not use.
    expect(
      selectRendererTarget([
        target({ id: "webview", type: "webview", url: "https://chatgpt.com/" }),
      ]),
    ).toBeNull();
  });

  it("ignores a target without a debugger socket", () => {
    const withoutSocket = target({});
    delete withoutSocket.webSocketDebuggerUrl;
    expect(selectRendererTarget([withoutSocket])).toBeNull();
  });

  it("returns null when the app exposes no targets", () => {
    expect(selectRendererTarget([])).toBeNull();
  });
});

type FakeNode = {
  nodeType: number;
  tagName?: string;
  nodeValue?: string;
  childNodes?: FakeNode[];
  children?: FakeNode[];
  textContent?: string;
};

function text(value: string): FakeNode {
  return { nodeType: 3, nodeValue: value };
}

function el(
  tagName: string,
  childNodes: FakeNode[] = [],
  textContent = "",
): FakeNode {
  return {
    nodeType: 1,
    tagName,
    childNodes,
    children: childNodes.filter((node) => node.nodeType === 1),
    textContent,
  };
}

function extract(root: FakeNode): string {
  const compiled = new Function(`return ${EXTRACT_ANSWER}`)() as (
    node: FakeNode,
    isRoot: boolean,
  ) => string;
  return compiled(root, true);
}

const URL = "https://example.com/e/business-meetings/participations/769983";

describe("EXTRACT_ANSWER", () => {
  it("does not break a linkified URL inside a JSON string", () => {
    // This is the shape that corrupted a real answer: the renderer turns the
    // bare URL into an anchor, and innerText reports a line break around it.
    const answer = extract(
      el("DIV", [
        el("P", [
          text('{"url": "'),
          el("A", [text(URL)]),
          text('", "title": null}'),
        ]),
      ]),
    );
    expect(answer).toBe(`{"url": "${URL}", "title": null}`);
    expect(() => JSON.parse(answer)).not.toThrow();
  });

  it("keeps the line breaks a <br> stands for", () => {
    expect(
      extract(
        el("DIV", [
          el("P", [text("{"), el("BR"), text('"a": 1'), el("BR"), text("}")]),
        ]),
      ),
    ).toBe('{\n"a": 1\n}');
  });

  it("copies a code block verbatim and drops its chrome", () => {
    const wrapper = el("DIV", [
      el("SPAN", [text("json")]),
      el("BUTTON", [text("Copy")]),
      el("PRE", [], '{\n  "a": 1\n}'),
    ]);
    expect(extract(el("DIV", [wrapper]))).toBe('{\n  "a": 1\n}');
  });

  it("keeps prose that sits beside a code block", () => {
    const answer = extract(
      el("DIV", [
        el("P", [text("Voici :")]),
        el("DIV", [el("PRE", [], "{}")]),
        el("P", [text("Fin.")]),
      ]),
    );
    expect(answer).toBe("Voici :\n\n{}\n\nFin.");
  });

  it("keeps paragraph breaks in prose", () => {
    expect(
      extract(
        el("DIV", [el("P", [text("First.")]), el("P", [text("Second.")])]),
      ),
    ).toBe("First.\n\nSecond.");
  });

  it("collapses the whitespace the markup carries", () => {
    expect(extract(el("DIV", [el("P", [text("  OK   now  ")])]))).toBe(
      "OK now",
    );
  });
});

describe("defaultCdpPort", () => {
  it("falls back to the port the app is normally launched with", () => {
    expect(defaultCdpPort({})).toBe(9333);
  });

  it("honours CHATGPT_DESKTOP_CDP_PORT", () => {
    expect(defaultCdpPort({ CHATGPT_DESKTOP_CDP_PORT: "9444" })).toBe(9444);
  });

  it("ignores a value that is not a usable port", () => {
    for (const value of ["abc", "0", "-1", "70000", ""]) {
      expect(defaultCdpPort({ CHATGPT_DESKTOP_CDP_PORT: value })).toBe(9333);
    }
  });
});

describe("SELECTORS", () => {
  it("keeps every app hook in one place so an update is a single-line fix", () => {
    expect(SELECTORS).toMatchObject({
      composer: '[role="textbox"][aria-label="Message ChatGPT"]',
      modelTrigger: '[aria-label="Select ChatGPT model"]',
      assistantMessage: '[data-markdown-text-style="assistant-message"]',
      temporaryOn: "Turn on temporary chat",
      temporaryOff: "Turn off temporary chat",
    });
  });
});

type Snapshot = { count: number; text: string; generating: boolean };

/** A session that replays scripted surface snapshots, one per poll. */
function replaying(snapshots: Snapshot[]): CdpSession {
  let index = 0;
  return {
    evaluate: async () => {
      const snapshot = snapshots[Math.min(index, snapshots.length - 1)]!;
      index += 1;
      return snapshot;
    },
  } as unknown as CdpSession;
}

describe("awaitAnswer", () => {
  it("accepts a stable answer once generation is known to have stopped", async () => {
    const snapshots: Snapshot[] = [
      { count: 1, text: "partial", generating: true },
      { count: 1, text: "the whole answer", generating: false },
      { count: 1, text: "the whole answer", generating: false },
      { count: 1, text: "the whole answer", generating: false },
    ];

    await expect(
      awaitAnswer(replaying(snapshots), {
        timeoutMs: 5_000,
        quietMs: 400,
        baselineCount: 0,
      }),
    ).resolves.toBe("the whole answer");
  });

  it("does not mistake a pause in streaming for a finished answer", async () => {
    // The stop control never matches — a renamed or localised label. A pause
    // long enough for the old rule now buys patience, not a truncated answer.
    const paused: Snapshot = {
      count: 1,
      text: "half an ans",
      generating: false,
    };
    const finished: Snapshot = {
      count: 1,
      text: "half an answer, then the rest",
      generating: false,
    };

    await expect(
      awaitAnswer(
        replaying([
          paused,
          paused,
          paused,
          finished,
          finished,
          finished,
          finished,
          finished,
        ]),
        { timeoutMs: 8_000, quietMs: 400, baselineCount: 0 },
      ),
    ).resolves.toBe("half an answer, then the rest");
  });

  it("reports the partial instead of passing it off as the answer", async () => {
    const failure = await awaitAnswer(
      replaying([{ count: 1, text: "started", generating: true }]),
      { timeoutMs: 900, quietMs: 400, baselineCount: 0 },
    ).catch((error: unknown) => error as Error);

    expect(failure).toBeInstanceOf(ChatGptDesktopError);
    expect((failure as ChatGptDesktopError).code).toBe("timeout");
    expect((failure as ChatGptDesktopError).detail).toContain("partial answer");
  });
});

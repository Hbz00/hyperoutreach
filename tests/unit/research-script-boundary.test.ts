import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const fixture = vi.hoisted(() => ({
  run: vi.fn(),
  body: "",
  requests: [] as string[],
  writes: [] as string[],
  ask: vi.fn(),
  sleep: vi.fn(async () => {}),
}));
vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(async () => [{ address: "8.8.8.8", family: 4 }]),
}));
vi.mock("node:http", async () => {
  const { EventEmitter } = await import("node:events");
  const { Readable } = await import("node:stream");
  return {
    request: (
      url: URL,
      _options: unknown,
      callback: (response: unknown) => void,
    ) => {
      fixture.requests.push(url.toString());
      const req = new EventEmitter() as InstanceType<typeof EventEmitter> & {
        end: () => void;
      };
      req.end = () => {
        const response = Object.assign(
          Readable.from([Buffer.from(fixture.body)]),
          { statusCode: 200, headers: { "content-type": "text/plain" } },
        );
        callback(response);
      };
      return req;
    },
  };
});
vi.mock("node:https", async () => ({
  request: (await import("node:http")).request,
}));
vi.mock("node:timers/promises", () => ({ setTimeout: fixture.sleep }));
vi.mock("node:fs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs")>()),
  writeFileSync: (_path: string, content: string) =>
    fixture.writes.push(content),
}));
vi.mock("@/lib/chatgpt-desktop", () => ({
  askChatGptDesktop: fixture.ask,
  listChatGptDesktopModels: fixture.ask,
  listChatGptDesktopEfforts: fixture.ask,
  ChatGptDesktopError: class extends Error {},
}));
vi.mock("dotenv", () => ({ config: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/db/client-core", () => ({
  getDatabase: () => ({
    select: () => ({
      from: () => ({ limit: async () => [], where: async () => [] }),
    }),
  }),
}));
vi.mock("@/lib/ai/production-provider-bundle", () => ({
  createProductionAIProviderBundle: () => ({
    usesRealInfrastructure: true,
    mode: "chatgpt_desktop",
    research: { provider: { run: fixture.run }, model: "synthetic-research" },
    nonWeb: { provider: { run: fixture.run }, model: "synthetic-fast" },
  }),
}));
const originalArgv = process.argv;
const originalExitCode = process.exitCode;
let stdout: string;
let exits: number[];
beforeEach(() => {
  vi.resetModules();
  fixture.run.mockReset();
  fixture.requests = [];
  fixture.writes = [];
  fixture.ask.mockReset();
  fixture.sleep.mockClear();
  fixture.body = "";
  stdout = "";
  exits = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
    stdout += String(chunk);
    return true;
  });
  vi.spyOn(process, "exit").mockImplementation(
    (code?: string | number | null) => {
      exits.push(Number(code ?? 0));
      throw new Error("synthetic-script-exit");
    },
  );
  process.exitCode = undefined;
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  process.argv = originalArgv;
  process.exitCode = originalExitCode;
});
function samples(sourceUrl: string) {
  return {
    output: {
      samples: [
        {
          firstName: "Ada",
          lastName: "Lovelace",
          email: "ada.lovelace@acme.example",
          sourceUrl,
        },
        {
          firstName: "Grace",
          lastName: "Hopper",
          email: "grace.hopper@acme.example",
          sourceUrl,
        },
      ],
    },
  };
}
async function runPublic() {
  process.argv = ["node", "public-email-probe.ts", "--domain", "acme.example"];
  await expect(import("../../scripts/public-email-probe")).rejects.toThrow(
    "synthetic-script-exit",
  );
}
describe("actual CLI research boundaries with all I/O injected", () => {
  it("does not fetch a model-provided private endpoint", async () => {
    fixture.run.mockResolvedValue(
      samples("http://127.0.0.1:3105/internal-admin?command=synthetic"),
    );
    const fetcher = vi.fn(
      async () =>
        new Response("synthetic body", {
          status: 200,
          headers: { "content-type": "text/plain" },
        }),
    );
    vi.stubGlobal("fetch", fetcher);
    await runPublic();
    expect(fixture.run).toHaveBeenCalledTimes(2);
    expect(fetcher).not.toHaveBeenCalled();
    expect(fixture.requests).toEqual([]);
  });
  it("does not verify substrings of different addresses as literal evidence", async () => {
    fixture.run.mockResolvedValue(samples("https://acme.example/team"));
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            "otherada.lovelace@acme.example.invalid othergrace.hopper@acme.example.invalid",
            { headers: { "content-type": "text/plain" } },
          ),
      ),
    );
    fixture.body =
      "otherada.lovelace@acme.example.invalid othergrace.hopper@acme.example.invalid";
    await runPublic();
    expect(stdout).toContain("verified 0, unverified 2");
    expect(stdout).not.toContain(" RESOLVES");
  });
  it("returns failure when every personalization attempt fails", async () => {
    fixture.run.mockRejectedValue(new Error("synthetic provider unavailable"));
    process.argv = ["node", "personalization-probe.ts", "--runs", "2"];
    await import("../../scripts/personalization-probe");
    expect(fixture.run).toHaveBeenCalledTimes(2);
    expect(stdout).toContain("contract held:        0/2");
    expect(process.exitCode).toBe(1);
  });
  it("rejects trailing garbage in run counts before spending live turns", async () => {
    fixture.run.mockRejectedValue(new Error("synthetic provider unavailable"));
    process.argv = ["node", "personalization-probe.ts", "--runs", "2oops"];
    await import("../../scripts/personalization-probe").catch(
      (error: Error) => {
        if (error.message !== "synthetic-script-exit") throw error;
      },
    );
    expect(fixture.run).not.toHaveBeenCalled();
    expect(exits).toEqual([1]);
  });
  it("returns nonzero when every job-title arm fails and records all four results", async () => {
    fixture.run.mockRejectedValue(new Error("synthetic provider unavailable"));
    process.argv = ["node", "job-title-probe.ts", "synthetic-output.json"];
    await expect(import("../../scripts/job-title-probe")).rejects.toThrow(
      "synthetic-script-exit",
    );
    expect(fixture.run).toHaveBeenCalledTimes(4);
    expect(fixture.sleep).toHaveBeenCalledTimes(3);
    expect(exits).toEqual([1]);
    expect(JSON.parse(fixture.writes.at(-1)!)).toHaveLength(4);
  });
  it.each(["2oops", "1.5", "1e2", "", "0", "26"])(
    "rejects invalid public-email domain count %s before provider turns",
    async (count) => {
      process.argv = ["node", "public-email-probe.ts", "--domains", count];
      await expect(import("../../scripts/public-email-probe")).rejects.toThrow(
        "synthetic-script-exit",
      );
      expect(fixture.run).not.toHaveBeenCalled();
      expect(fixture.requests).toEqual([]);
      expect(exits).toEqual([1]);
    },
  );
  it.each([
    ["--timeout", "12oops"],
    ["--timeout", "1.5"],
    ["--timeout", "9007199254740993"],
    ["--port", "9333oops"],
    ["--port", "65536"],
    ["--port", "0"],
  ])("rejects ChatGPT %s %s before touching the app", async (flag, value) => {
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    process.argv = ["node", "chatgpt.ts", flag!, value!, "synthetic prompt"];
    await import("../../scripts/chatgpt");
    expect(process.exitCode).toBe(2);
    expect(fixture.ask).not.toHaveBeenCalled();
  });
  it("accepts real whole-address evidence and exits successfully", async () => {
    fixture.run.mockResolvedValue(samples("https://acme.example/team"));
    fixture.body =
      "Contact Ada.Lovelace@acme.example or Grace.Hopper@acme.example.";
    await runPublic();
    expect(fixture.run).toHaveBeenCalledTimes(2);
    expect(stdout).toContain("verified 2, unverified 0");
    expect(stdout).toContain(" RESOLVES");
    expect(exits).toEqual([0]);
  });
});

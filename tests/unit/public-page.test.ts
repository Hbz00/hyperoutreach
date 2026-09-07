import {
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  mkdtemp,
  readFile,
  writeFile,
  chmod,
  rm,
  access,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Socket } from "node:net";
import type { RequestOptions, IncomingMessage } from "node:http";

const io = vi.hoisted(() => ({
  lookup: vi.fn(),
  requests: [] as Array<{ url: string; options: RequestOptions }>,
  port: 33105,
}));
vi.mock("node:dns/promises", () => ({ lookup: io.lookup }));
vi.mock("node:http", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:http")>();
  return {
    ...real,
    request: (
      url: URL,
      options: RequestOptions,
      callback: (res: IncomingMessage) => void,
    ) => {
      io.requests.push({ url: url.toString(), options });
      // Only the fixture rewires the connection. Production's selected public
      // address remains captured in options.lookup and is asserted separately.
      return real.request(
        {
          ...options,
          hostname: "127.0.0.1",
          port: io.port,
          path: url.pathname,
          lookup: undefined,
          headers: { ...options.headers, host: url.host },
        },
        callback,
      );
    },
  };
});
vi.mock("node:https", async () => ({
  request: (await import("node:http")).request,
}));
const { containsEmailToken, isPublicAddress, readPublicPage } =
  await import("../../scripts/lib/public-page");
const { createServer } = await import("node:http");
const sockets = new Set<Socket>();
const server = createServer((req, res) => {
  switch (req.url) {
    case "/private":
      res.writeHead(302, { location: "http://127.0.0.1:33105/admin" });
      res.end();
      break;
    case "/mixed":
      res.writeHead(302, { location: "http://mixed.example/admin" });
      res.end();
      break;
    case "/loop":
      res.writeHead(302, { location: "/loop" });
      res.end();
      break;
    case "/large":
      res.writeHead(200, { "content-length": "9000000" });
      res.write("x");
      break;
    case "/chunked":
      res.writeHead(200);
      res.write("x".repeat(64));
      break;
    case "/compressed":
      res.writeHead(200, { "content-encoding": "gzip" });
      res.write("compressed bytes");
      break;
    case "/stall":
      break;
    case "/partial":
      res.writeHead(200);
      res.write("incomplete");
      res.socket?.destroy();
      break;
    case "/pdf":
      res.writeHead(200, { "content-type": "application/pdf" });
      res.end("synthetic PDF bytes");
      break;
    default:
      res.end("Contact Ada.Lovelace@acme.example for details.");
  }
});
server.on("connection", (socket) => {
  sockets.add(socket);
  socket.once("close", () => sockets.delete(socket));
});
beforeAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(io.port, "127.0.0.1", resolve);
  });
});
afterAll(async () => {
  for (const socket of sockets) socket.destroy();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});
beforeEach(() => {
  io.requests = [];
  io.lookup.mockReset().mockResolvedValue([{ address: "8.8.8.8", family: 4 }]);
});
afterEach(async () => {
  await vi.waitFor(() => expect(sockets.size).toBe(0), {
    timeout: 1000,
    interval: 10,
  });
});

describe("public page network boundary", () => {
  it.each([
    "0.0.0.0",
    "10.0.0.1",
    "100.64.0.1",
    "127.0.0.1",
    "169.254.169.254",
    "172.16.0.1",
    "192.168.1.2",
    "192.0.2.1",
    "198.18.1.1",
    "198.51.100.1",
    "203.0.113.1",
    "224.0.0.1",
    "255.255.255.255",
    "::1",
    "::ffff:127.0.0.1",
    "::ffff:8.8.8.8",
    "fe80::1",
    "fc00::1",
    "2001:db8::1",
    "2002:7f00:1::",
    "3fff::1",
  ])("rejects non-public parsed IP %s", (ip) => {
    expect(isPublicAddress(ip)).toBe(false);
  });
  it.each([
    "8.8.8.8",
    "1.1.1.1",
    "2606:4700:4700::1111",
    "2001:4860:4860::8888",
  ])("permits public unicast %s", (ip) => {
    expect(isPublicAddress(ip)).toBe(true);
  });
  it.each([
    "http://2130706433/admin",
    "http://0x7f000001/admin",
    "http://0177.0.0.1/admin",
    "http://[::ffff:127.0.0.1]/admin",
    "file:///tmp/no-read",
    "http://user:password@public.example/",
  ])("refuses URL before a connection: %s", async (url) => {
    expect(await readPublicPage(url)).toBeNull();
    expect(io.requests).toHaveLength(0);
    expect(io.lookup).not.toHaveBeenCalled();
  });
  it("pins the exact validated DNS address and never resolves again on connection", async () => {
    expect(await readPublicPage("http://public.example/ok")).toContain(
      "Ada.Lovelace",
    );
    expect(io.lookup).toHaveBeenCalledTimes(1);
    const lookup = io.requests[0]!.options.lookup!;
    io.lookup.mockResolvedValue([{ address: "127.0.0.1", family: 4 }]);
    const callback = vi.fn();
    lookup("public.example", { all: true }, callback);
    expect(callback).toHaveBeenCalledWith(null, [
      { address: "8.8.8.8", family: 4 },
    ]);
    expect(io.lookup).toHaveBeenCalledTimes(1);
    const single = vi.fn();
    lookup("public.example", {}, single);
    expect(single).toHaveBeenCalledWith(null, "8.8.8.8", 4);
  });
  it("rejects mixed public/private DNS answers before connection", async () => {
    io.lookup.mockResolvedValue([
      { address: "8.8.8.8", family: 4 },
      { address: "::ffff:127.0.0.1", family: 6 },
    ]);
    expect(await readPublicPage("http://mixed.example/")).toBeNull();
    expect(io.requests).toHaveLength(0);
  });
  it.each(["private", "mixed"])(
    "validates every redirect target (%s)",
    async (path) => {
      io.lookup.mockImplementation(async (host) =>
        host === "mixed.example"
          ? [{ address: "169.254.169.254", family: 4 }]
          : [{ address: "8.8.8.8", family: 4 }],
      );
      expect(await readPublicPage(`http://public.example/${path}`)).toBeNull();
      expect(io.requests).toHaveLength(1);
    },
  );
  it("bounds redirect chains and closes every response", async () => {
    expect(await readPublicPage("http://public.example/loop")).toBeNull();
    expect(io.requests).toHaveLength(4);
  });
  it.each(["large", "chunked"])(
    "refuses %s oversized body and closes its socket",
    async (path) => {
      expect(
        await readPublicPage(`http://public.example/${path}`, { maxBytes: 32 }),
      ).toBeNull();
      expect(io.requests).toHaveLength(1);
    },
  );
  it("times out stalled DNS without opening a late connection", async () => {
    let resolveDns!: (v: unknown) => void;
    io.lookup.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveDns = resolve;
        }),
    );
    expect(
      await readPublicPage("http://public.example/", { timeoutMs: 30 }),
    ).toBeNull();
    resolveDns([{ address: "8.8.8.8", family: 4 }]);
    await new Promise((resolve) => setImmediate(resolve));
    expect(io.requests).toHaveLength(0);
  });
  it("times out stalled HTTP and closes its socket", async () => {
    expect(
      await readPublicPage("http://public.example/stall", { timeoutMs: 50 }),
    ).toBeNull();
  });
  it("refuses compressed responses without inflating them", async () => {
    expect(await readPublicPage("http://public.example/compressed")).toBeNull();
  });
  it("treats interrupted bodies as unreadable", async () => {
    expect(await readPublicPage("http://public.example/partial")).toBeNull();
  });
  it.each(["deadline", "output_limit"] as const)(
    "kills an actual PDF child on %s and removes its temporary file",
    async (mode) => {
      const directory = await mkdtemp(
        join(tmpdir(), "public-page-child-test-"),
      );
      const pidFile = join(directory, "pid.json");
      const executable = join(directory, "pdftotext");
      const originalPath = process.env.PATH;
      let pid: number | undefined;
      let reading: Promise<string | null> | undefined;
      try {
        const quotedPidFile = "'" + pidFile.replaceAll("'", "'\"'\"'") + "'";
        await writeFile(
          executable,
          `#!/bin/sh\nprintf '%s\\n' "$$" "$1" > ${quotedPidFile}\ntrap '' TERM\n${mode === "output_limit" ? `printf '%s' '${"x".repeat(1024)}'\n` : ""}exec /bin/sleep 300\n`,
        );
        await chmod(executable, 0o700);
        process.env.PATH = `${directory}:${originalPath ?? ""}`;
        const { execFile } = await import("node:child_process");
        const { promisify } = await import("node:util");
        const resolved = await promisify(execFile)("which", ["pdftotext"]);
        expect(resolved.stdout.trim()).toBe(executable);
        // The old 300ms budget sometimes expired before the shell started,
        // leaving no child to test. Observe startup explicitly and allow for
        // loaded-host startup while retaining an actual enforced deadline.
        reading = readPublicPage("http://public.example/pdf", {
          timeoutMs: 3000,
          maxBytes: mode === "output_limit" ? 64 : undefined,
        });
        let file = "";
        await vi.waitFor(
          async () => {
            const recorded = (await readFile(pidFile, "utf8"))
              .trim()
              .split("\n");
            pid = Number(recorded[0]);
            file = recorded[1] ?? "";
            expect(Number.isSafeInteger(pid) && pid > 0).toBe(true);
            expect(file).toMatch(/probe-pdf-.*\/page\.pdf$/);
          },
          { timeout: 2000, interval: 10 },
        );
        if (mode === "deadline")
          expect(() => process.kill(pid!, 0)).not.toThrow();
        expect(await reading).toBeNull();
        expect(() => process.kill(pid!, 0)).toThrow(
          expect.objectContaining({ code: "ESRCH" }),
        );
        await expect(access(dirname(file))).rejects.toMatchObject({
          code: "ENOENT",
        });
      } finally {
        if (originalPath === undefined) delete process.env.PATH;
        else process.env.PATH = originalPath;
        if (pid) {
          try {
            process.kill(pid, "SIGKILL");
          } catch {}
        }
        await reading;
        await rm(directory, { recursive: true, force: true });
      }
    },
    10_000,
  );
});

describe("whole email evidence tokens", () => {
  it.each([
    "otherada.lovelace@acme.example",
    "ada.lovelace@acme.example.invalid",
    "ada.lovelace@acme.example-other",
    "x+ada.lovelace@acme.example",
    "éada.lovelace@acme.example",
    "中ada.lovelace@acme.example",
    "ada.lovelace@acme.exampleé",
    "ada.lovelace@acme.example.公司",
    "ada.lovelace@acme.example\u0301",
  ])("refuses a substring of %s", (text) =>
    expect(containsEmailToken(text, "ada.lovelace@acme.example")).toBe(false),
  );
  it.each([
    "Ada.Lovelace@acme.example",
    "<ada.lovelace@acme.example>",
    "mailto:ada.lovelace@acme.example",
    "Contact ada.lovelace@acme.example. Thank you.",
  ])("recognizes a whole address in %s", (text) =>
    expect(containsEmailToken(text, "ada.lovelace@acme.example")).toBe(true),
  );
});

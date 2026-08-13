import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
  ProcessRequest,
  ProcessResult,
  ProcessRunner,
} from "@/lib/codex/process-runner";

vi.mock("server-only", () => ({}));

class CapturingRunner implements ProcessRunner {
  requests: ProcessRequest[] = [];

  constructor(private readonly outcome: ProcessResult | Error) {}

  async run(request: ProcessRequest): Promise<ProcessResult> {
    this.requests.push(request);
    if (this.outcome instanceof Error) throw this.outcome;
    return this.outcome;
  }
}

describe("getCodexCliStatus", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("reports authenticated for a recognized successful login status", async () => {
    const { getCodexCliStatus } = await import("@/lib/codex/status");
    const runner = new CapturingRunner({
      exitCode: 0,
      stdout: "Logged in using ChatGPT\n",
      stderr: "",
    });

    await expect(getCodexCliStatus("/opt/codex", runner)).resolves.toBe(
      "authenticated",
    );
    expect(runner.requests).toHaveLength(1);
    expect(runner.requests[0]).toMatchObject({
      executable: "/opt/codex",
      args: ["login", "status"],
      stdin: "",
      timeoutMs: 2_000,
      maxOutputBytes: 4_096,
    });
  });

  it.each([
    { exitCode: 1, stdout: "Not logged in\n", stderr: "" },
    { exitCode: 0, stdout: "", stderr: "Not logged in\n" },
  ])("reports a recognized unauthenticated status", async (outcome) => {
    const { getCodexCliStatus } = await import("@/lib/codex/status");
    const runner = new CapturingRunner(outcome);

    await expect(getCodexCliStatus("codex", runner)).resolves.toBe(
      "not_authenticated",
    );
  });

  it.each([
    new Error("spawn failed; account=user@example.com"),
    new Error("timeout with token=secret"),
  ])(
    "maps runner failures to a sanitized unavailable status",
    async (error) => {
      const { getCodexCliStatus } = await import("@/lib/codex/status");

      await expect(
        getCodexCliStatus("codex", new CapturingRunner(error)),
      ).resolves.toBe("unavailable");
    },
  );

  it.each([
    { exitCode: 1, stdout: "Unexpected account state", stderr: "identity" },
    { exitCode: 0, stdout: "{not-valid-json", stderr: "secret" },
    { exitCode: 0, stdout: "", stderr: "" },
    {
      exitCode: 0,
      stdout: "warning: logged in state could not be determined",
      stderr: "",
    },
    {
      exitCode: 0,
      stdout: "warning: not logged in check skipped",
      stderr: "",
    },
    {
      exitCode: 0,
      stdout: "Logged in using ChatGPT as user@example.com",
      stderr: "",
    },
  ])("maps unknown or malformed output to unavailable", async (outcome) => {
    const { getCodexCliStatus } = await import("@/lib/codex/status");

    await expect(
      getCodexCliStatus("codex", new CapturingRunner(outcome)),
    ).resolves.toBe("unavailable");
  });

  it("uses the Codex environment allowlist without application secrets", async () => {
    vi.stubEnv("PATH", "/safe/bin");
    vi.stubEnv("HOME", "/safe/home");
    vi.stubEnv("OPENAI_API_KEY", "must-not-leak");
    vi.stubEnv("DATABASE_URL", "must-not-leak");
    const { getCodexCliStatus } = await import("@/lib/codex/status");
    const runner = new CapturingRunner({
      exitCode: 0,
      stdout: "Logged in using ChatGPT",
      stderr: "",
    });

    await getCodexCliStatus("codex", runner);

    expect(runner.requests[0]?.environment).toMatchObject({
      PATH: "/safe/bin",
      HOME: "/safe/home",
    });
    expect(runner.requests[0]?.environment).not.toHaveProperty(
      "OPENAI_API_KEY",
    );
    expect(runner.requests[0]?.environment).not.toHaveProperty("DATABASE_URL");
    vi.unstubAllEnvs();
  });
});

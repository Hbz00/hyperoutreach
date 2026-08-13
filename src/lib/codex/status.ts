import "server-only";

import {
  codexChildEnvironment,
  NodeProcessRunner,
  type ProcessRunner,
} from "@/lib/codex/process-runner";

export type CodexCliStatus =
  "authenticated" | "not_authenticated" | "unavailable";

const STATUS_TIMEOUT_MS = 2_000;
const STATUS_OUTPUT_LIMIT_BYTES = 4_096;

export async function getCodexCliStatus(
  executable: string,
  runner: ProcessRunner = new NodeProcessRunner(),
): Promise<CodexCliStatus> {
  try {
    const result = await runner.run({
      executable,
      args: ["login", "status"],
      cwd: process.cwd(),
      stdin: "",
      timeoutMs: STATUS_TIMEOUT_MS,
      maxOutputBytes: STATUS_OUTPUT_LIMIT_BYTES,
      environment: codexChildEnvironment(process.env),
    });
    const lines = `${result.stdout}\n${result.stderr}`
      .split(/\r?\n/)
      .map((line) => line.trim());
    const isAuthenticated = lines.includes("Logged in using ChatGPT");
    const isNotAuthenticated = lines.includes("Not logged in");

    if (isNotAuthenticated && !isAuthenticated) return "not_authenticated";
    if (result.exitCode === 0 && isAuthenticated && !isNotAuthenticated) {
      return "authenticated";
    }
    return "unavailable";
  } catch {
    return "unavailable";
  }
}

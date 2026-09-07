import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, it } from "vitest";

import {
  codexChildEnvironment,
  NodeProcessRunner,
} from "@/lib/codex/process-runner";

async function isRunning(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

it.each([false, true])(
  "stops the invocation's descendant on timeout when direct-child ignores SIGTERM=%s",
  async (ignoreTerm) => {
    const directory = await mkdtemp(
      join(tmpdir(), "outreach-process-fixture-"),
    );
    const pidFile = join(directory, "descendant.json");
    let descendantPid: number | undefined;
    const descendant = `
      const fs = require('node:fs');
      process.on('SIGTERM', () => {});
      fs.writeFileSync(process.argv[1], JSON.stringify({ pid: process.pid }));
      setInterval(() => {}, 1000);
    `;
    const parent = `
      const { spawn } = require('node:child_process');
      if (process.argv[2] === 'true') process.on('SIGTERM', () => {});
      spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}, process.argv[1]], { stdio: 'ignore' });
      setInterval(() => {}, 1000);
    `;
    let failure: Promise<unknown> | undefined;
    try {
      const operation = new NodeProcessRunner().run({
        executable: process.execPath,
        args: ["-e", parent, pidFile, String(ignoreTerm)],
        cwd: directory,
        stdin: "",
        timeoutMs: 800,
        maxOutputBytes: 1024,
        environment: codexChildEnvironment(process.env),
      });
      failure = operation.catch((error: unknown) => error);
      // Require actual descendant startup while the invocation is still running.
      const startDeadline = Date.now() + 600;
      while (Date.now() < startDeadline) {
        try {
          descendantPid = JSON.parse(await readFile(pidFile, "utf8")).pid;
          break;
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      }
      expect(descendantPid).toBeGreaterThan(1);
      expect(await isRunning(descendantPid!)).toBe(true);
      expect(await failure).toMatchObject({ code: "timeout" });
      const stopDeadline = Date.now() + 1000;
      while (Date.now() < stopDeadline && (await isRunning(descendantPid!))) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(await isRunning(descendantPid!)).toBe(false);
    } finally {
      // The RED run deliberately leaves a child alive; clean it even on failure.
      await failure;
      if (descendantPid === undefined) {
        try {
          descendantPid = JSON.parse(await readFile(pidFile, "utf8")).pid;
        } catch {
          // Startup failed before creating a descendant.
        }
      }
      if (Number.isInteger(descendantPid) && descendantPid! > 1) {
        try {
          process.kill(descendantPid!, "SIGKILL");
        } catch {
          // Already exited.
        }
      }
      await rm(directory, { recursive: true, force: true });
    }
  },
  5000,
);

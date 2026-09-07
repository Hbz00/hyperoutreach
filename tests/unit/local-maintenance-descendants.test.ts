import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, it } from "vitest";

// The production supervisor is intentionally plain Node ESM.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore -- the supervisor is JavaScript by design
import { createLocalStackSupervisor } from "../../scripts/run-local-stack.mjs";

const pause = (milliseconds: number) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

function running(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

it.each(["graceful", "unexpected"])(
  "reaps a resistant descendant after a %s direct-parent exit",
  async (mode) => {
    const directory = await mkdtemp(join(tmpdir(), "maintenance-descendant-"));
    const pidFile = join(directory, "descendant.json");
    const releaseFile = join(directory, "exit-parent");
    let parent: ReturnType<typeof spawn> | undefined;
    let descendantPid: number | undefined;
    let shutdown: Promise<unknown> | undefined;
    let done: Promise<unknown> | undefined;
    const descendant = `
      const fs = require('node:fs');
      process.on('SIGTERM', () => {});
      fs.writeFileSync(process.argv[1], JSON.stringify({ pid: process.pid }));
      setInterval(() => {}, 1000);
    `;
    const parentScript = `
      const fs = require('node:fs');
      require('node:child_process').spawn(process.execPath,
        ['-e', ${JSON.stringify(descendant)}, process.argv[1]], { stdio: 'ignore' });
      setInterval(() => {
        if (process.argv[2] === 'unexpected' && fs.existsSync(process.argv[3])) process.exit(0);
      }, 10);
    `;
    try {
      const supervisor = createLocalStackSupervisor({
        mode: "dev",
        projectDir: process.cwd(),
        environment: {},
        logger: { info() {}, error() {} },
        loadConfig: () => ({
          mode: "disabled",
          reason: "explicit",
          port: 3000,
          nextShutdownGraceMs: 25,
        }),
        spawnProcess: (
          _executable: string,
          _args: string[],
          options: Parameters<typeof spawn>[2],
        ) => {
          parent = spawn(
            process.execPath,
            ["-e", parentScript, pidFile, mode, releaseFile],
            { ...options, stdio: "ignore" },
          );
          return parent;
        },
      });
      await supervisor.start();
      done = supervisor.done;
      const startDeadline = Date.now() + 1000;
      while (Date.now() < startDeadline) {
        try {
          descendantPid = JSON.parse(await readFile(pidFile, "utf8")).pid;
          break;
        } catch {
          await pause(10);
        }
      }
      expect(descendantPid).toBeGreaterThan(1);
      expect(running(descendantPid!)).toBe(true);
      if (mode === "graceful") {
        // The parent uses the OS default SIGTERM behavior. Its descendant
        // deliberately ignores that signal, so direct-parent exit is not enough.
        shutdown = supervisor.shutdown("SIGTERM");
        await shutdown;
      } else {
        await writeFile(releaseFile, "exit");
      }
      expect(await done).toBe(mode === "graceful" ? 0 : 1);
      expect(parent!.exitCode !== null || parent!.signalCode !== null).toBe(
        true,
      );
      const stopDeadline = Date.now() + 1000;
      while (Date.now() < stopDeadline && running(descendantPid!)) {
        await pause(10);
      }
      expect(running(descendantPid!)).toBe(false);
    } finally {
      // RED intentionally leaves a descendant. Cleanup only this invocation's
      // private group, then observe process death and await its operations.
      if (parent?.pid) {
        try {
          process.kill(-parent.pid, "SIGKILL");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
        }
      }
      if (descendantPid !== undefined) {
        const deadline = Date.now() + 1000;
        while (Date.now() < deadline && running(descendantPid)) await pause(10);
      }
      await shutdown;
      await done;
      await rm(directory, { recursive: true, force: true });
    }
  },
  5000,
);

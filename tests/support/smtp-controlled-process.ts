import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { assertControlledDatabase } from "./smtp-controlled-fixture";

type Packet = {
  workflow?: unknown;
  boundary?: string;
  messageId?: string;
  messageKey?: string;
  result?: {
    ok: boolean;
    code?: string;
    disposition?: string;
    message?: { status: string };
  };
};

export async function controlledWorker(
  mode: string,
  messageId: string,
  inspect: (packet: Packet) => Promise<void> = async () => {},
  testUrl = process.env.TEST_DATABASE_URL!,
) {
  assertControlledDatabase(testUrl);
  const crash = mode === "after-acceptance" || mode === "before-acceptance";
  const child = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      fileURLToPath(
        new URL("../fixtures/smtp-recovery-worker.ts", import.meta.url),
      ),
      mode,
      messageId,
    ],
    {
      env: {
        ...process.env,
        TEST_DATABASE_URL: testUrl,
        NODE_TLS_REJECT_UNAUTHORIZED: "0",
      },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    },
  );
  assert.ok(child.stdout && child.stderr);
  let output = "";
  child.stdout.on("data", (b) => {
    output += b;
  });
  child.stderr.on("data", (b) => {
    output += b;
  });
  const exited = new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve) =>
    child.once("exit", (code, signal) => resolve({ code, signal })),
  );
  let timer: NodeJS.Timeout | undefined;
  try {
    const packet = await new Promise<Packet>((resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error(`Worker deadline: ${output}`)),
        15000,
      );
      child.once("message", (value) => resolve(value as Packet));
      child.once("error", reject);
      child.once("exit", () =>
        reject(new Error(`Worker exited before boundary: ${output}`)),
      );
    });
    clearTimeout(timer);
    await Promise.race([
      inspect(packet),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Worker inspection deadline: ${output}`)),
          10000,
        );
      }),
    ]);
    clearTimeout(timer);
    if (crash) child.kill("SIGKILL");
    const exit = await Promise.race([
      exited,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Worker did not exit: ${output}`)),
          5000,
        );
      }),
    ]);
    assert.deepEqual(
      exit,
      crash ? { code: null, signal: "SIGKILL" } : { code: 0, signal: null },
    );
    console.log(
      JSON.stringify({
        mode,
        pid: child.pid,
        exit,
        boundary: packet.boundary,
        result: packet.result?.code ?? packet.result?.disposition,
        workflow: packet.workflow,
      }),
    );
    return packet;
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await exited;
    }
  }
}

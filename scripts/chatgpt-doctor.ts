#!/usr/bin/env tsx
/**
 * Checks every hook the ChatGPT desktop client depends on, in order, and stops
 * at the first one that does not hold. Run it after a ChatGPT desktop update:
 * if a selector moved, this says which one.
 */
import { isCdpPortOpen, listCdpTargets } from "@/lib/chatgpt-desktop/cdp";
import {
  askChatGptDesktop,
  listChatGptDesktopEfforts,
  listChatGptDesktopModels,
  readChatGptDesktopSurface,
} from "@/lib/chatgpt-desktop/client";
import { defaultCdpPort } from "@/lib/chatgpt-desktop/desktop-app";

const port = defaultCdpPort();
const model = process.argv[2] ?? null;

function section(title: string): void {
  process.stdout.write(`\n=== ${title} ===\n`);
}

section(`devtools port ${port}`);
if (!(await isCdpPortOpen(port))) {
  process.stdout.write(
    "closed. Quit ChatGPT, then relaunch it with:\n" +
      `  open -g -j -a /Applications/ChatGPT.app --args --remote-debugging-port=${port}\n`,
  );
  process.exit(1);
}
process.stdout.write("open\n");

section("targets");
for (const target of await listCdpTargets(port)) {
  process.stdout.write(`${target.type} | ${target.title} | ${target.url}\n`);
}

section("chat surface");
const surface = await readChatGptDesktopSurface({ port });
process.stdout.write(`${JSON.stringify(surface, null, 1)}\n`);
if (!surface.hasComposer) {
  process.stdout.write(
    "Composer missing. Open the Chat tab once, then retry.\n",
  );
  process.exit(1);
}

section("models offered");
for (const entry of await listChatGptDesktopModels({ port })) {
  process.stdout.write(`${entry}\n`);
}

section("efforts offered");
for (const entry of await listChatGptDesktopEfforts({ port })) {
  process.stdout.write(`${entry}\n`);
}

section(`one-shot turn (${model ?? "current model"})`);
try {
  const result = await askChatGptDesktop(
    {
      prompt: "Reply with exactly: OK",
      ...(model === null ? {} : { model }),
      temporary: true,
      timeoutMs: 120_000,
    },
    { port },
  );
  process.stdout.write(`${JSON.stringify(result, null, 1)}\n`);
} catch (error) {
  process.stdout.write(`FAILED: ${(error as Error).message}\n`);
  const detail = (error as { detail?: string }).detail;
  if (detail) process.stdout.write(`${detail}\n`);
  process.exit(1);
}

#!/usr/bin/env tsx
import {
  askChatGptDesktop,
  ChatGptDesktopError,
  listChatGptDesktopEfforts,
  listChatGptDesktopModels,
} from "@/lib/chatgpt-desktop";

const USAGE = `Usage:
  npm run chatgpt -- [options] "your prompt"
  echo "your prompt" | npm run chatgpt -- [options]

Options:
  --model <name>     Model as named in the picker, e.g. "GPT-5.6 Sol"
  --effort <level>   Reasoning effort as named in the picker, e.g. High
  --timeout <ms>     Turn timeout in milliseconds (default: 300000)
  --port <number>    Devtools port of the ChatGPT desktop app (default: 9333)
  --keep-history     Save the turn to ChatGPT history (default: temporary chat)
  --models           List the models the app offers, then exit
  --efforts          List the effort levels the app offers, then exit
  --json             Print the full result as JSON
  --no-launch        Fail instead of launching the app when it is not running
`;

type Options = {
  model: string | null;
  effort: string | null;
  timeoutMs: number;
  port: number | undefined;
  temporary: boolean;
  listModels: boolean;
  listEfforts: boolean;
  json: boolean;
  autoLaunch: boolean;
  prompt: string;
};

function parseArguments(argv: string[]): Options | null {
  const options: Options = {
    model: null,
    effort: null,
    timeoutMs: 300_000,
    port: undefined,
    temporary: true,
    listModels: false,
    listEfforts: false,
    json: false,
    autoLaunch: true,
    prompt: "",
  };
  const positional: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === undefined) continue;
    const next = (): string => {
      const value = argv[index + 1];
      if (value === undefined) throw new Error(`Missing value for ${argument}`);
      index += 1;
      return value;
    };
    const nextInteger = (): number => {
      const raw = next();
      const value = Number.parseInt(raw, 10);
      // Without this, a typo becomes NaN and surfaces later as a bewildering
      // immediate timeout or an unreachable port.
      if (!Number.isInteger(value) || value <= 0) {
        throw new Error(`${argument} expects a positive integer, got "${raw}"`);
      }
      return value;
    };
    switch (argument) {
      case "--help":
      case "-h":
        return null;
      case "--model":
        options.model = next();
        break;
      case "--effort":
        options.effort = next();
        break;
      case "--timeout":
        options.timeoutMs = nextInteger();
        break;
      case "--port":
        options.port = nextInteger();
        break;
      case "--keep-history":
        options.temporary = false;
        break;
      case "--models":
        options.listModels = true;
        break;
      case "--efforts":
        options.listEfforts = true;
        break;
      case "--json":
        options.json = true;
        break;
      case "--no-launch":
        options.autoLaunch = false;
        break;
      default:
        positional.push(argument);
    }
  }
  options.prompt = positional.join(" ");
  return options;
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

async function main(): Promise<number> {
  let options: Options | null;
  try {
    options = parseArguments(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n\n${USAGE}`);
    return 2;
  }
  if (options === null) {
    process.stdout.write(USAGE);
    return 0;
  }

  const appOptions = {
    ...(options.port === undefined ? {} : { port: options.port }),
    autoLaunch: options.autoLaunch,
  };

  try {
    if (options.listModels || options.listEfforts) {
      const entries = options.listModels
        ? await listChatGptDesktopModels(appOptions)
        : await listChatGptDesktopEfforts(appOptions);
      for (const entry of entries) process.stdout.write(`${entry}\n`);
      return 0;
    }

    const prompt = options.prompt.trim() || (await readStdin()).trim();
    if (prompt === "") {
      process.stderr.write(USAGE);
      return 2;
    }

    const result = await askChatGptDesktop(
      {
        prompt,
        ...(options.model === null ? {} : { model: options.model }),
        ...(options.effort === null ? {} : { effort: options.effort }),
        temporary: options.temporary,
        timeoutMs: options.timeoutMs,
      },
      appOptions,
    );
    process.stdout.write(
      options.json
        ? `${JSON.stringify(result, null, 2)}\n`
        : `${result.text}\n`,
    );
    return 0;
  } catch (error) {
    if (error instanceof ChatGptDesktopError) {
      process.stderr.write(
        `${error.message} [${error.code}]${error.detail ? `\n${error.detail}` : ""}\n`,
      );
      return 1;
    }
    process.stderr.write(`${(error as Error).message}\n`);
    return 1;
  }
}

process.exitCode = await main();

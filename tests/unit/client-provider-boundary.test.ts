import { readFile, readdir } from "node:fs/promises";
import { dirname, extname, join, relative, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { AI_WORKFLOW_TASKS as aiWorkflowTasks } from "@/modules/workflows/operator-command-policy";

const sourceRoot = resolve(process.cwd(), "src");
const forbiddenServerModules = [
  "lib/codex/",
  // The live AI surface: it shells out, reads the filesystem and opens a
  // devtools socket. Everything a client bundle must never reach.
  "lib/chatgpt-desktop/",
  "lib/ai/production-provider-bundle",
  "modules/agents/factory",
  "modules/replies/classifier-factory",
  "modules/workflows/service-factory",
];

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = join(directory, entry.name);
      return entry.isDirectory()
        ? sourceFiles(path)
        : [".ts", ".tsx"].includes(extname(path))
          ? [path]
          : [];
    }),
  );
  return nested.flat();
}

function importedSpecifiers(source: string): string[] {
  return [
    ...source.matchAll(
      /(?:import|export)\s+(?:[^"']+?\s+from\s+)?["']([^"']+)["']/g,
    ),
  ]
    .map((match) => match[1])
    .filter((value): value is string => Boolean(value));
}

function resolveLocalImport(from: string, specifier: string): string | null {
  const base = specifier.startsWith("@/")
    ? join(sourceRoot, specifier.slice(2))
    : specifier.startsWith(".")
      ? resolve(dirname(from), specifier)
      : null;
  if (!base) return null;
  return (
    [
      base,
      `${base}.ts`,
      `${base}.tsx`,
      join(base, "index.ts"),
      join(base, "index.tsx"),
    ].find((candidate) => allSourceFiles.has(candidate)) ?? null
  );
}

const allFiles = await sourceFiles(sourceRoot);
const allSourceFiles = new Set(allFiles);
const sources = new Map(
  await Promise.all(
    allFiles.map(async (file) => [file, await readFile(file, "utf8")] as const),
  ),
);

/**
 * Everything that takes a turn on the operator's single ChatGPT window, which
 * is serialized process-wide. A page render that reaches any of these can be
 * parked behind a ten-minute research turn before it paints. The devtools port
 * probe (`lib/chatgpt-desktop/cdp`) is deliberately absent: it is a plain HTTP
 * request with its own timeout and never queues, which is why the settings
 * health line is allowed to use it.
 */
const aiSerializationQueueModules = [
  "lib/chatgpt-desktop/client",
  "lib/chatgpt-desktop/index",
  "lib/chatgpt-desktop/structured-provider",
  "lib/ai/production-provider-bundle",
  "modules/agents/factory",
  "modules/replies/classifier-factory",
  "modules/workflows/service-factory",
];

function reachesAny(entry: string, forbidden: string[]): string[] {
  const violations: string[] = [];
  const pending = [entry];
  const visited = new Set<string>();
  while (pending.length > 0) {
    const file = pending.pop()!;
    if (visited.has(file)) continue;
    visited.add(file);
    for (const specifier of importedSpecifiers(sources.get(file) ?? "")) {
      const resolved = resolveLocalImport(file, specifier);
      const normalized = specifier.startsWith("@/")
        ? specifier.slice(2)
        : resolved
          ? relative(sourceRoot, resolved)
          : specifier;
      if (
        forbidden.some(
          (name) => normalized === name || normalized.startsWith(`${name}/`),
        )
      ) {
        violations.push(`${relative(sourceRoot, entry)} reaches ${normalized}`);
      }
      if (resolved) pending.push(resolved);
    }
  }
  return violations;
}

describe("client/provider module boundary", () => {
  // A page must paint from the database alone. Route handlers are covered by
  // the next test, which asks a different question about them.
  it("keeps page renders out of the AI serialization queue", () => {
    const pages = allFiles.filter((file) => file.endsWith("/page.tsx"));
    expect(pages.length).toBeGreaterThan(0);
    const violations = pages.flatMap((page) =>
      reachesAny(page, aiSerializationQueueModules),
    );
    expect(violations).toEqual([]);
  });

  /**
   * The import graph is the wrong instrument for route handlers and the right
   * one for pages. A route legitimately imports the workflow dispatcher — that
   * is how it sends mail and reconciles follow-ups — and the dispatcher can
   * build every service including the AI ones. What matters is not what a
   * route can reach but what it actually asks for, so this reads the dispatch
   * itself.
   */
  it("dispatches no AI task from an operator command handler", () => {
    const handlers = allFiles.filter((file) =>
      file.includes("/app/api/operator/"),
    );
    expect(handlers.length).toBeGreaterThan(0);
    const dispatched = handlers.flatMap((file) =>
      [...(sources.get(file) ?? "").matchAll(/task:\s*"([a-z-]+)"/g)].map(
        (match) => ({ file: relative(sourceRoot, file), task: match[1]! }),
      ),
    );
    expect(dispatched.length).toBeGreaterThan(0);
    expect(
      dispatched.filter((entry) =>
        (aiWorkflowTasks as readonly string[]).includes(entry.task),
      ),
    ).toEqual([]);
  });

  // Stated rather than fixed, and there are two of them, not one. Both drain
  // Microsoft Graph work inside the request, and draining classifies replies —
  // an AI turn from a request handler. Both are reachable only with
  // `MAIL_PROVIDER=microsoft_graph`, which this checkout has never verified
  // live, and moving them into the queue changes a provider path nobody here
  // can exercise. Enumerated exhaustively so that a third one cannot appear
  // unnoticed: the assertion is the whole list, not an example from it.
  it("records every request handler still able to issue an AI turn", () => {
    const classifierEntryPoints = allFiles
      .filter((file) => /app\/api\/.*route\.ts$/.test(file))
      .filter((file) => {
        const source = sources.get(file) ?? "";
        return (
          source.includes("createReplyClassifier") ||
          source.includes('task: "drain-graph-webhooks"')
        );
      })
      .map((file) => relative(sourceRoot, file))
      .sort();

    expect(classifierEntryPoints).toEqual([
      "app/api/internal/microsoft/reconcile/route.ts",
      "app/api/webhooks/microsoft/route.ts",
    ]);
  });

  it("keeps client component import graphs away from Node-only AI factories", () => {
    const clientEntries = allFiles.filter((file) =>
      /^\s*["']use client["'];/m.test(sources.get(file) ?? ""),
    );
    const violations: string[] = [];

    for (const entry of clientEntries) {
      const pending = [entry];
      const visited = new Set<string>();
      while (pending.length > 0) {
        const file = pending.pop()!;
        if (visited.has(file)) continue;
        visited.add(file);
        for (const specifier of importedSpecifiers(sources.get(file) ?? "")) {
          const normalized = specifier.startsWith("@/")
            ? specifier.slice(2)
            : resolveLocalImport(file, specifier)
              ? relative(sourceRoot, resolveLocalImport(file, specifier)!)
              : specifier;
          if (
            forbiddenServerModules.some(
              (forbidden) =>
                normalized === forbidden || normalized.startsWith(forbidden),
            )
          ) {
            violations.push(
              `${relative(sourceRoot, entry)} reaches ${normalized}`,
            );
          }
          const resolved = resolveLocalImport(file, specifier);
          if (resolved) pending.push(resolved);
        }
      }
    }

    expect(violations).toEqual([]);
  });
});

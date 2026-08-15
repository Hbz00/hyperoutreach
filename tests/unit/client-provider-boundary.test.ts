import { readFile, readdir } from "node:fs/promises";
import { dirname, extname, join, relative, resolve } from "node:path";

import { describe, expect, it } from "vitest";

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

describe("client/provider module boundary", () => {
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

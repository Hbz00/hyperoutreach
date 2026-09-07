import { spawnSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import { build } from "esbuild";
import { expect, it } from "vitest";

const variants = ["src", "cjs/src", "cf/src"];

function driverSources(directory: string) {
  return variants.flatMap((variant) =>
    ["index.js", "connection.js"].map((name) =>
      path.join(directory, "node_modules/postgres", variant, name),
    ),
  );
}

function withoutRevision(source: string) {
  return source
    .replace(/^  hyperoutreachReservationPatch:.*\n/gm, "")
    .replace(/^Connection\.hyperoutreachReservationPatch =.*\n\n/gm, "");
}

function installation() {
  mkdirSync(".superpowers", { recursive: true });
  const directory = mkdtempSync(
    path.resolve(".superpowers/postgres-installation-"),
  );
  cpSync(
    "node_modules/postgres",
    path.join(directory, "node_modules/postgres"),
    {
      recursive: true,
    },
  );
  mkdirSync(path.join(directory, "scripts"));
  cpSync(
    "scripts/patch-postgres.mjs",
    path.join(directory, "scripts/patch-postgres.mjs"),
  );
  // An already repaired installation from before the runtime revision was
  // introduced must remain valid input to the same source-pinned installer.
  for (const file of driverSources(directory))
    writeFileSync(file, withoutRevision(readFileSync(file, "utf8")));
  return directory;
}

function patchInstallation(directory: string) {
  return spawnSync(process.execPath, ["scripts/patch-postgres.mjs"], {
    cwd: directory,
    encoding: "utf8",
    timeout: 10_000,
  });
}

async function clientProbe(directory: string, mode: "esm" | "cjs" | "bundle") {
  // First externalize dependencies so the second build resolves postgres
  // against the owned installation, not the repository's real node_modules.
  const clientPath = path.join(directory, "client.mjs");
  await build({
    entryPoints: [path.resolve("src/lib/db/client-core.ts")],
    bundle: true,
    packages: "external",
    platform: "node",
    format: "esm",
    outfile: clientPath,
    logLevel: "silent",
  });
  const probePath = path.join(directory, "probe.mjs");
  writeFileSync(
    probePath,
    `import { getSqlClient } from './client.mjs';
try {
  const client = getSqlClient();
  if (getSqlClient() !== client) throw new Error('Client was not reused');
  await client.end({timeout: 1});
  console.log(JSON.stringify({accepted: true}));
} catch (error) {
  console.log(JSON.stringify({accepted: false, message: error.message}));
}
`,
  );
  let executedPath = probePath;
  if (mode !== "esm") {
    executedPath = path.join(directory, `probe-${mode}.mjs`);
    // A CJS client is imported by an ESM wrapper to retain top-level await.
    const output = path.join(directory, `client-${mode}.cjs`);
    await build({
      entryPoints: [clientPath],
      bundle: true,
      ...(mode === "cjs"
        ? { packages: "external" as const }
        : { external: ["drizzle-orm", "drizzle-orm/*"] }),
      platform: "node",
      format: "cjs",
      minify: mode === "bundle",
      outfile: output,
      logLevel: "silent",
    });
    writeFileSync(
      executedPath,
      readFileSync(probePath, "utf8").replace(
        "./client.mjs",
        `./client-${mode}.cjs`,
      ),
    );
  }
  const result = spawnSync(process.execPath, [executedPath], {
    encoding: "utf8",
    timeout: 10_000,
    env: {
      PATH: process.env.PATH,
      NODE_ENV: "test",
      DATABASE_URL: "postgresql://synthetic:synthetic@127.0.0.1:1/driver_test",
    },
  });
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as { accepted: boolean; message?: string };
}

it.each(["none", "index-only", "connection-only", "both"] as const)(
  "requires the complete imported driver repair across ESM, CJS and bundling (%s)",
  async (markers) => {
    const directory = installation();
    try {
      const patched = patchInstallation(directory);
      expect(patched.status, patched.stderr).toBe(0);
      for (const file of driverSources(directory)) {
        const keep = file.endsWith("/index.js")
          ? markers === "index-only" || markers === "both"
          : markers === "connection-only" || markers === "both";
        if (!keep)
          writeFileSync(file, withoutRevision(readFileSync(file, "utf8")));
      }
      for (const mode of ["esm", "cjs", "bundle"] as const) {
        const result = await clientProbe(directory, mode);
        expect(result.accepted, mode).toBe(markers === "both");
        if (markers !== "both")
          expect(result.message).toContain("npm run postinstall");
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

it("upgrades the previous repair idempotently and rejects unexpected sources before writing", () => {
  const directory = installation();
  try {
    const first = patchInstallation(directory);
    expect(first.status, first.stderr).toBe(0);
    const snapshot = () =>
      driverSources(directory).map((file) => readFileSync(file, "utf8"));
    const repaired = snapshot();
    const second = patchInstallation(directory);
    expect(second.status, second.stderr).toBe(0);
    expect(snapshot()).toEqual(repaired);
    const changed = path.join(
      directory,
      "node_modules/postgres/cf/src/connection.js",
    );
    writeFileSync(
      changed,
      `${readFileSync(changed, "utf8")}\n// unexpected source\n`,
    );
    const beforeRefusal = snapshot();
    const refused = patchInstallation(directory);
    expect(refused.status).not.toBe(0);
    expect(refused.stderr).toContain("Unexpected PostgreSQL source");
    expect(snapshot()).toEqual(beforeRefusal);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

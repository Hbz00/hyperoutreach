import { config } from "dotenv";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

import { sanitizeDatabaseError } from "../src/lib/db/sanitize-error";

config({ path: ".env.local" });
config({ path: ".env" });

const databaseUrl =
  process.env.DATABASE_URL ??
  "postgresql://hyperoutreach:hyperoutreach@localhost:55432/hyperoutreach";

/**
 * The database this run would change, by name.
 *
 * `DATABASE_URL` in `.env.local` points at the operator's real database,
 * because the development server is what runs their real outreach. That makes
 * `npm run db:migrate` with no override a schema change to live data, which has
 * happened by accident and is not something a command with no arguments should
 * be able to do.
 */
const databaseName = (() => {
  try {
    return decodeURIComponent(new URL(databaseUrl).pathname.slice(1));
  } catch {
    return "";
  }
})();
const looksLive = /(^|[_-])(live|prod|production)([_-]|$)/i.test(databaseName);
const confirmed =
  process.argv.includes("--live") || process.env.MIGRATE_LIVE === "1";

if (looksLive && !confirmed) {
  console.error(
    [
      `Refusing to migrate "${databaseName}": the name says it holds real data.`,
      "",
      "Re-run it deliberately, having stopped anything writing to it:",
      "  npm run db:migrate -- --live",
      "",
      "Or point the run somewhere else:",
      "  DATABASE_URL=$TEST_DATABASE_URL npm run db:migrate",
    ].join("\n"),
  );
  process.exit(1);
}

const client = postgres(databaseUrl, { max: 1 });

try {
  if (looksLive) console.log(`Migrating "${databaseName}" — confirmed.`);
  await migrate(drizzle(client), { migrationsFolder: "drizzle" });
  console.log("Database migrations applied.");
} catch (error) {
  console.error(
    `Database migration failed: ${sanitizeDatabaseError(error, [databaseUrl])}`,
  );
  process.exitCode = 1;
} finally {
  await client.end();
}

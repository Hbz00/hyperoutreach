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
const client = postgres(databaseUrl, { max: 1 });

try {
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

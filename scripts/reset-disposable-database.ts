import { config } from "dotenv";
import postgres from "postgres";

import { assertDisposableDatabaseName } from "../src/lib/db/test-database";

config({ path: ".env.local" });
config({ path: ".env" });

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");
assertDisposableDatabaseName(databaseUrl);
const client = postgres(databaseUrl, { max: 1 });

try {
  await client.unsafe("drop schema if exists public cascade");
  await client.unsafe("drop schema if exists drizzle cascade");
  await client.unsafe("create schema public");
  console.log("Disposable database schema reset.");
} finally {
  await client.end();
}

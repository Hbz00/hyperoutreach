import { config } from "dotenv";
import postgres from "postgres";

import {
  assertDisposableDatabaseName,
  databaseNameFromUrl,
} from "../src/lib/db/test-database";

config({ path: ".env.local" });
config({ path: ".env" });

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");
assertDisposableDatabaseName(databaseUrl);
const databaseName = databaseNameFromUrl(databaseUrl);
const maintenanceUrl = new URL(databaseUrl);
maintenanceUrl.pathname = "/postgres";
maintenanceUrl.search = "";
maintenanceUrl.hash = "";
const client = postgres(maintenanceUrl.href, { max: 1 });

try {
  const [existing] = await client<{ exists: boolean }[]>`
    select exists(select 1 from pg_database where datname = ${databaseName}) as exists
  `;
  if (!existing?.exists) {
    try {
      await client.unsafe(`create database "${databaseName}"`);
    } catch (error) {
      if (
        !(error instanceof postgres.PostgresError) ||
        error.code !== "42P04"
      ) {
        throw error;
      }
    }
  }
  console.log(`Disposable database ${databaseName} is available.`);
} finally {
  await client.end();
}

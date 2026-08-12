import { config } from "dotenv";
import postgres from "postgres";

import {
  databaseNameFromUrl,
  resolveDatabaseUrls,
} from "../src/lib/db/test-database";

config({ path: ".env.local" });
config({ path: ".env" });

const { testUrl } = resolveDatabaseUrls(process.env);
const testDatabaseName = databaseNameFromUrl(testUrl);
const maintenanceUrl = new URL(testUrl);
maintenanceUrl.pathname = "/postgres";
maintenanceUrl.search = "";
maintenanceUrl.hash = "";

const client = postgres(maintenanceUrl.href, { max: 1 });

try {
  const [existing] = await client<{ exists: boolean }[]>`
    select exists(
      select 1 from pg_database where datname = ${testDatabaseName}
    ) as exists
  `;
  if (!existing?.exists) {
    try {
      await client.unsafe(`create database "${testDatabaseName}"`);
      console.log(
        `Created disposable PostgreSQL database ${testDatabaseName}.`,
      );
    } catch (error) {
      if (
        !(error instanceof postgres.PostgresError) ||
        error.code !== "42P04"
      ) {
        throw error;
      }
    }
  }
  console.log(
    `Disposable PostgreSQL database ${testDatabaseName} is available.`,
  );
} catch {
  console.error(
    "Could not provision TEST_DATABASE_URL. Check local PostgreSQL credentials.",
  );
  process.exitCode = 1;
} finally {
  await client.end();
}

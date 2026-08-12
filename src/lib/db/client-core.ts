import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import * as schema from "@/lib/db/schema";

const localDatabaseUrl =
  "postgresql://hyperoutreach:hyperoutreach@localhost:55432/hyperoutreach";

function databaseUrl(): string {
  const configured = process.env.DATABASE_URL;
  if (configured) return configured;
  if (process.env.NODE_ENV === "production") {
    throw new Error("DATABASE_URL is required in production");
  }
  return localDatabaseUrl;
}

const globalForDatabase = globalThis as unknown as {
  hyperoutreachPostgres?: ReturnType<typeof postgres>;
};

export function getSqlClient(): ReturnType<typeof postgres> {
  const existing = globalForDatabase.hyperoutreachPostgres;
  if (existing) return existing;
  const client = postgres(databaseUrl(), {
    max: 5,
    idle_timeout: 20,
    connect_timeout: 10,
  });
  globalForDatabase.hyperoutreachPostgres = client;
  return client;
}

export function getDatabase() {
  return drizzle(getSqlClient(), { schema });
}

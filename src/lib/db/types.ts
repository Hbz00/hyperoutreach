import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { Sql } from "postgres";

import type * as schema from "@/lib/db/schema";

export type AppDatabase = PostgresJsDatabase<typeof schema> & { $client: Sql };

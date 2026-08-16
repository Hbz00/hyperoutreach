export type DatabaseHealth =
  | { status: "ok"; database: "reachable" }
  | { status: "error"; database: "unreachable" }
  | {
      status: "error";
      database: "reachable";
      schema: "outdated";
      appliedMigrations: number;
      expectedMigrations: number;
    };

export type SchemaHealthProbe = {
  /** Number of migrations this build expects, taken from the drizzle journal. */
  expectedMigrations: number;
  countAppliedMigrations: () => Promise<number>;
};

export async function checkDatabaseHealth(
  query: () => Promise<unknown>,
  schema?: SchemaHealthProbe,
): Promise<DatabaseHealth> {
  try {
    await query();
  } catch {
    return { status: "error", database: "unreachable" };
  }
  if (!schema) return { status: "ok", database: "reachable" };

  let appliedMigrations: number;
  try {
    appliedMigrations = await schema.countAppliedMigrations();
  } catch {
    // A database that has never been migrated has no drizzle bookkeeping table
    // at all. That is the most outdated schema there is, not an outage.
    appliedMigrations = 0;
  }
  // Migrations are applied before the build that needs them ships, so a
  // database ahead of this build is expected and healthy. Only a database
  // behind it can serve queries against columns that do not exist yet.
  if (appliedMigrations < schema.expectedMigrations) {
    return {
      status: "error",
      database: "reachable",
      schema: "outdated",
      appliedMigrations,
      expectedMigrations: schema.expectedMigrations,
    };
  }
  return { status: "ok", database: "reachable" };
}

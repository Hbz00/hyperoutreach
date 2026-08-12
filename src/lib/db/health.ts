export type DatabaseHealth =
  | { status: "ok"; database: "reachable" }
  | { status: "error"; database: "unreachable" };

export async function checkDatabaseHealth(
  query: () => Promise<unknown>,
): Promise<DatabaseHealth> {
  try {
    await query();
    return { status: "ok", database: "reachable" };
  } catch {
    return { status: "error", database: "unreachable" };
  }
}

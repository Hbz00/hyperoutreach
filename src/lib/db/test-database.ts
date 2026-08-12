const defaultApplicationUrl =
  "postgresql://hyperoutreach:hyperoutreach@localhost:55432/hyperoutreach";
const defaultTestUrl =
  "postgresql://hyperoutreach:hyperoutreach@localhost:55432/hyperoutreach_test";

type DatabaseEnvironment = Record<string, string | undefined>;

function parseDatabaseUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Database URL must be a valid PostgreSQL URL");
  }
  if (url.protocol !== "postgresql:" && url.protocol !== "postgres:") {
    throw new Error("Database URL must use the PostgreSQL protocol");
  }
  return url;
}

export function databaseNameFromUrl(value: string): string {
  const databaseName = decodeURIComponent(
    parseDatabaseUrl(value).pathname.slice(1),
  );
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(databaseName)) {
    throw new Error("Database name must be a simple PostgreSQL identifier");
  }
  return databaseName;
}

export function assertDisposableDatabaseName(databaseUrl: string): void {
  if (!databaseNameFromUrl(databaseUrl).endsWith("_test")) {
    throw new Error("Disposable database name must end with _test");
  }
}

export function assertDisposableTestDatabase(
  applicationUrl: string,
  testUrl: string,
): void {
  const parsedApplicationUrl = parseDatabaseUrl(applicationUrl);
  const parsedTestUrl = parseDatabaseUrl(testUrl);
  if (parsedApplicationUrl.href === parsedTestUrl.href) {
    throw new Error(
      "TEST_DATABASE_URL must not target the application database",
    );
  }

  const applicationName = databaseNameFromUrl(applicationUrl);
  const testName = databaseNameFromUrl(testUrl);
  if (applicationName === testName) {
    throw new Error("TEST_DATABASE_URL must use a different database name");
  }
  if (!testName.endsWith("_test")) {
    throw new Error("TEST_DATABASE_URL database name must end with _test");
  }
}

export function resolveDatabaseUrls(environment: DatabaseEnvironment): {
  applicationUrl: string;
  testUrl: string;
} {
  const applicationUrl = environment.DATABASE_URL ?? defaultApplicationUrl;
  const testUrl = environment.TEST_DATABASE_URL ?? defaultTestUrl;
  assertDisposableTestDatabase(applicationUrl, testUrl);
  return { applicationUrl, testUrl };
}

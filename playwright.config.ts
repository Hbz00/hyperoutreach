import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  retries: process.env.CI ? 2 : 0,
  reporter: "html",
  use: {
    baseURL: "http://127.0.0.1:3000",
    trace: "on-first-retry",
  },
  webServer: {
    command:
      "tsx scripts/ensure-disposable-database.ts && tsx scripts/reset-disposable-database.ts && npm run db:migrate && npm run db:seed && npm run build && npm start",
    url: "http://127.0.0.1:3000/api/health",
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      DATABASE_URL:
        "postgresql://hyperoutreach:hyperoutreach@localhost:55432/hyperoutreach_e2e_test",
      OPENAI_PROVIDER: "mock",
      MAIL_PROVIDER: "mock",
      WORKFLOW_PROVIDER: "mock",
      OPERATOR_EMAIL: process.env.OPERATOR_EMAIL ?? "operator@example.com",
      OPERATOR_PASSWORD:
        process.env.OPERATOR_PASSWORD ?? "correct horse battery staple",
      SESSION_SECRET:
        process.env.SESSION_SECRET ??
        "playwright-session-secret-with-at-least-32-bytes",
      OPERATOR_API_TOKEN:
        process.env.OPERATOR_API_TOKEN ??
        "playwright-api-token-with-at-least-32-bytes",
      OPERATOR_COOKIE_SECURE: "false",
    },
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});

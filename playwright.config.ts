import { defineConfig, devices } from "@playwright/test";

import {
  E2E_OPERATOR_API_TOKEN,
  E2E_OPERATOR_EMAIL,
  E2E_OPERATOR_PASSWORD,
  E2E_SESSION_SECRET,
} from "./tests/e2e/support/environment";

// `reuseExistingServer: false` means the suite always starts its own build, so
// a developer running `npm run dev` on the default port cannot run E2E at all
// without this override. Port collision is not a reason to leave the suite
// unrun.
const port = Number.parseInt(process.env.E2E_PORT ?? "", 10) || 3000;
const origin = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  retries: process.env.CI ? 2 : 0,
  reporter: "html",
  use: {
    baseURL: origin,
    trace: "on-first-retry",
  },
  webServer: {
    command: `tsx scripts/ensure-disposable-database.ts && tsx scripts/reset-disposable-database.ts && npm run db:migrate && npm run db:seed:mock && npm run build && npm run start:web -- --hostname 127.0.0.1 --port ${port}`,
    url: `${origin}/api/health`,
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      DATABASE_URL:
        "postgresql://hyperoutreach:hyperoutreach@localhost:55432/hyperoutreach_e2e_test",
      AI_PROVIDER: "mock",
      MAIL_PROVIDER: "mock",
      WORKFLOW_PROVIDER: "mock",
      LOCAL_MAINTENANCE_ENABLED: "false",
      // Never inherit an operator's real credentials into the disposable E2E
      // installation. The browser and request tests import these same values.
      OPERATOR_EMAIL: E2E_OPERATOR_EMAIL,
      OPERATOR_PASSWORD: E2E_OPERATOR_PASSWORD,
      SESSION_SECRET: E2E_SESSION_SECRET,
      OPERATOR_API_TOKEN: E2E_OPERATOR_API_TOKEN,
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

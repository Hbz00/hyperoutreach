import { defineConfig } from "@trigger.dev/sdk";
import maintenanceConfig from "./config/maintenance.json";

export default defineConfig({
  project: process.env.TRIGGER_PROJECT_REF ?? "proj_configure_hyperoutreach",
  dirs: ["./trigger"],
  runtime: "node-22",
  maxDuration: maintenanceConfig.aggregateBudgetMs / 1_000,
  retries: {
    enabledInDev: true,
    default: {
      maxAttempts: 3,
      minTimeoutInMs: 1_000,
      maxTimeoutInMs: 30_000,
      factor: 2,
      randomize: true,
    },
  },
});

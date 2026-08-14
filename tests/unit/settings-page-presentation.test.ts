import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

describe("Settings provider presentation", () => {
  it("renders the provider provenance note when one is present", async () => {
    const page = await readFile(
      resolve(process.cwd(), "src/app/(operator)/settings/page.tsx"),
      "utf8",
    );

    expect(page).toMatch(/aiProvider\.sourceProvenanceNote\s*\?/);
    expect(page).toContain("{aiProvider.sourceProvenanceNote}");
  });

  it("renders persisted maintenance status only in Settings without exposing ownership", async () => {
    const settingsPage = await readFile(
      resolve(process.cwd(), "src/app/(operator)/settings/page.tsx"),
      "utf8",
    );
    const dashboardPage = await readFile(
      resolve(process.cwd(), "src/app/(operator)/page.tsx"),
      "utf8",
    );

    expect(settingsPage).toContain("maintenanceState");
    expect(settingsPage).toContain("MaintenanceStatusPanel");
    expect(settingsPage).toContain("maintenanceProjection.lastSucceededAt");
    expect(settingsPage).toContain("maintenanceProjection.cycleStartedAt");
    expect(settingsPage).toContain("maintenanceProjection.heartbeatAt");
    expect(settingsPage).toContain("maintenanceProjection.lastError");
    expect(settingsPage).toContain("Boolean(maintenanceProjection.ownerToken)");
    expect(settingsPage).not.toContain("{maintenanceProjection.ownerToken}");
    expect(dashboardPage).not.toContain("Maintenance automation");
    expect(dashboardPage).not.toContain("maintenanceState");
  });
});

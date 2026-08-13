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
});

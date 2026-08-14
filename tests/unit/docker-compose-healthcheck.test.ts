import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("GreenMail Docker healthcheck", () => {
  it("uses a bounded SMTP probe without reading from the implicit-TLS socket", async () => {
    const compose = await readFile(
      join(process.cwd(), "docker-compose.yml"),
      "utf8",
    );
    const greenmailService = compose.slice(compose.indexOf("  greenmail:"));
    const healthcheck = greenmailService.slice(
      greenmailService.indexOf("    healthcheck:"),
      greenmailService.indexOf("\n\nvolumes:"),
    );

    expect(healthcheck).toMatch(
      /test:\s*\[\s*"CMD",\s*"timeout",\s*"1",\s*"bash",\s*"-c",/s,
    );
    expect(healthcheck).toContain("/dev/tcp/127.0.0.1/3025");
    expect(healthcheck).toContain("QUIT");
    expect(healthcheck).not.toContain("/dev/tcp/127.0.0.1/3993");
    expect(healthcheck).not.toContain("</dev/tcp");
  });
});

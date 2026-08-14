import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const roundTripSource = readFileSync(
  new URL("../integration/smtp-imap-round-trip.test.ts", import.meta.url),
  "utf8",
);
const readinessSource = roundTripSource.slice(
  roundTripSource.indexOf("const GREENMAIL_READINESS_TIMEOUT_MS"),
  roundTripSource.indexOf("const greenmailAvailable"),
);

describe("GreenMail round-trip readiness", () => {
  it("uses protocol-aware TLS probes that close IMAP and SMTP cleanly", () => {
    expect(readinessSource).not.toContain("netConnect");
    expect(readinessSource).not.toContain("socket.destroy()");
    expect(readinessSource).toContain("await imap.connect()");
    expect(readinessSource).toContain("await imap.logout()");
    expect(readinessSource).toContain("await transporter.verify()");
    expect(readinessSource).toContain("transporter.close()");
  });
});

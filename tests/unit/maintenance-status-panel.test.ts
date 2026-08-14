import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { MaintenanceStatusPanel } from "@/modules/settings/maintenance-status-panel";
import {
  getMaintenanceStatusPresentation,
  type MaintenanceAutomationPresentation,
} from "@/modules/workflows/maintenance-status-presentation";
import type { MaintenanceStatus } from "@/modules/workflows/maintenance-status";

const automation: MaintenanceAutomationPresentation = {
  provider: "Local",
  mode: "Automatic worker",
};

function renderStatus(state: MaintenanceStatus): string {
  return renderToStaticMarkup(
    MaintenanceStatusPanel({
      presentation: getMaintenanceStatusPresentation(state),
      automation,
      activeCycle: null,
      lastSucceededAt: null,
      lastFailedAt: null,
      lastError: null,
    }),
  );
}

describe("Settings maintenance status panel", () => {
  it.each([
    "not_started",
    "running",
    "stalled",
    "failed",
    "overdue",
    "healthy",
  ] as const)("renders the %s label and explanation", (state) => {
    const presentation = getMaintenanceStatusPresentation(state);
    const html = renderStatus(state);

    expect(html).toContain(presentation.label);
    expect(html).toContain(presentation.detail);
  });

  it("renders current timestamps only for an active owned cycle", () => {
    const withoutOwner = renderStatus("healthy");
    const withOwner = renderToStaticMarkup(
      MaintenanceStatusPanel({
        presentation: getMaintenanceStatusPresentation("running"),
        automation,
        activeCycle: {
          startedAt: new Date("2026-08-14T09:56:00.000Z"),
          heartbeatAt: new Date("2026-08-14T09:59:30.000Z"),
        },
        lastSucceededAt: null,
        lastFailedAt: null,
        lastError: null,
      }),
    );

    expect(withoutOwner).not.toContain("Current cycle started");
    expect(withoutOwner).not.toContain("Current heartbeat");
    expect(withOwner).toContain("Current cycle started");
    expect(withOwner).toContain("Current heartbeat");
    expect(withOwner).toContain('dateTime="2026-08-14T09:56:00.000Z"');
    expect(withOwner).toContain('dateTime="2026-08-14T09:59:30.000Z"');
  });

  it("renders historical success and sanitized failure without lease or secret values", () => {
    const html = renderToStaticMarkup(
      MaintenanceStatusPanel({
        presentation: getMaintenanceStatusPresentation("healthy"),
        automation,
        activeCycle: null,
        lastSucceededAt: new Date("2026-08-14T10:43:00.000Z"),
        lastFailedAt: new Date("2026-08-14T10:42:00.000Z"),
        lastError: [
          "password: hunter2",
          '{"api_key":"json-api-secret"}',
          "Authorization: Bearer bearer-secret",
          "token=equals-secret",
          "postgresql://user:dsn-secret@database.example/app",
          "IMAP failed",
        ].join(" "),
      }),
    );

    expect(html).toContain('dateTime="2026-08-14T10:43:00.000Z"');
    expect(html).toContain("Latest historical failure");
    expect(html).toContain('dateTime="2026-08-14T10:42:00.000Z"');
    expect(html).toContain("IMAP failed");
    expect(html).toContain("[REDACTED]");
    for (const secret of [
      "hunter2",
      "json-api-secret",
      "bearer-secret",
      "equals-secret",
      "dsn-secret",
    ]) {
      expect(html).not.toContain(secret);
    }
    expect(html).not.toContain("ownerToken");
  });
});

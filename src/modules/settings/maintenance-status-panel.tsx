import { sanitizeMaintenanceError } from "@/modules/workflows/maintenance-error";
import type {
  MaintenanceAutomationPresentation,
  getMaintenanceStatusPresentation,
} from "@/modules/workflows/maintenance-status-presentation";

type MaintenanceStatusPresentation = ReturnType<
  typeof getMaintenanceStatusPresentation
>;

type ActiveCycle = {
  startedAt: Date | null;
  heartbeatAt: Date | null;
};

export function MaintenanceStatusPanel({
  presentation,
  automation,
  activeCycle,
  lastSucceededAt,
  lastFailedAt,
  lastError,
}: {
  presentation: MaintenanceStatusPresentation;
  automation: MaintenanceAutomationPresentation;
  activeCycle: ActiveCycle | null;
  lastSucceededAt: Date | null;
  lastFailedAt: Date | null;
  lastError: string | null;
}) {
  const safeHistoricalError = lastError
    ? sanitizeMaintenanceError(lastError)
    : null;

  return (
    <section className="panel" aria-labelledby="maintenance-heading">
      <div className="panel-heading">
        <h2 id="maintenance-heading">Maintenance automation</h2>
        <span className="badge">{presentation.label}</span>
      </div>
      <p className="muted">{presentation.detail}</p>
      <dl className="facts">
        <div>
          <dt>Automation provider</dt>
          <dd>{automation.provider}</dd>
        </div>
        <div>
          <dt>Automation mode</dt>
          <dd>{automation.mode}</dd>
        </div>
        {activeCycle ? (
          <>
            <div>
              <dt>Current cycle started</dt>
              <dd>
                {activeCycle.startedAt ? (
                  <time dateTime={activeCycle.startedAt.toISOString()}>
                    {activeCycle.startedAt.toLocaleString()}
                  </time>
                ) : (
                  "Unknown"
                )}
              </dd>
            </div>
            <div>
              <dt>Current heartbeat</dt>
              <dd>
                {activeCycle.heartbeatAt ? (
                  <time dateTime={activeCycle.heartbeatAt.toISOString()}>
                    {activeCycle.heartbeatAt.toLocaleString()}
                  </time>
                ) : (
                  "Never"
                )}
              </dd>
            </div>
          </>
        ) : null}
        <div>
          <dt>Last successful cycle</dt>
          <dd>
            {lastSucceededAt ? (
              <time dateTime={lastSucceededAt.toISOString()}>
                {lastSucceededAt.toLocaleString()}
              </time>
            ) : (
              "Never"
            )}
          </dd>
        </div>
        <div>
          <dt>Latest historical failure</dt>
          <dd>
            {lastFailedAt || safeHistoricalError ? (
              <>
                {lastFailedAt ? (
                  <time dateTime={lastFailedAt.toISOString()}>
                    {lastFailedAt.toLocaleString()}
                  </time>
                ) : null}
                {lastFailedAt && safeHistoricalError ? " · " : null}
                {safeHistoricalError ?? "No error details recorded"}
              </>
            ) : (
              "None"
            )}
          </dd>
        </div>
      </dl>
    </section>
  );
}

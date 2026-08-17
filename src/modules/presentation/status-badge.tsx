import { describeStatus, type StatusKind } from "@/modules/presentation/status";

/**
 * The one way a lifecycle enum becomes a badge. The raw value rides along as
 * the tooltip so the exact persisted state is always one hover away.
 */
export function StatusBadge({
  kind,
  value,
}: {
  kind: StatusKind;
  value: string;
}) {
  const presentation = describeStatus(kind, value);
  return (
    <span className={`badge badge-${presentation.tone}`} title={value}>
      {presentation.label}
    </span>
  );
}

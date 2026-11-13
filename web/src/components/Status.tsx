import { stateLabel } from "../format";

export function statusTone(state: string): string {
  switch (state) {
    case "running":
      return "ok";
    case "suspended":
      return "warn";
    case "stopped":
      return "idle";
    case "creating":
    case "starting":
    case "stopping":
    case "suspending":
    case "resuming":
    case "deleting":
      return "busy";
    case "error":
      return "bad";
    default:
      return "idle";
  }
}

export function StatusDot({ state }: { state: string }) {
  return <span className={`status-dot tone-${statusTone(state)}`} aria-hidden="true" />;
}

export function StatePill({ state }: { state: string }) {
  return (
    <span className={`state-pill tone-${statusTone(state)}`}>
      <StatusDot state={state} />
      {stateLabel(state)}
    </span>
  );
}

export function TierBadge({ tier }: { tier?: string | null }) {
  if (!tier) return null;
  return <span className={`tier tier-${tier}`}>{tier}</span>;
}

export function MachineDot({ index }: { index: number }) {
  const colors = ["var(--accent)", "var(--cyan)", "var(--amber)", "var(--violet)", "var(--pink)"];
  return (
    <span
      className="machine-dot"
      style={{ background: colors[index % colors.length] }}
      aria-hidden="true"
    />
  );
}

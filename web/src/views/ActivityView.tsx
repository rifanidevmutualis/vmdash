import { useEffect, useState } from "react";
import { errorMessage, getAudit } from "../api";
import { ago, dateTime } from "../format";
import { Icon } from "../icons";
import type { AuditEntry, Fleet } from "../types";

const OPERATION_STATE: Record<string, string> = {
  succeeded: "tone-ok",
  failed: "tone-bad",
  running: "tone-busy",
  queued: "tone-warn",
};

export function ActivityView({ fleet }: { fleet: Fleet | null }) {
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<"all" | "ok" | "failed">("all");

  useEffect(() => {
    let alive = true;
    getAudit(150)
      .then((result) => {
        if (alive) {
          setAudit(result.audit);
          setError(null);
        }
      })
      .catch((err) => {
        if (alive) setError(errorMessage(err));
      });
    return () => {
      alive = false;
    };
  }, [fleet?.generatedAt]);

  const workspaces = fleet?.workspaces ?? [];
  const machineNames = new Map(
    (fleet?.machines ?? []).map((machine) => [machine.id, machine.name] as const),
  );
  const workspaceNames = new Map(workspaces.map((workspace) => [workspace.id, workspace.label] as const));

  const operations = fleet?.operations ?? [];
  const rows = audit.filter((entry) => {
    if (filter === "ok") return entry.ok === 1;
    if (filter === "failed") return entry.ok === 0;
    return true;
  });

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <div className="eyebrow">Audit</div>
          <h1>Activity</h1>
          <p>Every lifecycle, exec and credential action, kept locally.</p>
        </div>
      </header>

      <section className="panel">
        <div className="panel-head">
          <h2>Operations</h2>
          <span className="muted small">last {operations.length}</span>
        </div>
        {operations.length === 0 ? (
          <div className="row-empty">No operations yet. Start, pause or create a machine.</div>
        ) : (
          <div className="op-list">
            {operations.map((operation) => (
              <div className="op-row" key={operation.id}>
                <span className={`op-state ${OPERATION_STATE[operation.state] ?? "tone-idle"}`}>
                  {operation.state}
                </span>
                <span className="op-kind">{operation.kind}</span>
                <span className="op-target">
                  {operation.machineId ? machineNames.get(operation.machineId) ?? operation.machineId : "—"}
                </span>
                <span className="muted small op-ws">
                  {workspaceNames.get(operation.workspaceId) ?? operation.workspaceId}
                </span>
                <span className="muted small">{ago(operation.createdAt)}</span>
                {operation.error ? <span className="op-error">{operation.error}</span> : null}
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="panel">
        <div className="panel-head">
          <h2>Audit log</h2>
          <div className="segmented small">
            {(["all", "ok", "failed"] as const).map((item) => (
              <button
                key={item}
                className={filter === item ? "segment active" : "segment"}
                onClick={() => setFilter(item)}
              >
                {item}
              </button>
            ))}
          </div>
        </div>

        {error ? (
          <div className="row-empty">Could not load audit log: {error}</div>
        ) : rows.length === 0 ? (
          <div className="row-empty">Nothing recorded yet.</div>
        ) : (
          <div className="table-scroll">
            <table className="audit-table">
              <thead>
                <tr>
                  <th>When</th>
                  <th>Action</th>
                  <th>Target</th>
                  <th>Workspace</th>
                  <th>Detail</th>
                  <th className="right">Result</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((entry) => (
                  <tr key={entry.id}>
                    <td className="mono muted" title={dateTime(entry.ts)}>{ago(entry.ts)}</td>
                    <td><code>{entry.action}</code></td>
                    <td>{entry.machineId ? machineNames.get(entry.machineId) ?? entry.machineId : "—"}</td>
                    <td className="muted">
                      {entry.workspaceId ? workspaceNames.get(entry.workspaceId) ?? entry.workspaceId : "—"}
                    </td>
                    <td className="audit-detail" title={entry.detail ?? ""}>
                      {entry.detail ?? "—"}
                    </td>
                    <td className="right">
                      {entry.ok ? (
                        <span className="result ok"><Icon name="check" size={12} /> ok</span>
                      ) : (
                        <span className="result bad"><Icon name="x" size={12} /> failed</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

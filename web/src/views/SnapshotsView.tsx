import { useCallback, useEffect, useMemo, useState } from "react";
import {
  deleteSnapshot,
  errorMessage,
  restoreSnapshot,
  workspaceSnapshots,
} from "../api";
import { ago, bytes, dateTime } from "../format";
import { Icon } from "../icons";
import type { Fleet, Snapshot, Workspace } from "../types";
import { Modal } from "../components/Modal";

type Loaded = { workspace: Workspace; snapshots: Snapshot[]; error?: string };

export function SnapshotsView({
  fleet,
  notify,
  onRefresh,
}: {
  fleet: Fleet | null;
  notify: (message: string, tone?: "ok" | "error" | "info") => void;
  onRefresh: () => void;
}) {
  const [loaded, setLoaded] = useState<Loaded[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [restoreTarget, setRestoreTarget] = useState<{ workspace: Workspace; snapshot: Snapshot } | null>(
    null,
  );
  const workspaces = fleet?.workspaces ?? [];

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const results = await Promise.all(
        workspaces.map(async (workspace) => {
          try {
            const result = await workspaceSnapshots(workspace.id);
            return { workspace, snapshots: result.snapshots ?? [] } as Loaded;
          } catch (err) {
            return { workspace, snapshots: [], error: errorMessage(err) } as Loaded;
          }
        }),
      );
      setLoaded(results);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [workspaces.map((workspace) => workspace.id).join(",")]);

  useEffect(() => {
    if (workspaces.length > 0) void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaces.length]);

  const rows = useMemo(
    () =>
      loaded.flatMap((entry) =>
        entry.snapshots.map((snapshot) => ({ workspace: entry.workspace, snapshot })),
      ),
    [loaded],
  );

  const machineName = (workspaceId: string, machineId: string) =>
    fleet?.machines.find(
      (machine) => machine.workspaceId === workspaceId && machine.id === machineId,
    )?.name ?? machineId;

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <div className="eyebrow">State</div>
          <h1>Snapshots</h1>
          <p>Saved disks across every connected workspace. Restore into a machine or delete.</p>
        </div>
        <div className="head-actions">
          <button className="btn ghost" onClick={() => void load()} disabled={loading}>
            <Icon name="refresh" className={loading ? "spin" : undefined} /> Refresh
          </button>
        </div>
      </header>

      <div className="callout info wide">
        <div className="callout-icon"><Icon name="camera" /></div>
        <div>
          <strong>Create snapshots from a machine drawer.</strong>
          <p>
            Open <strong>Fleet → machine → Snapshots</strong>. A running machine freezes briefly for a
            live copy; a stopped one is saved instantly. Snapshots are org-wide and survive machine
            deletion.
          </p>
        </div>
      </div>

      {error ? <div className="term-inline-error">{error}</div> : null}

      {workspaces.length === 0 ? (
        <div className="table-empty card">
          <div className="empty-icon"><Icon name="camera" size={22} /></div>
          <h3>No workspaces connected</h3>
          <p>Connect an InstaBox workspace first.</p>
        </div>
      ) : rows.length === 0 ? (
        <div className="table-empty card">
          <div className="empty-icon"><Icon name="camera" size={22} /></div>
          <h3>{loading ? "Loading snapshots…" : "No snapshots yet"}</h3>
          <p>Save a machine's state from its Snapshots tab.</p>
        </div>
      ) : (
        <section className="panel">
          <div className="table-scroll">
            <table className="snapshot-table">
              <thead>
                <tr>
                  <th>Snapshot</th>
                  <th>Workspace</th>
                  <th>Source</th>
                  <th>Size</th>
                  <th>Status</th>
                  <th>Created</th>
                  <th className="right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(({ workspace, snapshot }) => (
                  <tr key={`${workspace.id}:${snapshot.id}`}>
                    <td>
                      <div className="machine-name">{snapshot.name}</div>
                      <div className="machine-meta">
                        <code>{snapshot.id}</code>
                      </div>
                    </td>
                    <td>{workspace.label}</td>
                    <td>{machineName(workspace.id, snapshot.sourceMachineId)}</td>
                    <td className="mono">{bytes(snapshot.dataSizeBytes ?? snapshot.rootSizeBytes)}</td>
                    <td>
                      <span
                        className={`state-pill tone-${snapshot.status === "ready" ? "ok" : snapshot.status === "failed" ? "bad" : "busy"}`}
                      >
                        {snapshot.status}
                      </span>
                    </td>
                    <td className="mono muted" title={dateTime(snapshot.createdAt)}>
                      {ago(snapshot.createdAt)}
                    </td>
                    <td>
                      <div className="row-actions">
                        <button
                          className="icon-btn"
                          title="Restore into a machine"
                          disabled={snapshot.status !== "ready"}
                          onClick={() => setRestoreTarget({ workspace, snapshot })}
                        >
                          <Icon name="restore" />
                        </button>
                        <button
                          className="icon-btn danger-hover"
                          title="Delete snapshot"
                          onClick={async () => {
                            if (!window.confirm(`Delete snapshot “${snapshot.name}”?`)) return;
                            try {
                              await deleteSnapshot(workspace.id, snapshot.id);
                              notify("Snapshot deleted", "ok");
                              void load();
                              onRefresh();
                            } catch (err) {
                              notify(errorMessage(err), "error");
                            }
                          }}
                        >
                          <Icon name="trash" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {loaded
        .filter((entry) => entry.error)
        .map((entry) => (
          <div className="callout bad" key={entry.workspace.id}>
            <div className="callout-icon"><Icon name="alert" /></div>
            <div>
              <strong>{entry.workspace.label}</strong>
              <p>{entry.error}</p>
            </div>
          </div>
        ))}

      {restoreTarget ? (
        <RestoreModal
          workspace={restoreTarget.workspace}
          snapshot={restoreTarget.snapshot}
          fleet={fleet}
          onClose={() => setRestoreTarget(null)}
          onDone={() => {
            setRestoreTarget(null);
            notify("Restore queued", "ok");
            onRefresh();
          }}
          notify={notify}
        />
      ) : null}
    </div>
  );
}

function RestoreModal({
  workspace,
  snapshot,
  fleet,
  onClose,
  onDone,
  notify,
}: {
  workspace: Workspace;
  snapshot: Snapshot;
  fleet: Fleet | null;
  onClose: () => void;
  onDone: () => void;
  notify: (message: string, tone?: "ok" | "error" | "info") => void;
}) {
  const machines = (fleet?.machines ?? []).filter(
    (machine) => machine.workspaceId === workspace.id,
  );
  const [machineId, setMachineId] = useState(
    machines.find((machine) => machine.id === snapshot.sourceMachineId)?.id ??
      machines[0]?.id ??
      "",
  );
  const [start, setStart] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (!machineId) return;
    setBusy(true);
    try {
      await restoreSnapshot(workspace.id, machineId, snapshot.id, start);
      onDone();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title={`Restore “${snapshot.name}”`}
      subtitle="Replaces the machine's root disk and /data in place. Everything since the snapshot is lost."
      width={460}
      onClose={onClose}
      footer={
        <>
          <button className="btn ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="btn danger" onClick={() => void submit()} disabled={busy || !machineId}>
            {busy ? <span className="spinner" /> : <Icon name="restore" />} Restore
          </button>
        </>
      }
    >
      <div className="form">
        <label className="field">
          <span className="field-label">Target machine</span>
          <select value={machineId} onChange={(event) => setMachineId(event.target.value)}>
            {machines.map((machine) => (
              <option key={machine.id} value={machine.id}>
                {machine.name} · {machine.state}
              </option>
            ))}
          </select>
        </label>
        <label className="check-row">
          <input type="checkbox" checked={start} onChange={(event) => setStart(event.target.checked)} />
          <span>Start the machine after restoring</span>
        </label>
        {error ? <div className="term-inline-error">{error}</div> : null}
        <p className="hint">
          The machine keeps its ID, name and public port URLs. Its SSH host key and running programs
          are replaced.
        </p>
      </div>
    </Modal>
  );
}

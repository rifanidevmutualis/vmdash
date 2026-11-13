import { useEffect, useState } from "react";
import {
  createSnapshot,
  deleteSnapshot,
  errorMessage,
  forkMachine,
  restoreSnapshot,
  workspaceSnapshots,
} from "../../api";
import { ago, bytes, dateTime } from "../../format";
import { Icon } from "../../icons";
import type { Machine, Snapshot } from "../../types";

export function SnapshotsTab({
  machine,
  notify,
}: {
  machine: Machine;
  notify: (message: string, tone?: "ok" | "error" | "info") => void;
}) {
  const [snapshots, setSnapshots] = useState<Snapshot[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [rootOnly, setRootOnly] = useState(false);
  const [busy, setBusy] = useState(false);

  const running = machine.state === "running";

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const result = await workspaceSnapshots(machine.workspaceId);
      setSnapshots(
        result.snapshots.filter((snapshot) => snapshot.sourceMachineId === machine.id),
      );
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [machine.id]);

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    try {
      await createSnapshot(machine.workspaceId, machine.id, {
        name: name.trim(),
        description: description.trim() || undefined,
        rootOnly,
      });
      notify(
        running ? "Snapshot queued (live copy)" : "Snapshot saved",
        "ok",
      );
      setName("");
      setDescription("");
      setRootOnly(false);
      void load();
    } catch (err) {
      notify(errorMessage(err), "error");
    } finally {
      setBusy(false);
    }
  }

  async function remove(snapshot: Snapshot) {
    if (!window.confirm(`Delete snapshot “${snapshot.name}”?`)) return;
    try {
      await deleteSnapshot(machine.workspaceId, snapshot.id);
      notify("Snapshot deleted", "ok");
      void load();
    } catch (err) {
      notify(errorMessage(err), "error");
    }
  }

  async function restore(snapshot: Snapshot) {
    if (
      !window.confirm(
        `Restore “${snapshot.name}” into ${machine.name}? Everything on its disks since the snapshot is lost.`,
      )
    ) {
      return;
    }
    try {
      await restoreSnapshot(machine.workspaceId, machine.id, snapshot.id, false);
      notify("Restore queued", "ok");
    } catch (err) {
      notify(errorMessage(err), "error");
    }
  }

  async function fork() {
    if (!window.confirm(`Fork ${machine.name} into a new machine on the same host?`)) return;
    try {
      await forkMachine(machine.workspaceId, machine.id, { name: `${machine.name}-fork` });
      notify("Fork queued", "ok");
    } catch (err) {
      notify(errorMessage(err), "error");
    }
  }

  return (
    <div className="snapshots-panel">
      <div className="snapshot-actions">
        <div>
          <strong>Snapshot this machine</strong>
          <p className="hint">
            Saves the system disk and <code>/data</code>. Snapshots are org-wide and survive machine
            deletion. {running ? "A running machine freezes briefly for a live copy." : ""}
          </p>
        </div>
        <button className="btn" onClick={() => void fork()}>
          <Icon name="fork" /> Fork machine
        </button>
      </div>

      <form className="snapshot-form" onSubmit={save}>
        <label className="field">
          <span className="field-label">Name</span>
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="before-upgrade"
            spellCheck={false}
          />
        </label>
        <label className="field grow">
          <span className="field-label">Description <span className="muted">(optional)</span></span>
          <input
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            placeholder="why you saved this state"
          />
        </label>
        <label className="check-row compact">
          <input
            type="checkbox"
            checked={rootOnly}
            onChange={(event) => setRootOnly(event.target.checked)}
          />
          <span>System files only</span>
        </label>
        <button className="btn primary" type="submit" disabled={busy || !name.trim()}>
          {busy ? <span className="spinner" /> : <Icon name="camera" />} Save snapshot
        </button>
      </form>

      {error ? <div className="term-inline-error">{error}</div> : null}

      {loading && snapshots.length === 0 ? <div className="row-empty">Loading snapshots…</div> : null}
      {!loading && snapshots.length === 0 ? (
        <div className="row-empty">No snapshots from this machine yet.</div>
      ) : (
        <div className="snapshot-list">
          {snapshots.map((snapshot) => (
            <div className="snapshot-row" key={snapshot.id}>
              <div className="snapshot-main">
                <span className={`status-dot tone-${snapshot.status === "ready" ? "ok" : snapshot.status === "failed" ? "bad" : "busy"}`} />
                <div>
                  <div className="snapshot-name">{snapshot.name}</div>
                  <div className="snapshot-meta">
                    <code>{snapshot.id}</code>
                    <span className="dot-sep">·</span>
                    {bytes(snapshot.dataSizeBytes ?? snapshot.rootSizeBytes)}
                    <span className="dot-sep">·</span>
                    {ago(snapshot.createdAt)}
                  </div>
                </div>
              </div>
              <span className={`state-pill tone-${snapshot.status === "ready" ? "ok" : snapshot.status === "failed" ? "bad" : "busy"}`}>
                {snapshot.status}
              </span>
              <span className="muted small" title={dateTime(snapshot.createdAt)}>
                {snapshot.description || "—"}
              </span>
              <div className="row-actions">
                <button
                  className="icon-btn"
                  title="Restore into this machine"
                  onClick={() => void restore(snapshot)}
                  disabled={snapshot.status !== "ready"}
                >
                  <Icon name="restore" />
                </button>
                <button
                  className="icon-btn danger-hover"
                  title="Delete snapshot"
                  onClick={() => void remove(snapshot)}
                >
                  <Icon name="trash" />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

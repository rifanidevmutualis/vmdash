import { useEffect, useMemo, useRef, useState } from "react";
import type { BulkResponse, Fleet, Machine } from "../types";
import { ago, idleLabel, money, sizeLabel, templateLabel } from "../format";
import { Icon } from "../icons";
import { MachineDot, StatePill } from "../components/Status";
import { bulkAction, errorMessage } from "../api";
import { Modal } from "../components/Modal";

type StatusFilter = "all" | "running" | "paused" | "stopped" | "error";

export function FleetView({
  fleet,
  loading,
  onSelect,
  onAction,
  onDelete,
  onNew,
  onAddWorkspace,
  onSync,
  notify,
  onRefresh,
}: {
  fleet: Fleet | null;
  loading: boolean;
  onSelect: (machine: Machine) => void;
  onAction: (machine: Machine, action: string) => void;
  onDelete: (machine: Machine) => void;
  onNew: () => void;
  onAddWorkspace: () => void;
  onSync: () => void;
  notify: (message: string, tone?: "ok" | "error" | "info") => void;
  onRefresh: () => void;
}) {
  const [status, setStatus] = useState<StatusFilter>("all");
  const [workspace, setWorkspace] = useState("all");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkConfirm, setBulkConfirm] = useState<"stop" | "delete" | null>(null);
  const [bulkResult, setBulkResult] = useState<BulkResponse | null>(null);
  const [deletePhrase, setDeletePhrase] = useState("");
  const selectAllRef = useRef<HTMLInputElement>(null);

  const machines = fleet?.machines ?? [];
  const workspaces = fleet?.workspaces ?? [];
  const stats = fleet?.stats;

  const workspaceIndex = useMemo(() => {
    const map = new Map<string, number>();
    workspaces.forEach((item, index) => map.set(item.id, index));
    return map;
  }, [workspaces]);

  const filtered = useMemo(() => {
    return machines.filter((machine) => {
      if (status !== "all") {
        const matches =
          status === "paused" ? machine.state === "suspended" : machine.state === status;
        if (!matches) return false;
      }
      if (workspace !== "all" && machine.workspaceId !== workspace) return false;
      if (query.trim()) {
        const needle = query.trim().toLowerCase();
        if (
          !machine.name.toLowerCase().includes(needle) &&
          !machine.id.toLowerCase().includes(needle)
        ) {
          return false;
        }
      }
      return true;
    });
  }, [machines, status, workspace, query]);

  const counts: Record<StatusFilter, number> = {
    all: stats?.total ?? 0,
    running: stats?.running ?? 0,
    paused: stats?.paused ?? 0,
    stopped: stats?.stopped ?? 0,
    error: stats?.error ?? 0,
  };

  const keyOf = (machine: Machine) => `${machine.workspaceId}:${machine.id}`;
  const selectedMachines = useMemo(
    () => machines.filter((machine) => selected.has(keyOf(machine))),
    [machines, selected],
  );
  const visibleSelected = filtered.filter((machine) => selected.has(keyOf(machine)));
  const allVisibleSelected = filtered.length > 0 && visibleSelected.length === filtered.length;
  const someVisibleSelected = visibleSelected.length > 0 && !allVisibleSelected;

  useEffect(() => {
    if (selectAllRef.current) {
      selectAllRef.current.indeterminate = someVisibleSelected;
    }
  }, [someVisibleSelected]);

  const canStart = selectedMachines.some((machine) => ["stopped", "error"].includes(machine.state));
  const canResume = selectedMachines.some((machine) => machine.state === "suspended");
  const canPause = selectedMachines.some((machine) => machine.state === "running");
  const canStop = canPause;
  const canDelete = selectedMachines.length > 0;

  function toggleSelect(machine: Machine) {
    const key = keyOf(machine);
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function toggleVisible() {
    setSelected((current) => {
      const next = new Set(current);
      if (allVisibleSelected) {
        filtered.forEach((machine) => next.delete(keyOf(machine)));
      } else {
        filtered.forEach((machine) => next.add(keyOf(machine)));
      }
      return next;
    });
  }

  async function runBulk(action: string, confirm?: string) {
    if (selectedMachines.length === 0) return;
    setBulkBusy(true);
    try {
      const result = await bulkAction(
        action,
        selectedMachines.map((machine) => ({
          workspaceId: machine.workspaceId,
          machineId: machine.id,
        })),
        confirm,
      );
      if (result.failed > 0) {
        setBulkResult(result);
        notify(`${result.ok} queued · ${result.failed} failed`, "error");
      } else {
        notify(
          `${result.ok} machine${result.ok === 1 ? "" : "s"} queued for ${action}`,
          "ok",
        );
      }
      setSelected(new Set());
      setBulkConfirm(null);
      onRefresh();
    } catch (err) {
      notify(errorMessage(err), "error");
    } finally {
      setBulkBusy(false);
    }
  }

  if (!fleet) {
    return (
      <div className="page">
        <div className="skeleton-grid">
          {[0, 1, 2, 3].map((index) => (
            <div className="skeleton card" key={index} />
          ))}
        </div>
        <div className="skeleton table" />
      </div>
    );
  }

  if (workspaces.length === 0) {
    return (
      <div className="page">
        <header className="page-head">
          <div>
            <div className="eyebrow">Control plane</div>
            <h1>Fleet</h1>
            <p>No workspace connected yet.</p>
          </div>
        </header>
        <div className="onboard">
          <div className="onboard-art" aria-hidden="true">
            <div className="orb orb-a" />
            <div className="orb orb-b" />
            <div className="onboard-grid">
              {["ws · acme", "vm · agent-01", "vm · agent-02", "mcp · stdio"].map((label, index) => (
                <div className={`mini-node n${index}`} key={label}>
                  <span className={`status-dot tone-${index === 3 ? "busy" : index === 0 ? "idle" : "ok"}`} />
                  {label}
                </div>
              ))}
            </div>
          </div>
          <div className="onboard-copy">
            <div className="eyebrow">Step 1</div>
            <h2>Connect your first InstaBox workspace</h2>
            <p>
              Paste one InstaBox API key. Every machine in that workspace appears here, and the MCP
              server starts controlling them immediately.
            </p>
            <ol className="steps">
              <li>
                <span className="step-num">1</span>
                <span className="step-text">Create an API key in the InstaBox dashboard.</span>
              </li>
              <li>
                <span className="step-num">2</span>
                <span className="step-text">
                  Give it <code>machines:read</code>, <code>machines:write</code> and{" "}
                  <code>machines:delete</code>.
                </span>
              </li>
              <li>
                <span className="step-num">3</span>
                <span className="step-text">
                  Paste it here. It is encrypted with a local master key.
                </span>
              </li>
            </ol>
            <div className="onboard-actions">
              <button className="btn primary lg" onClick={onAddWorkspace}>
                <Icon name="key" /> Connect workspace
              </button>
              <a
                className="btn ghost lg"
                href="https://dashboard.instabox.sh/dashboard/api-keys"
                target="_blank"
                rel="noreferrer"
              >
                Create a key <Icon name="external" />
              </a>
            </div>
            <p className="hint">
              A key belongs to one workspace, not one VM. That is why one paste covers a whole fleet.
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <div className="eyebrow">Control plane</div>
          <h1>Fleet</h1>
          <p>
            {stats?.total ?? 0} machines · {workspaces.length} workspace
            {workspaces.length === 1 ? "" : "s"} · synced {ago(fleet.generatedAt)}
            {loading ? <span className="sync-dot" /> : null}
          </p>
        </div>
        <div className="head-actions">
          <button className="btn ghost" onClick={onSync} disabled={loading}>
            <Icon name="refresh" className={loading ? "spin" : undefined} /> Sync
          </button>
          <button className="btn primary" onClick={onNew}>
            <Icon name="plus" /> New machine
          </button>
        </div>
      </header>

      <section className="stat-row">
        <div className="stat card">
          <div className="stat-top">
            <span className="stat-label">Machines</span>
            <Icon name="server" />
          </div>
          <div className="stat-value">{stats?.total ?? 0}</div>
          <div className="stat-foot">
            <span className="muted">{workspaces.length} workspaces</span>
          </div>
        </div>
        <div className="stat card accent">
          <div className="stat-top">
            <span className="stat-label">Running</span>
            <span className="live-pulse" />
          </div>
          <div className="stat-value">{stats?.running ?? 0}</div>
          <div className="stat-foot">
            <span className="muted">
              {stats && stats.total > 0
                ? `${Math.round((stats.running / stats.total) * 100)}% of fleet`
                : "no machines yet"}
            </span>
          </div>
        </div>
        <div className="stat card">
          <div className="stat-top">
            <span className="stat-label">Paused</span>
            <Icon name="pause" />
          </div>
          <div className="stat-value">{stats?.paused ?? 0}</div>
          <div className="stat-foot">
            <span className="muted">memory kept · instant resume</span>
          </div>
        </div>
        <div className="stat card">
          <div className="stat-top">
            <span className="stat-label">Month to date</span>
            <Icon name="activity" />
          </div>
          <div className="stat-value money">{money(fleet.spend.monthUSD)}</div>
          <div className="stat-foot">
            <span className="muted">usage across connected keys</span>
          </div>
        </div>
      </section>

      {stats && stats.error > 0 ? (
        <button className="alert-strip" onClick={() => setStatus("error")}>
          <Icon name="alert" />
          <span>
            <strong>{stats.error}</strong> machine{stats.error === 1 ? "" : "s"} in an error state.
          </span>
          <span className="alert-cta">Show <Icon name="arrow" /></span>
        </button>
      ) : null}

      <section className="panel">
        <div className="filter-row">
          <div className="segmented">
            {(["all", "running", "paused", "stopped", "error"] as StatusFilter[]).map((item) => (
              <button
                key={item}
                className={status === item ? "segment active" : "segment"}
                onClick={() => setStatus(item)}
              >
                {item}
                <span className="segment-count">{counts[item]}</span>
              </button>
            ))}
          </div>
          <div className="filter-right">
            <div className="select-wrap">
              <Icon name="workspace" />
              <select value={workspace} onChange={(event) => setWorkspace(event.target.value)}>
                <option value="all">All workspaces</option>
                {workspaces.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="search-wrap">
              <Icon name="search" />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search name or id"
                spellCheck={false}
              />
            </div>
          </div>
        </div>

        {selectedMachines.length > 0 ? (
          <div className="bulk-bar">
            <div className="bulk-count">
              <strong>{selectedMachines.length}</strong> selected
            </div>
            <div className="bulk-actions">
              <button
                className="btn tiny-btn"
                disabled={!canStart || bulkBusy}
                onClick={() => void runBulk("start")}
              >
                <Icon name="play" size={12} /> Start
              </button>
              <button
                className="btn tiny-btn"
                disabled={!canResume || bulkBusy}
                onClick={() => void runBulk("resume")}
              >
                <Icon name="play" size={12} /> Resume
              </button>
              <button
                className="btn tiny-btn"
                disabled={!canPause || bulkBusy}
                onClick={() => void runBulk("suspend")}
              >
                <Icon name="pause" size={12} /> Pause
              </button>
              <button
                className="btn danger tiny-btn"
                disabled={!canStop || bulkBusy}
                onClick={() => {
                  setDeletePhrase("");
                  setBulkConfirm("stop");
                }}
              >
                <Icon name="stop" size={12} /> Stop
              </button>
              <button
                className="btn danger tiny-btn"
                disabled={!canDelete || bulkBusy}
                onClick={() => {
                  setDeletePhrase("");
                  setBulkConfirm("delete");
                }}
              >
                <Icon name="trash" size={12} /> Delete
              </button>
              {bulkBusy ? <span className="spinner" /> : null}
            </div>
            <button className="link-btn" onClick={() => setSelected(new Set())}>
              Clear
            </button>
          </div>
        ) : null}

        {filtered.length === 0 ? (
          <div className="table-empty">
            <div className="empty-icon"><Icon name="box" size={22} /></div>
            <h3>{machines.length === 0 ? "No machines in this fleet yet" : "Nothing matches"}</h3>
            <p>
              {machines.length === 0
                ? "Create one from a template, or let an agent create it over MCP."
                : "Try another status, workspace or search term."}
            </p>
            {machines.length === 0 ? (
              <button className="btn primary" onClick={onNew}>
                <Icon name="plus" /> New machine
              </button>
            ) : null}
          </div>
        ) : (
          <div className="table-scroll">
            <table className="fleet-table">
              <thead>
                <tr>
                  <th className="select-col">
                    <input
                      ref={selectAllRef}
                      type="checkbox"
                      checked={allVisibleSelected}
                      onChange={toggleVisible}
                      aria-label="Select all visible machines"
                    />
                  </th>
                  <th>Machine</th>
                  <th>State</th>
                  <th>Size</th>
                  <th>Template</th>
                  <th>Idle pause</th>
                  <th>Age</th>
                  <th className="right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((machine) => {
                  const dimmed = ["stopped", "suspended"].includes(machine.state);
                  return (
                    <tr
                      key={`${machine.workspaceId}:${machine.id}`}
                      className={dimmed ? "row dim" : "row"}
                      onClick={() => onSelect(machine)}
                      tabIndex={0}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") onSelect(machine);
                      }}
                    >
                      <td className="select-col" onClick={(event) => event.stopPropagation()}>
                        <input
                          type="checkbox"
                          checked={selected.has(keyOf(machine))}
                          onChange={() => toggleSelect(machine)}
                          aria-label={`Select ${machine.name}`}
                        />
                      </td>
                      <td>
                        <div className="machine-cell">
                          <MachineDot index={workspaceIndex.get(machine.workspaceId) ?? 0} />
                          <div>
                            <div className="machine-name">
                              {machine.name}
                              {machine.free ? <span className="chip subtle tiny">free</span> : null}
                            </div>
                            <div className="machine-meta">
                              <span>{machine.workspaceLabel ?? "workspace"}</span>
                            </div>
                          </div>
                        </div>
                      </td>
                      <td><StatePill state={machine.state} /></td>
                      <td className="mono">{sizeLabel(machine)}</td>
                      <td>
                        <span className="template-chip">{templateLabel(machine)}</span>
                      </td>
                      <td className="mono muted">{idleLabel(machine.autoSuspendAfterSeconds)}</td>
                      <td className="mono muted">{ago(machine.createdAt)}</td>
                      <td>
                        <div className="row-actions" onClick={(event) => event.stopPropagation()}>
                          {machine.state === "running" ? (
                            <button
                              className="icon-btn"
                              title="Pause"
                              onClick={() => onAction(machine, "suspend")}
                            >
                              <Icon name="pause" />
                            </button>
                          ) : null}
                          {machine.state === "suspended" ? (
                            <button
                              className="icon-btn"
                              title="Resume"
                              onClick={() => onAction(machine, "resume")}
                            >
                              <Icon name="play" />
                            </button>
                          ) : null}
                          {machine.state === "stopped" || machine.state === "error" ? (
                            <button
                              className="icon-btn"
                              title="Start"
                              onClick={() => onAction(machine, "start")}
                            >
                              <Icon name="play" />
                            </button>
                          ) : null}
                          <button
                            className="icon-btn"
                            title="Open terminal"
                            onClick={() => onSelect(machine)}
                          >
                            <Icon name="terminal" />
                          </button>
                          <button
                            className="icon-btn danger-hover"
                            title="Delete"
                            onClick={() => onDelete(machine)}
                          >
                            <Icon name="trash" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <div className="fleet-foot">
        <span>
          <span className="status-dot tone-ok" /> live cache · auto-refresh
        </span>
        <span className="muted">Operations are queued one at a time per machine.</span>
      </div>

      {bulkConfirm ? (
        <Modal
          title={
            bulkConfirm === "delete"
              ? `Delete ${selectedMachines.length} machine${selectedMachines.length === 1 ? "" : "s"}?`
              : `Stop ${selectedMachines.length} machine${selectedMachines.length === 1 ? "" : "s"}?`
          }
          subtitle={
            bulkConfirm === "delete"
              ? "This removes the machines and their disks. Snapshots are kept."
              : "Running programs end. Files and snapshots are kept."
          }
          width={480}
          onClose={() => setBulkConfirm(null)}
          footer={
            <>
              <button
                className="btn ghost"
                onClick={() => setBulkConfirm(null)}
                disabled={bulkBusy}
              >
                Cancel
              </button>
              <button
                className={`btn ${bulkConfirm === "delete" ? "danger" : "primary"}`}
                disabled={
                  bulkBusy ||
                  (bulkConfirm === "delete" && deletePhrase.trim().toLowerCase() !== "delete")
                }
                onClick={() => {
                  if (bulkConfirm === "delete") void runBulk("delete", "delete");
                  else void runBulk("stop");
                }}
              >
                {bulkBusy ? <span className="spinner" /> : <Icon name={bulkConfirm === "delete" ? "trash" : "stop"} />}
                {bulkConfirm === "delete" ? "Delete machines" : "Stop machines"}
              </button>
            </>
          }
        >
          <div className="bulk-confirm">
            <ul className="bulk-names">
              {selectedMachines.map((machine) => (
                <li key={keyOf(machine)}>
                  <strong>{machine.name}</strong>
                  <span>{machine.workspaceLabel ?? machine.workspaceId}</span>
                </li>
              ))}
            </ul>
            {bulkConfirm === "delete" ? (
              <label className="field">
                <span className="field-label">
                  Type <code>delete</code> to confirm
                </span>
                <input
                  value={deletePhrase}
                  onChange={(event) => setDeletePhrase(event.target.value)}
                  autoFocus
                  spellCheck={false}
                />
              </label>
            ) : null}
          </div>
        </Modal>
      ) : null}

      {bulkResult ? (
        <Modal
          title="Bulk action results"
          subtitle={`${bulkResult.ok} queued · ${bulkResult.failed} failed`}
          width={520}
          onClose={() => setBulkResult(null)}
          footer={
            <button className="btn primary" onClick={() => setBulkResult(null)}>
              Close
            </button>
          }
        >
          <div className="bulk-results">
            {bulkResult.results.map((result) => (
              <div className="bulk-result-row" key={`${result.workspaceId}:${result.machineId}`}>
                <span className={`result ${result.ok ? "ok" : "bad"}`}>
                  <Icon name={result.ok ? "check" : "x"} size={12} />
                  {result.ok ? "queued" : "failed"}
                </span>
                <div>
                  <strong>{result.name ?? result.machineId}</strong>
                  {result.error ? <p>{result.error.message}</p> : null}
                </div>
              </div>
            ))}
          </div>
        </Modal>
      ) : null}
    </div>
  );
}

import { useEffect, useMemo, useState } from "react";
import {
  createSchedule,
  deleteSchedule,
  errorMessage,
  getSchedules,
  runSchedule,
  toggleSchedule,
  type CreateScheduleInput,
} from "../api";
import { dateTime } from "../format";
import { Icon } from "../icons";
import type { Fleet, Schedule, ScheduleResult } from "../types";
import { Modal } from "../components/Modal";

const ACTION_LABEL: Record<string, string> = {
  start: "Start",
  resume: "Resume",
  suspend: "Pause",
  stop: "Stop",
};

function until(iso?: string | null): string {
  if (!iso) return "";
  const diff = new Date(iso).getTime() - Date.now();
  if (Number.isNaN(diff)) return "";
  if (diff <= 0) return "due now";
  const minutes = Math.round(diff / 60000);
  if (minutes < 60) return `in ${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `in ${hours}h`;
  return `in ${Math.round(hours / 24)}d`;
}

function scheduleText(schedule: Schedule): string {
  if (schedule.kind === "daily") return `Every day at ${schedule.timeOfDay ?? "—"}`;
  if (schedule.kind === "weekdays") return `Weekdays at ${schedule.timeOfDay ?? "—"}`;
  if (schedule.kind === "hourly") return `Every hour at :${String(schedule.minute ?? 0).padStart(2, "0")}`;
  if (schedule.kind === "once") return `Once at ${dateTime(schedule.runAt)}`;
  return schedule.kind;
}

function ResultSummary({ result }: { result?: ScheduleResult | null }) {
  if (!result) return <span className="muted small">—</span>;
  if (result.missed) return <span className="schedule-result missed">missed</span>;
  if (result.error) return <span className="schedule-result bad">{result.error}</span>;
  return (
    <span className="schedule-result">
      {result.ok} ok
      {result.failed ? ` · ${result.failed} failed` : ""}
      {result.skipped ? ` · ${result.skipped} skipped` : ""}
    </span>
  );
}

export function SchedulesView({
  fleet,
  notify,
}: {
  fleet: Fleet | null;
  notify: (message: string, tone?: "ok" | "error" | "info") => void;
}) {
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);

  async function load() {
    try {
      const result = await getSchedules();
      setSchedules(result.schedules);
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), 15000);
    return () => window.clearInterval(timer);
  }, []);

  const workspaceName = (id?: string | null) =>
    fleet?.workspaces.find((workspace) => workspace.id === id)?.label ?? id ?? "—";

  async function toggle(schedule: Schedule) {
    setBusyId(schedule.id);
    try {
      await toggleSchedule(schedule.id, !schedule.enabled);
      notify(schedule.enabled ? "Schedule paused" : "Schedule enabled", "ok");
      void load();
    } catch (err) {
      notify(errorMessage(err), "error");
    } finally {
      setBusyId(null);
    }
  }

  async function runNow(schedule: Schedule) {
    setBusyId(schedule.id);
    try {
      const result = await runSchedule(schedule.id);
      notify(
        `Ran “${schedule.name}”: ${result.result.ok} ok, ${result.result.failed} failed, ${result.result.skipped} skipped`,
        result.result.failed > 0 ? "error" : "ok",
      );
      void load();
    } catch (err) {
      notify(errorMessage(err), "error");
    } finally {
      setBusyId(null);
    }
  }

  async function remove(schedule: Schedule) {
    if (!window.confirm(`Delete schedule “${schedule.name}”?`)) return;
    setBusyId(schedule.id);
    try {
      await deleteSchedule(schedule.id);
      notify("Schedule deleted", "ok");
      void load();
    } catch (err) {
      notify(errorMessage(err), "error");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="page schedules-page">
      <header className="page-head">
        <div>
          <div className="eyebrow">Automation</div>
          <h1>Schedules</h1>
          <p>
            Time-based actions for the fleet. The scheduler checks every 30 seconds in the
            server's local time.
          </p>
        </div>
        <div className="head-actions">
          <button className="btn ghost" onClick={() => void load()} disabled={loading}>
            <Icon name="refresh" className={loading ? "spin" : undefined} /> Refresh
          </button>
          <button className="btn primary" onClick={() => setCreateOpen(true)}>
            <Icon name="plus" /> New schedule
          </button>
        </div>
      </header>

      <div className="callout info wide">
        <div className="callout-icon"><Icon name="clock" /></div>
        <div>
          <strong>Only machines in the right state are touched.</strong>
          <p>
            A Pause/Stop schedule only applies to running machines; Resume applies to paused
            machines; Start applies to stopped or error machines. Scheduled actions are recorded in
            Activity and respect the same InstaBox limits as manual actions.
          </p>
        </div>
      </div>

      {error ? <div className="term-inline-error">{error}</div> : null}

      {schedules.length === 0 && !loading ? (
        <div className="table-empty card">
          <div className="empty-icon"><Icon name="clock" size={22} /></div>
          <h3>No schedules yet</h3>
          <p>
            Add a nightly pause, a morning start, or a one-time action. The scheduler runs locally;
            no external cron daemon is needed.
          </p>
          <button className="btn primary" onClick={() => setCreateOpen(true)}>
            <Icon name="plus" /> New schedule
          </button>
        </div>
      ) : (
        <section className="panel">
          <div className="table-scroll">
            <table className="schedule-table">
              <thead>
                <tr>
                  <th>Schedule</th>
                  <th>Action</th>
                  <th>Scope</th>
                  <th>Next run</th>
                  <th>Last run</th>
                  <th>Enabled</th>
                  <th className="right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {schedules.map((schedule) => (
                  <tr key={schedule.id} className={schedule.enabled ? "" : "schedule-disabled"}>
                    <td>
                      <div className="machine-name">{schedule.name}</div>
                      <div className="machine-meta">
                        <span>{scheduleText(schedule)}</span>
                        <span className="dot-sep">·</span>
                        <span>local time</span>
                      </div>
                    </td>
                    <td>
                      <span className={`schedule-action action-${schedule.action}`}>
                        {ACTION_LABEL[schedule.action] ?? schedule.action}
                      </span>
                    </td>
                    <td>
                      <span className="schedule-scope">
                        {schedule.scope === "workspace"
                          ? workspaceName(schedule.workspaceId)
                          : `${schedule.machineIds?.length ?? 0} machine${schedule.machineIds?.length === 1 ? "" : "s"}`}
                      </span>
                      {schedule.scope === "machines" ? (
                        <div className="machine-meta">{workspaceName(schedule.workspaceId)}</div>
                      ) : null}
                    </td>
                    <td className="mono small">
                      {schedule.enabled && schedule.nextRunAt ? (
                        <>
                          <div>{dateTime(schedule.nextRunAt)}</div>
                          <div className="muted">{until(schedule.nextRunAt)}</div>
                        </>
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                    <td>
                      {schedule.lastRunAt ? (
                        <>
                          <div className="mono small">{dateTime(schedule.lastRunAt)}</div>
                          <ResultSummary result={schedule.lastResult} />
                        </>
                      ) : (
                        <span className="muted small">never</span>
                      )}
                    </td>
                    <td>
                      <label className="check-row compact">
                        <input
                          type="checkbox"
                          checked={schedule.enabled}
                          disabled={busyId === schedule.id}
                          onChange={() => void toggle(schedule)}
                        />
                        <span className="muted small">{schedule.enabled ? "on" : "off"}</span>
                      </label>
                    </td>
                    <td>
                      <div className="row-actions">
                        <button
                          className="icon-btn"
                          title="Run now"
                          onClick={() => void runNow(schedule)}
                          disabled={busyId === schedule.id}
                        >
                          <Icon name="play" />
                        </button>
                        <button
                          className="icon-btn danger-hover"
                          title="Delete"
                          onClick={() => void remove(schedule)}
                          disabled={busyId === schedule.id}
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

      <p className="fleet-foot">
        <span>
          <span className="status-dot tone-ok" /> scheduler active · checks every 30s
        </span>
        <span className="muted">
          Missed windows older than 5 minutes are skipped, not replayed.
        </span>
      </p>

      {createOpen ? (
        <CreateScheduleModal
          fleet={fleet}
          onClose={() => setCreateOpen(false)}
          onCreated={() => {
            setCreateOpen(false);
            notify("Schedule created", "ok");
            void load();
          }}
          notify={notify}
        />
      ) : null}
    </div>
  );
}

function defaultRunAt(): string {
  const date = new Date(Date.now() + 60 * 60 * 1000);
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 16);
}

function CreateScheduleModal({
  fleet,
  onClose,
  onCreated,
  notify,
}: {
  fleet: Fleet | null;
  onClose: () => void;
  onCreated: () => void;
  notify: (message: string, tone?: "ok" | "error" | "info") => void;
}) {
  const workspaces = fleet?.workspaces ?? [];
  const initialWorkspace = workspaces[0]?.id ?? "";
  const [name, setName] = useState("");
  const [action, setAction] = useState("suspend");
  const [scope, setScope] = useState<"workspace" | "machines">("workspace");
  const [workspaceId, setWorkspaceId] = useState(initialWorkspace);
  const [machineIds, setMachineIds] = useState<string[]>([]);
  const [kind, setKind] = useState("daily");
  const [timeOfDay, setTimeOfDay] = useState("23:00");
  const [minute, setMinute] = useState("0");
  const [runAt, setRunAt] = useState(defaultRunAt);
  const [enabled, setEnabled] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const machines = useMemo(
    () => (fleet?.machines ?? []).filter((machine) => machine.workspaceId === workspaceId),
    [fleet, workspaceId],
  );

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!name.trim() || !workspaceId) return;
    if (scope === "machines" && machineIds.length === 0) {
      setError("Choose at least one machine.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const input: CreateScheduleInput = {
        name: name.trim(),
        action,
        scope,
        workspaceId,
        machineIds: scope === "machines" ? machineIds : undefined,
        kind,
        enabled,
        timeOfDay: kind === "daily" || kind === "weekdays" ? timeOfDay : undefined,
        minute: kind === "hourly" ? Number(minute) : undefined,
        runAt: kind === "once" ? new Date(runAt).toISOString() : undefined,
      };
      await createSchedule(input);
      onCreated();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title="New schedule"
      subtitle="Actions run in server local time, even when this dashboard is closed."
      width={620}
      onClose={onClose}
      footer={
        <>
          <button className="btn ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="btn primary" onClick={submit} disabled={busy || !name.trim()}>
            {busy ? <span className="spinner" /> : <Icon name="clock" />}
            Create schedule
          </button>
        </>
      }
    >
      <form className="form" onSubmit={submit}>
        <div className="form-row">
          <label className="field">
            <span className="field-label">Name</span>
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Nightly pause"
              autoFocus
            />
          </label>
          <label className="field">
            <span className="field-label">Action</span>
            <select value={action} onChange={(event) => setAction(event.target.value)}>
              <option value="suspend">Pause running</option>
              <option value="stop">Stop running</option>
              <option value="resume">Resume paused</option>
              <option value="start">Start stopped/error</option>
            </select>
          </label>
        </div>

        <div className="form-row">
          <label className="field">
            <span className="field-label">Workspace</span>
            <select
              value={workspaceId}
              onChange={(event) => {
                setWorkspaceId(event.target.value);
                setMachineIds([]);
              }}
            >
              {workspaces.map((workspace) => (
                <option key={workspace.id} value={workspace.id}>
                  {workspace.label}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span className="field-label">Scope</span>
            <select
              value={scope}
              onChange={(event) => setScope(event.target.value as "workspace" | "machines")}
            >
              <option value="workspace">All machines in workspace</option>
              <option value="machines">Specific machines</option>
            </select>
          </label>
        </div>

        {scope === "machines" ? (
          <div className="field">
            <span className="field-label">Machines</span>
            <div className="schedule-machine-list">
              {machines.length === 0 ? (
                <span className="muted small">No machines in this workspace.</span>
              ) : (
                machines.map((machine) => (
                  <label className="check-row compact" key={machine.id}>
                    <input
                      type="checkbox"
                      checked={machineIds.includes(machine.id)}
                      onChange={(event) => {
                        setMachineIds((current) =>
                          event.target.checked
                            ? [...new Set([...current, machine.id])]
                            : current.filter((id) => id !== machine.id),
                        );
                      }}
                    />
                    <span>{machine.name}</span>
                    <span className="muted small">{machine.state}</span>
                  </label>
                ))
              )}
            </div>
          </div>
        ) : null}

        <div className="form-row">
          <label className="field">
            <span className="field-label">Repeat</span>
            <select value={kind} onChange={(event) => setKind(event.target.value)}>
              <option value="daily">Every day</option>
              <option value="weekdays">Weekdays (Mon–Fri)</option>
              <option value="hourly">Every hour</option>
              <option value="once">Once</option>
            </select>
          </label>
          {kind === "daily" || kind === "weekdays" ? (
            <label className="field">
              <span className="field-label">At (local time)</span>
              <input type="time" value={timeOfDay} onChange={(event) => setTimeOfDay(event.target.value)} />
            </label>
          ) : null}
          {kind === "hourly" ? (
            <label className="field">
              <span className="field-label">Minute (0–59)</span>
              <input
                type="number"
                min={0}
                max={59}
                value={minute}
                onChange={(event) => setMinute(event.target.value)}
              />
            </label>
          ) : null}
          {kind === "once" ? (
            <label className="field">
              <span className="field-label">Run at (local time)</span>
              <input
                type="datetime-local"
                value={runAt}
                onChange={(event) => setRunAt(event.target.value)}
              />
            </label>
          ) : null}
        </div>

        <label className="check-row">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(event) => setEnabled(event.target.checked)}
          />
          <span>Enabled</span>
        </label>

        {error ? (
          <div className="callout bad">
            <div className="callout-icon"><Icon name="alert" /></div>
            <div><strong>Could not create schedule</strong><p>{error}</p></div>
          </div>
        ) : null}
      </form>
    </Modal>
  );
}

import { Fragment, useEffect, useMemo, useState } from "react";
import { errorMessage, getHealth, setHealthBudget } from "../api";
import { bytes, dateTime, money, templateLabel } from "../format";
import { Icon } from "../icons";
import type { HealthMachine, HealthOverview, Machine } from "../types";
import { StatePill } from "../components/Status";

function duration(seconds?: number | null): string {
  if (!seconds || seconds <= 0) return "—";
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function pct(used?: number | null, total?: number | null): number {
  if (!total || !used) return 0;
  return Math.min(100, Math.max(0, (used / total) * 100));
}

function Meter({ value, tone = "accent" }: { value: number; tone?: string }) {
  return (
    <div className="meter">
      <span style={{ width: `${value}%`, background: tone }} />
    </div>
  );
}

export function HealthView({
  notify,
  onOpenMachine,
}: {
  notify: (message: string, tone?: "ok" | "error" | "info") => void;
  onOpenMachine: (machine: Machine) => void;
}) {
  const [health, setHealth] = useState<HealthOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [budget, setBudget] = useState("");
  const [budgetReady, setBudgetReady] = useState(false);
  const [savingBudget, setSavingBudget] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);

  async function load(fresh = false) {
    if (!fresh) setLoading(true);
    try {
      const result = await getHealth(fresh);
      setHealth(result);
      setError(null);
      if (!budgetReady) {
        setBudget(result.budgetUSD == null ? "" : String(result.budgetUSD));
        setBudgetReady(true);
      }
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), 30000);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function saveBudget() {
    const trimmed = budget.trim();
    const value = trimmed === "" ? null : Number(trimmed);
    if (value !== null && (!Number.isFinite(value) || value < 0)) {
      notify("Budget must be a positive number", "error");
      return;
    }
    setSavingBudget(true);
    try {
      await setHealthBudget(value);
      notify(value == null ? "Budget cleared" : `Budget set to ${money(value)}`, "ok");
      await load(true);
    } catch (err) {
      notify(errorMessage(err), "error");
    } finally {
      setSavingBudget(false);
    }
  }

  const allFree = useMemo(
    () => (health?.workspaces ?? []).every((workspace) => workspace.tier === "free"),
    [health],
  );

  const machines = useMemo(() => {
    const list = [...(health?.machines ?? [])];
    list.sort((a, b) => {
      const aRunning = a.state === "running" ? 1 : 0;
      const bRunning = b.state === "running" ? 1 : 0;
      if (aRunning !== bRunning) return bRunning - aRunning;
      return (b.usage?.computeUSD ?? 0) - (a.usage?.computeUSD ?? 0);
    });
    return list;
  }, [health]);

  const leaks = machines.filter((machine) => machine.diagnostics?.possibleIdle);
  const budgetValue = health?.budgetUSD ?? null;
  const projected = health?.projectedUSD ?? 0;
  const overBudget = budgetValue != null && projected > budgetValue;
  const alreadyOver = budgetValue != null && (health?.totalCostUSD ?? 0) > budgetValue;

  return (
    <div className="page health-page">
      <header className="page-head">
        <div>
          <div className="eyebrow">Observe</div>
          <h1>Cost &amp; Health</h1>
          <p>
            Spend, projection, per-machine compute, and why a machine might still be running.
          </p>
        </div>
        <div className="head-actions">
          <button className="btn ghost" onClick={() => void load(true)} disabled={loading}>
            <Icon name="refresh" className={loading ? "spin" : undefined} /> Refresh
          </button>
        </div>
      </header>

      {error ? <div className="term-inline-error">{error}</div> : null}

      {alreadyOver || overBudget ? (
        <div className="alert-strip budget-alert">
          <Icon name="alert" />
          <span>
            {alreadyOver
              ? `Spend ${money(health?.totalCostUSD)} is already over the ${money(budgetValue)} budget.`
              : `Projected ${money(projected)} is over the ${money(budgetValue)} budget.`}
          </span>
          <span className="alert-cta">Warning only · machines are not auto-paused</span>
        </div>
      ) : null}

      {allFree && health ? (
        <div className="callout info wide">
          <div className="callout-icon"><Icon name="info" /></div>
          <div>
            <strong>All workspaces are on the free plan.</strong>
            <p>
              Free-plan machines are never billed, so compute stays $0.00. Watch cooldowns and the
              1-machine / 20 GiB / 5-snapshot limits instead of money. There is no monthly
              running-hour cap; each run can last up to 8 hours before a cooldown.
            </p>
          </div>
        </div>
      ) : null}

      <section className="stat-row health-stats">
        <div className="stat card accent">
          <div className="stat-top">
            <span className="stat-label">Month to date</span>
            <Icon name="activity" />
          </div>
          <div className="stat-value money">{money(health?.totalCostUSD ?? 0)}</div>
          <div className="stat-foot muted">
            {allFree ? "free machines · never billed" : "runtime + disk + egress"}
          </div>
        </div>
        <div className="stat card">
          <div className="stat-top">
            <span className="stat-label">Projected</span>
            <Icon name="arrow" />
          </div>
          <div className={`stat-value money ${overBudget ? "over-budget" : ""}`}>
            {money(projected)}
          </div>
          <div className="stat-foot muted">
            {budgetValue == null ? "set a budget below" : `budget ${money(budgetValue)}`}
          </div>
        </div>
        <div className="stat card">
          <div className="stat-top">
            <span className="stat-label">Credits left</span>
            <Icon name="key" />
          </div>
          <div className="stat-value money">{money(health?.creditsUSD ?? 0)}</div>
          <div className="stat-foot muted">
            allowance {money(health?.allowanceUSD ?? 0)}
          </div>
        </div>
        <div className="stat card">
          <div className="stat-top">
            <span className="stat-label">Running now</span>
            <span className="live-pulse" />
          </div>
          <div className="stat-value">{health?.machines.filter((m) => m.state === "running").length ?? 0}</div>
          <div className="stat-foot muted">
            {machines.length} machine{machines.length === 1 ? "" : "s"} total
          </div>
        </div>
      </section>

      <section className="panel budget-panel">
        <div className="panel-head">
          <h2>Monthly budget</h2>
          <span className="muted small">stored locally · warning only</span>
        </div>
        <div className="budget-body">
          <label className="field">
            <span className="field-label">Budget in USD</span>
            <input
              type="number"
              min={0}
              step="1"
              value={budget}
              onChange={(event) => setBudget(event.target.value)}
              placeholder="25"
            />
          </label>
          <button className="btn primary" onClick={() => void saveBudget()} disabled={savingBudget}>
            {savingBudget ? <span className="spinner" /> : <Icon name="save" />} Save budget
          </button>
          <button
            className="btn ghost"
            onClick={() => {
              setBudget("");
              void (async () => {
                await setHealthBudget(null);
                notify("Budget cleared", "ok");
                await load(true);
              })();
            }}
          >
            Clear
          </button>
          <span className="hint">
            vmdash never charges or auto-pauses from this number. It only shows a warning.
          </span>
        </div>
      </section>

      <section className="panel">
        <div className="panel-head">
          <h2>Workspaces</h2>
          <span className="muted small">this calendar month (UTC)</span>
        </div>
        <div className="table-scroll">
          <table className="health-table">
            <thead>
              <tr>
                <th>Workspace</th>
                <th>Plan</th>
                <th>Cost</th>
                <th>Projected</th>
                <th>Credits</th>
                <th>Machines</th>
                <th>Note</th>
              </tr>
            </thead>
            <tbody>
              {(health?.workspaces ?? []).map((workspace) => (
                <tr key={workspace.workspaceId}>
                  <td>
                    <div className="machine-name">{workspace.label}</div>
                    <div className="machine-meta">{workspace.orgName ?? workspace.workspaceId}</div>
                  </td>
                  <td><span className={`tier tier-${workspace.tier ?? "free"}`}>{workspace.tier ?? "free"}</span></td>
                  <td className="mono">{money(workspace.costUSD)}</td>
                  <td className="mono muted">
                    {workspace.projectedUSD == null ? "—" : money(workspace.projectedUSD)}
                  </td>
                  <td className="mono muted">{money(workspace.creditsUSD)}</td>
                  <td className="mono">
                    {workspace.machines ?? 0}
                    <span className="muted"> · {workspace.running} running</span>
                  </td>
                  <td className="muted small">
                    {workspace.error
                      ? workspace.error
                      : workspace.tier === "free"
                        ? "free · $0"
                        : `${workspace.limits?.maxMachines ?? "—"} max`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="panel">
        <div className="panel-head">
          <h2>Machines by compute</h2>
          <span className="muted small">compute only · disk and egress live on the workspace</span>
        </div>
        <div className="table-scroll">
          <table className="health-table machine-health-table">
            <thead>
              <tr>
                <th>Machine</th>
                <th>State</th>
                <th title="Total running time this calendar month (UTC), across starts and pauses">Running (month)</th>
                <th>Compute</th>
                <th>Est / hour</th>
                <th>Signals</th>
                <th className="right">Detail</th>
              </tr>
            </thead>
            <tbody>
              {machines.map((machine) => {
                const key = `${machine.workspaceId}:${machine.id}`;
                const diag = machine.diagnostics;
                const running = machine.state === "running";
                return (
                  <Fragment key={key}>
                    <tr className={expanded === key ? "expanded-row" : ""}>
                      <td>
                        <div className="machine-name">{machine.name}</div>
                        <div className="machine-meta">
                          {machine.workspaceLabel} · {templateLabel(machine)}
                        </div>
                      </td>
                      <td><StatePill state={machine.state} /></td>
                      <td className="mono" title="Total running time this calendar month (UTC), across starts and pauses">
                        {duration(machine.usage?.runningSeconds)}
                      </td>
                      <td className="mono">
                        {money(machine.usage?.computeUSD ?? 0)}
                        {machine.usage?.free ? <span className="chip subtle">free</span> : null}
                      </td>
                      <td className="mono muted">
                        {machine.usage?.free ? "—" : money(machine.hourlyUSD ?? 0)}
                      </td>
                      <td>
                        {diag?.possibleIdle ? (
                          <span className="signal bad"><Icon name="alert" size={11} /> possible idle</span>
                        ) : running && diag?.hints?.length ? (
                          <span className="signal">{diag.hints[0]}</span>
                        ) : (
                          <span className="muted small">—</span>
                        )}
                      </td>
                      <td className="right">
                        <button
                          className="icon-btn"
                          onClick={() => setExpanded(expanded === key ? null : key)}
                          title="Show diagnostics"
                        >
                          <Icon name={expanded === key ? "chevron" : "chevron"} className={expanded === key ? "rotate-90" : ""} />
                        </button>
                      </td>
                    </tr>
                    {expanded === key ? (
                      <tr className="health-detail-row" key={`${key}:detail`}>
                        <td colSpan={7}>
                          {diag ? (
                            <div className="diag-grid">                              <div className="diag-item">
                                <span>CPU</span>
                                <strong>{diag.metricsAvailable === false ? "—" : `${diag.cpuPct.toFixed(1)}%`}</strong>
                                <Meter value={diag.metricsAvailable === false ? 0 : Math.min(100, diag.cpuPct)} tone={diag.cpuPct > 20 ? "var(--amber)" : "var(--accent)"} />
                              </div>
                              <div className="diag-item">
                                <span>Memory</span>
                                <strong>
                                  {diag.memTotal
                                    ? `${diag.memUsed == null ? "—" : bytes(diag.memUsed)} / ${bytes(diag.memTotal)}`
                                    : "—"}
                                </strong>
                                <Meter value={pct(diag.memUsed, diag.memTotal)} tone="var(--cyan)" />
                              </div>
                              <div className="diag-item">
                                <span>Disk /data</span>
                                <strong>
                                  {diag.diskTotal
                                    ? `${diag.diskUsed == null ? "—" : bytes(diag.diskUsed)} / ${bytes(diag.diskTotal)}`
                                    : "—"}
                                </strong>
                                <Meter value={pct(diag.diskUsed, diag.diskTotal)} tone="var(--violet)" />
                              </div>
                              <div className="diag-item">
                                <span>Max run</span>
                                <strong>
                                  {diag.maxRunMinutes > 0
                                    ? `${diag.maxRunMinutes}m · ${duration(Math.max(0, diag.maxRunMinutes * 60 - diag.runningSeconds))} left`
                                    : "unlimited"}
                                </strong>
                              </div>
                              <div className="diag-item wide">
                                <span>Last exec</span>
                                {diag.lastExec?.command ? (
                                  <code className="diag-command" title={diag.lastExec.command}>
                                    {diag.lastExec.command}
                                  </code>
                                ) : (
                                  <em className="muted">no exec recorded</em>
                                )}
                                {diag.lastExec?.startedAt ? (
                                  <span className="muted small">
                                    {dateTime(diag.lastExec.startedAt)} · exit {diag.lastExec.exitCode ?? "?"}
                                  </span>
                                ) : null}
                              </div>
                              <div className="diag-item wide">
                                <span>Public ports</span>
                                {diag.ports.length === 0 ? (
                                  <span className="muted">none</span>
                                ) : (
                                  <div className="chips">
                                    {diag.ports.map((port) => (
                                      <a className="chip" href={port.url} target="_blank" rel="noreferrer" key={port.port}>
                                        :{port.port} · {port.access}
                                      </a>
                                    ))}
                                  </div>
                                )}
                              </div>
                              <div className="diag-item wide">
                                <span>Signals</span>
                                <div className="chips">
                                  {diag.hints.length === 0 ? (
                                    <span className="muted small">no obvious signal</span>
                                  ) : (
                                    diag.hints.map((hint) => <span className="chip" key={hint}>{hint}</span>)
                                  )}
                                </div>
                              </div>
                              <div className="diag-note">
                                Diagnostics are signals, not proof: terminal/VNC use and agent leases can
                                keep a machine busy without exec or CPU load.
                              </div>
                            </div>
                          ) : (
                            <div className="row-empty">
                              No live diagnostics. The machine is not running, or metrics are unavailable.
                            </div>
                          )}
                        </td>
                      </tr>
                    ) : null}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      <section className="panel">
        <div className="panel-head">
          <h2>Possible idle leaks</h2>
          <span className="muted small">
            {leaks.length === 0 ? "none right now" : `${leaks.length} machine${leaks.length === 1 ? "" : "s"}`}
          </span>
        </div>
        {leaks.length === 0 ? (
          <div className="row-empty">
            No machine looks idle while running. Signals are based on CPU, last exec, and public ports.
          </div>
        ) : (
          <div className="leak-list">
            {leaks.map((machine) => (
              <div className="leak-row" key={`${machine.workspaceId}:${machine.id}`}>
                <div>
                  <strong>{machine.name}</strong>
                  <span className="muted small"> · {machine.workspaceLabel} · {duration(machine.usage?.runningSeconds)} running</span>
                  <div className="chips">
                    {machine.diagnostics?.hints.map((hint) => (
                      <span className="chip" key={hint}>{hint}</span>
                    ))}
                  </div>
                </div>
                <button className="btn ghost" onClick={() => onOpenMachine(machine)}>
                  Open machine <Icon name="arrow" />
                </button>
              </div>
            ))}
          </div>
        )}
      </section>

      <p className="fleet-foot">
        <span>
          <span className="status-dot tone-ok" /> pricing: {money(health?.pricing.vcpuHourUSD ?? 0.004)}/vCPU-h
          · {money(health?.pricing.memGiBHourUSD ?? 0.00225)}/GiB-h
        </span>
        <span className="muted">{health?.freeNote}</span>
      </p>
    </div>
  );
}

import { useEffect, useMemo, useState } from "react";
import { desktopAction, errorMessage, getDesktops } from "../api";
import { ago, sizeLabel, templateLabel } from "../format";
import { Icon } from "../icons";
import type { DesktopEntry, DesktopWall, Machine, Settings } from "../types";
import { StatePill } from "../components/Status";
import { VncView } from "../components/VncView";

const keyOf = (entry: DesktopEntry) => `${entry.workspaceId}:${entry.machine.id}`;

export function DesktopsView({
  settings,
  notify,
  onOpenMachine,
}: {
  settings: Settings | null;
  notify: (message: string, tone?: "ok" | "error" | "info") => void;
  onOpenMachine: (machine: Machine) => void;
}) {
  const [wall, setWall] = useState<DesktopWall | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState<string[]>([]);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [viewOnly, setViewOnly] = useState<Record<string, boolean>>({});
  const [workspace, setWorkspace] = useState("all");
  const [runningOnly, setRunningOnly] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const token = settings?.mcp.token;
  const maxLive = wall?.maxLive ?? 4;

  async function load(fresh = false) {
    if (!fresh) setLoading(true);
    try {
      const result = await getDesktops(fresh);
      setWall(result);
      setError(null);
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
  }, []);

  const workspaces = useMemo(() => {
    const map = new Map<string, string>();
    (wall?.desktops ?? []).forEach((entry) =>
      map.set(entry.workspaceId, entry.workspaceLabel ?? entry.workspaceId),
    );
    return [...map.entries()];
  }, [wall]);

  const visible = useMemo(() => {
    return (wall?.desktops ?? []).filter((entry) => {
      if (workspace !== "all" && entry.workspaceId !== workspace) return false;
      if (runningOnly && entry.machine.state !== "running") return false;
      return true;
    });
  }, [wall, workspace, runningOnly]);

  const liveCount = (wall?.desktops ?? []).filter((entry) => entry.vncAvailable).length;
  const activeCount = active.length;

  function toggle(entry: DesktopEntry) {
    const key = keyOf(entry);
    if (active.includes(key)) {
      setActive((current) => current.filter((item) => item !== key));
      return;
    }
    if (!entry.vncAvailable) {
      notify("Desktop is not running on this machine yet.", "error");
      return;
    }
    if (active.length >= maxLive) {
      notify(`Max ${maxLive} live previews. Disconnect one first.`, "error");
      return;
    }
    setActive((current) => [...current, key]);
  }

  function connectPreviews() {
    const slots = maxLive - active.length;
    if (slots <= 0) {
      notify(`Max ${maxLive} live previews already connected.`, "info");
      return;
    }
    const next = visible
      .filter((entry) => entry.vncAvailable && !active.includes(keyOf(entry)))
      .slice(0, slots)
      .map(keyOf);
    if (next.length === 0) {
      notify("No running desktop to preview.", "info");
      return;
    }
    setActive((current) => [...current, ...next]);
    notify(`Connected ${next.length} live preview${next.length === 1 ? "" : "s"}.`, "ok");
  }

  async function startDesktop(entry: DesktopEntry) {
    setBusy(keyOf(entry));
    try {
      await desktopAction(entry.workspaceId, entry.machine.id, "start", 1280, 800);
      notify(`Starting desktop on ${entry.machine.name}`, "info");
      window.setTimeout(() => void load(true), 2500);
    } catch (err) {
      notify(errorMessage(err), "error");
    } finally {
      setBusy(null);
    }
  }

  async function installDesktop(entry: DesktopEntry) {
    setBusy(keyOf(entry));
    try {
      await desktopAction(entry.workspaceId, entry.machine.id, "install");
      notify(`Installing desktop on ${entry.machine.name}…`, "info");
      window.setTimeout(() => void load(true), 3000);
    } catch (err) {
      notify(errorMessage(err), "error");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="page desktop-wall-page">
      <header className="page-head">
        <div>
          <div className="eyebrow">Observe</div>
          <h1>Desktops</h1>
          <p>
            {wall?.desktops.length ?? 0} machines · {liveCount} live desktop
            {liveCount === 1 ? "" : "s"} · {activeCount}/{maxLive} previews connected
            {wall ? ` · ${ago(wall.generatedAt)}` : ""}
          </p>
        </div>
        <div className="head-actions">
          <button className="btn ghost" onClick={() => void load(true)} disabled={loading}>
            <Icon name="refresh" className={loading ? "spin" : undefined} /> Refresh
          </button>
          <button className="btn" onClick={connectPreviews} disabled={liveCount === 0}>
            <Icon name="monitor" /> Connect previews
          </button>
          {activeCount > 0 ? (
            <button className="btn danger" onClick={() => setActive([])}>
              Disconnect all
            </button>
          ) : null}
        </div>
      </header>

      <div className="callout warn wide">
        <div className="callout-icon"><Icon name="alert" /></div>
        <div>
          <strong>Live VNC counts as activity.</strong>
          <p>
            A connected preview keeps that machine awake and counts toward InstaBox's limit of 8
            open terminals/desktops. Previews are off by default — connect only the ones you need,
            and disconnect when done.
          </p>
        </div>
      </div>

      {error ? <div className="term-inline-error">{error}</div> : null}

      <div className="wall-toolbar">
        <label className="check-row compact">
          <input
            type="checkbox"
            checked={runningOnly}
            onChange={(event) => setRunningOnly(event.target.checked)}
          />
          <span>Running only</span>
        </label>
        <div className="select-wrap">
          <Icon name="workspace" />
          <select value={workspace} onChange={(event) => setWorkspace(event.target.value)}>
            <option value="all">All workspaces</option>
            {workspaces.map(([id, label]) => (
              <option key={id} value={id}>
                {label}
              </option>
            ))}
          </select>
        </div>
        <span className="hint">
          Desktop status is read every 30s. A machine that is paused has no VNC.
        </span>
      </div>

      {loading && !wall ? (
        <div className="vnc-grid">
          {[0, 1, 2].map((index) => (
            <div className="skeleton card wall-skeleton" key={index} />
          ))}
        </div>
      ) : visible.length === 0 ? (
        <div className="table-empty card">
          <div className="empty-icon"><Icon name="monitor" size={22} /></div>
          <h3>{runningOnly ? "No running machines" : "No machines with a desktop"}</h3>
          <p>
            {runningOnly
              ? "Turn off “Running only” or start a machine."
              : "Create an agent-browser, android, or universal machine to get a desktop."}
          </p>
        </div>
      ) : (
        <div className="vnc-grid">
          {visible.map((entry) => {
            const key = keyOf(entry);
            const isActive = active.includes(key);
            const desktop = entry.desktop;
            const running = entry.machine.state === "running";
            const desktopRunning = Boolean(desktop?.running);
            const installing = Boolean(desktop?.installing);
            const installed = Boolean(desktop?.installed);
            const failed = Boolean(desktop?.failed);
            const ownViewOnly = viewOnly[key] ?? true;

            return (
              <article
                className={`vnc-card card${expanded === key ? " expanded" : ""}`}
                key={key}
              >
                <header className="vnc-card-head">
                  <div className="vnc-card-title">
                    <span className={`status-dot tone-${desktopRunning ? "ok" : running ? "warn" : "idle"}`} />
                    <div>
                      <h3>{entry.machine.name}</h3>
                      <span>{entry.workspaceLabel ?? entry.workspaceId}</span>
                    </div>
                  </div>
                  <StatePill state={entry.machine.state} />
                </header>

                <div className="vnc-card-body">
                  {isActive && token && entry.vncAvailable ? (
                    <>
                      <VncView
                        workspaceId={entry.workspaceId}
                        machineId={entry.machine.id}
                        token={token}
                        viewOnly={ownViewOnly}
                      />
                      <div className="vnc-card-overlay">
                        <button
                          className="vnc-overlay-btn"
                          title={ownViewOnly ? "Enable control" : "View only"}
                          onClick={() =>
                            setViewOnly((current) => ({ ...current, [key]: !ownViewOnly }))
                          }
                        >
                          <Icon name={ownViewOnly ? "lock" : "monitor"} size={12} />
                          {ownViewOnly ? "View only" : "Control"}
                        </button>
                        <button
                          className="vnc-overlay-btn"
                          title={expanded === key ? "Shrink" : "Expand"}
                          onClick={() => setExpanded(expanded === key ? null : key)}
                        >
                          <Icon name={expanded === key ? "x" : "external"} size={12} />
                          {expanded === key ? "Shrink" : "Expand"}
                        </button>
                        <button
                          className="vnc-overlay-btn danger"
                          title="Disconnect"
                          onClick={() => toggle(entry)}
                        >
                          <Icon name="stop" size={12} /> Off
                        </button>
                      </div>
                    </>
                  ) : (
                    <div className="vnc-placeholder">
                      <Icon name="monitor" size={26} />
                      <strong>
                        {entry.error
                          ? "Desktop status unavailable"
                          : !running
                            ? `Machine ${entry.machine.state}`
                            : installing
                              ? "Installing desktop…"
                              : failed
                                ? "Desktop install failed"
                                : desktopRunning
                                  ? "Live preview off"
                                  : installed
                                    ? "Desktop stopped"
                                    : "Desktop not installed"}
                      </strong>
                      <p>
                        {entry.error
                          ? entry.error.message
                          : !running
                            ? "Start or resume the machine to use its desktop."
                            : desktopRunning
                              ? "Connect to see and control this screen."
                              : installed
                                ? "Start the desktop to open its VNC server."
                                : "Install the desktop packages first."}
                      </p>
                      {desktopRunning && entry.vncAvailable ? (
                        <button className="btn primary" onClick={() => toggle(entry)}>
                          <Icon name="play" /> Connect
                        </button>
                      ) : null}
                      {running && !installed && !installing ? (
                        <button
                          className="btn"
                          onClick={() => void installDesktop(entry)}
                          disabled={busy === key}
                        >
                          {busy === key ? <span className="spinner" /> : <Icon name="download" />}
                          Install
                        </button>
                      ) : null}
                      {running && installed && !desktopRunning && !installing ? (
                        <button
                          className="btn"
                          onClick={() => void startDesktop(entry)}
                          disabled={busy === key}
                        >
                          {busy === key ? <span className="spinner" /> : <Icon name="play" />}
                          Start desktop
                        </button>
                      ) : null}
                      {!running ? (
                        <button className="btn ghost" onClick={() => onOpenMachine(entry.machine)}>
                          Open machine
                        </button>
                      ) : null}
                    </div>
                  )}
                </div>

                <footer className="vnc-card-foot">
                  <div className="vnc-card-meta">
                    <span className="chip subtle">{templateLabel(entry.machine)}</span>
                    <span className="muted small">{sizeLabel(entry.machine)}</span>
                    {desktop?.controller && desktop.controller !== "agent" ? (
                      <span className="muted small">· {desktop.controller}</span>
                    ) : null}
                  </div>
                  <div className="vnc-card-actions">
                    {entry.vncAvailable ? (
                      <button
                        className={`btn ${isActive ? "" : "ghost"} tiny-btn`}
                        onClick={() => toggle(entry)}
                        disabled={!isActive && active.length >= maxLive}
                      >
                        <Icon name={isActive ? "stop" : "play"} size={12} />
                        {isActive ? "Disconnect" : "Connect"}
                      </button>
                    ) : null}
                    <button
                      className="icon-btn"
                      title="Open machine"
                      onClick={() => onOpenMachine(entry.machine)}
                    >
                      <Icon name="arrow" />
                    </button>
                  </div>
                </footer>
              </article>
            );
          })}
        </div>
      )}

      <p className="wall-foot">
        <span className="status-dot tone-ok" /> previews stop when you leave this page
      </p>
    </div>
  );
}

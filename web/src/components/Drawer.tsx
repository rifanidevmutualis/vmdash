import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { ago, copyText, dateTime, diskLabel, idleLabel, isBusy, sizeLabel, templateLabel } from "../format";
import { Icon } from "../icons";
import type { Machine, Settings } from "../types";
import { MachineDot, StatePill, TierBadge } from "./Status";
import { TerminalTab } from "./machine/TerminalTab";
import { FilesTab } from "./machine/FilesTab";
import { DesktopTab } from "./machine/DesktopTab";
import { PortsTab } from "./machine/PortsTab";
import { SnapshotsTab } from "./machine/SnapshotsTab";
import { TelemetryTab } from "./machine/TelemetryTab";
import { SettingsTab } from "./machine/SettingsTab";

type DrawerTab =
  | "overview"
  | "terminal"
  | "files"
  | "desktop"
  | "ports"
  | "snapshots"
  | "logs"
  | "settings";

const TABS: { id: DrawerTab; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "terminal", label: "Terminal" },
  { id: "files", label: "Files" },
  { id: "desktop", label: "Desktop" },
  { id: "ports", label: "Ports" },
  { id: "snapshots", label: "Snapshots" },
  { id: "logs", label: "Logs" },
  { id: "settings", label: "Settings" },
];

export function MachineDrawer({
  machine,
  settings,
  theme,
  onClose,
  onAction,
  onDelete,
  onRefresh,
  notify,
}: {
  machine: Machine;
  settings: Settings | null;
  theme: "dark" | "light";
  onClose: () => void;
  onAction: (action: string) => void;
  onDelete: () => void;
  onRefresh: () => void;
  notify: (message: string, tone?: "ok" | "error" | "info") => void;
}) {
  const [tab, setTab] = useState<DrawerTab>("overview");

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = previous;
    };
  }, [onClose]);

  const busy = isBusy(machine.state);
  const paused = machine.state === "suspended";
  const running = machine.state === "running";
  const stopped = machine.state === "stopped";

  async function copy(value: string, label: string) {
    const ok = await copyText(value);
    notify(ok ? `${label} copied` : "Could not copy", ok ? "ok" : "error");
  }

  return createPortal(
    <div className="drawer-layer" role="presentation" onMouseDown={onClose}>
      <aside
        className="drawer wide"
        role="dialog"
        aria-modal="true"
        aria-label={`Machine ${machine.name}`}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="drawer-head">
          <div className="drawer-topline">
            <div className="drawer-title">
              <MachineDot index={machine.name.length} />
              <StatePill state={machine.state} />
              {machine.workspaceTier ? <TierBadge tier={machine.workspaceTier} /> : null}
            </div>
            <button className="icon-btn" onClick={onClose} aria-label="Close">
              <Icon name="x" />
            </button>
          </div>
          <h2>{machine.name}</h2>
          <div className="drawer-id">
            <code>{machine.id}</code>
            <button
              className="icon-btn tiny"
              onClick={() => void copy(machine.id, "Machine id")}
              aria-label="Copy machine id"
            >
              <Icon name="copy" size={12} />
            </button>
            <span className="dot-sep">·</span>
            <span className="muted small">{machine.workspaceLabel ?? machine.workspaceId}</span>
          </div>
        </header>

        <div className="drawer-actions">
          {running ? (
            <>
              <button className="btn" onClick={() => onAction("suspend")} disabled={busy}>
                <Icon name="pause" /> Pause
              </button>
              <button className="btn" onClick={() => onAction("stop")} disabled={busy}>
                <Icon name="stop" /> Stop
              </button>
            </>
          ) : null}
          {paused || stopped ? (
            <button
              className="btn primary"
              onClick={() => onAction(paused ? "resume" : "start")}
              disabled={busy}
            >
              <Icon name="play" /> {paused ? "Resume" : "Start"}
            </button>
          ) : null}
          {machine.state === "error" ? (
            <button className="btn primary" onClick={() => onAction("start")} disabled={busy}>
              <Icon name="play" /> Try start
            </button>
          ) : null}
          <button className="btn" onClick={() => setTab("terminal")} disabled={!running}>
            <Icon name="terminal" /> Terminal
          </button>
          <button className="btn" onClick={() => setTab("files")} disabled={!running}>
            <Icon name="folder" /> Files
          </button>
          <button className="btn" onClick={() => setTab("desktop")} disabled={!running}>
            <Icon name="monitor" /> Desktop
          </button>
        </div>

        <div className="tabs scroll">
          {TABS.map((item) => (
            <button
              key={item.id}
              className={tab === item.id ? "tab active" : "tab"}
              onClick={() => setTab(item.id)}
            >
              {item.label}
              {item.id !== "overview" && item.id !== "settings" && !running ? (
                <span className="tab-note">offline</span>
              ) : null}
            </button>
          ))}
        </div>

        <div className={`drawer-body ${tab === "terminal" || tab === "files" || tab === "desktop" ? "flush" : ""}`}>
          {tab === "overview" ? (
            <>
              <dl className="prop-grid">
                <div>
                  <dt>Workspace</dt>
                  <dd>{machine.workspaceLabel ?? machine.workspaceId}</dd>
                </div>
                <div>
                  <dt>Org</dt>
                  <dd>{machine.workspaceOrg ?? "—"}</dd>
                </div>
                <div>
                  <dt>Template</dt>
                  <dd>
                    <code>{templateLabel(machine)}</code>
                    {machine.template?.version ? (
                      <span className="muted small"> · {machine.template.version}</span>
                    ) : null}
                  </dd>
                </div>
                <div>
                  <dt>Size</dt>
                  <dd>{sizeLabel(machine)}</dd>
                </div>
                <div>
                  <dt>Disk /data</dt>
                  <dd>{diskLabel(machine)}</dd>
                </div>
                <div>
                  <dt>Idle pause</dt>
                  <dd>{idleLabel(machine.autoSuspendAfterSeconds)}</dd>
                </div>
                <div>
                  <dt>Created</dt>
                  <dd title={dateTime(machine.createdAt)}>{ago(machine.createdAt)}</dd>
                </div>
                <div>
                  <dt>Updated</dt>
                  <dd title={dateTime(machine.updatedAt)}>{ago(machine.updatedAt)}</dd>
                </div>
                <div>
                  <dt>Runtime ready</dt>
                  <dd>{machine.runtime?.ready ? "yes" : "no"}</dd>
                </div>
                <div>
                  <dt>OOM kills</dt>
                  <dd>{machine.oomKills ?? 0}</dd>
                </div>
                <div>
                  <dt>Guest user</dt>
                  <dd><code>{String(machine.guestUser ?? "—")}</code></dd>
                </div>
                <div>
                  <dt>Org ID</dt>
                  <dd><code className="small">{String(machine.orgId ?? "—")}</code></dd>
                </div>
              </dl>

              {machine.metadata && Object.keys(machine.metadata).length > 0 ? (
                <section className="drawer-section">
                  <h3>Metadata</h3>
                  <div className="chips">
                    {Object.entries(machine.metadata).map(([key, value]) => (
                      <span className="chip" key={key}>
                        <span className="chip-key">{key}</span>
                        {value}
                      </span>
                    ))}
                  </div>
                </section>
              ) : null}

              {machine.lastError ? (
                <section className="callout bad">
                  <div className="callout-icon"><Icon name="alert" /></div>
                  <div>
                    <strong>{machine.lastError.code}</strong>
                    <p>{machine.lastError.message}</p>
                  </div>
                </section>
              ) : null}

              <section className="drawer-section quick-links">
                <button className="btn ghost" onClick={() => setTab("settings")}>
                  <Icon name="settings" /> Configure, SSH, secrets
                </button>
                <button className="btn ghost" onClick={() => setTab("snapshots")}>
                  <Icon name="camera" /> Snapshots & fork
                </button>
                <button className="btn ghost" onClick={() => setTab("logs")}>
                  <Icon name="activity" /> Metrics & logs
                </button>
              </section>

              <section className="drawer-section danger">
                <div>
                  <h3>Delete machine</h3>
                  <p>Stops the machine for good. Snapshots are kept.</p>
                </div>
                <button className="btn danger" onClick={onDelete} disabled={busy}>
                  <Icon name="trash" /> Delete
                </button>
              </section>
            </>
          ) : null}

          {tab === "terminal" ? (
            <TerminalTab machine={machine} settings={settings} theme={theme} />
          ) : null}
          {tab === "files" ? <FilesTab machine={machine} notify={notify} /> : null}
          {tab === "desktop" ? (
            <DesktopTab machine={machine} settings={settings} notify={notify} />
          ) : null}
          {tab === "ports" ? <PortsTab machine={machine} notify={notify} /> : null}
          {tab === "snapshots" ? <SnapshotsTab machine={machine} notify={notify} /> : null}
          {tab === "logs" ? <TelemetryTab machine={machine} /> : null}
          {tab === "settings" ? (
            <SettingsTab machine={machine} notify={notify} onSaved={onRefresh} />
          ) : null}
        </div>
      </aside>
    </div>,
    document.body,
  );
}

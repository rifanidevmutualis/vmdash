import { useEffect, useRef, useState } from "react";
import {
  desktopAction,
  desktopStream,
  errorMessage,
  revokeDesktopStream,
} from "../../api";
import { dateTime } from "../../format";
import { Icon } from "../../icons";
import type { DesktopState, Machine, Settings } from "../../types";

export function DesktopTab({
  machine,
  settings,
  notify,
}: {
  machine: Machine;
  settings: Settings | null;
  notify: (message: string, tone?: "ok" | "error" | "info") => void;
}) {
  const [desktop, setDesktop] = useState<DesktopState | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [link, setLink] = useState<{ url: string; expiresAt: string } | null>(null);
  const [viewOnly, setViewOnly] = useState(false);
  const [vnc, setVnc] = useState(false);
  const vncHost = useRef<HTMLDivElement>(null);
  const running = machine.state === "running";
  const token = settings?.mcp.token;

  async function refresh() {
    if (!running) return;
    try {
      const state = await desktopAction(machine.workspaceId, machine.id, "status");
      setDesktop(state);
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  useEffect(() => {
    if (running) void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [machine.id, running]);

  useEffect(() => {
    if (!desktop?.installing) return;
    const timer = window.setInterval(() => void refresh(), 3000);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [desktop?.installing]);

  async function action(name: "start" | "install") {
    setLoading(true);
    setError(null);
    try {
      const state = await desktopAction(
        machine.workspaceId,
        machine.id,
        name,
        name === "start" ? 1280 : undefined,
        name === "start" ? 800 : undefined,
      );
      setDesktop(state);
      if (name === "install") {
        notify("Desktop install started", "info");
      } else if (state.hint) {
        setError(state.hint);
      } else {
        notify("Desktop start requested", "ok");
      }
      window.setTimeout(() => void refresh(), 2500);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }

  async function openLink() {
    setLoading(true);
    setError(null);
    try {
      const result = await desktopStream(machine.workspaceId, machine.id, viewOnly, 3600);
      setLink(result);
      notify("Desktop link created", "ok");
    } catch (err) {
      const message = errorMessage(err);
      setError(
        `${message}\n\nIf this key is a workspace key, desktop links are refused by InstaBox. Use “Connect VNC” instead — it goes through this server.`,
      );
    } finally {
      setLoading(false);
    }
  }

  async function revoke() {
    try {
      await revokeDesktopStream(machine.workspaceId, machine.id);
      setLink(null);
      notify("Desktop links revoked", "ok");
    } catch (err) {
      notify(errorMessage(err), "error");
    }
  }

  useEffect(() => {
    if (!vnc || !vncHost.current || !token) return;
    let client: import("@novnc/novnc").default | null = null;
    let disposed = false;

    (async () => {
      try {
        const { default: RFB } = await import("@novnc/novnc");
        if (disposed || !vncHost.current) return;
        const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
        const url = `${proto}//${window.location.host}/api/ws/vnc/${machine.workspaceId}/${machine.id}?token=${encodeURIComponent(token)}`;
        client = new RFB(vncHost.current, url, { credentials: {} });
        client.scaleViewport = true;
        client.resizeSession = false;
        client.viewOnly = false;
        client.showDotCursor = true;
        client.background = "#000";
        client.addEventListener("connect", () => setError(null));
        client.addEventListener("disconnect", (event: CustomEvent) => {
          const clean = event.detail?.clean;
          if (!clean) setError("VNC connection closed.");
        });
        client.addEventListener("securityfailure", () => {
          setError("VNC authentication failed.");
        });
      } catch (err) {
        setError(errorMessage(err));
      }
    })();

    return () => {
      disposed = true;
      client?.disconnect();
    };
  }, [vnc, machine.id, machine.workspaceId, token]);

  if (!running) {
    return (
      <div className="callout warn">
        <div className="callout-icon"><Icon name="alert" /></div>
        <div>
          <strong>Machine is {machine.state}</strong>
          <p>The desktop needs a running machine. Start or resume it first.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="desktop-panel">
      <div className="desktop-toolbar">
        <div className="desktop-state">
          <span className={`status-dot tone-${desktop?.running ? "ok" : desktop?.failed ? "bad" : "idle"}`} />
          <span>
            {desktop?.running
              ? "desktop running"
              : desktop?.installing
                ? "installing desktop…"
                : desktop?.failed
                  ? "install failed"
                  : desktop?.installed
                    ? "installed, not started"
                    : "not installed"}
          </span>
          {desktop?.kind ? <span className="chip subtle">{desktop.kind}</span> : null}
        </div>
        <div className="row-actions">
          <button className="icon-btn" title="Refresh status" onClick={() => void refresh()}>
            <Icon name="refresh" />
          </button>
          {!desktop?.installed && !desktop?.installing ? (
            <button className="btn" onClick={() => void action("install")} disabled={loading}>
              <Icon name="download" /> Install
            </button>
          ) : null}
          {desktop?.installed && !desktop?.running ? (
            <button className="btn primary" onClick={() => void action("start")} disabled={loading}>
              <Icon name="play" /> Start desktop
            </button>
          ) : null}
          <button className="btn" onClick={() => void openLink()} disabled={loading}>
            <Icon name="external" /> Share link
          </button>
          {link ? (
            <button className="btn danger" onClick={() => void revoke()}>
              Revoke links
            </button>
          ) : null}
        </div>
      </div>

      <div className="desktop-options">
        <label className="check-row">
          <input
            type="checkbox"
            checked={viewOnly}
            onChange={(event) => setViewOnly(event.target.checked)}
          />
          <span>Share as view-only</span>
        </label>
        <span className="hint">Links last 1 hour. View-only is enforced by InstaBox.</span>
      </div>

      {error ? <div className="term-inline-error pre">{error}</div> : null}

      {link ? (
        <div className="desktop-link">
          <div className="desktop-link-head">
            <div>
              <strong>Live desktop</strong>
              <span className="muted small"> expires {dateTime(link.expiresAt)}</span>
            </div>
            <a className="btn ghost" href={link.url} target="_blank" rel="noreferrer">
              Open in tab <Icon name="external" />
            </a>
          </div>
          <iframe
            className="desktop-frame"
            src={link.url}
            title="Machine desktop"
            allow="clipboard-read; clipboard-write"
          />
        </div>
      ) : null}

      <div className="vnc-section">
        <div className="vnc-head">
          <div>
            <strong>VNC through this server</strong>
            <p className="hint">
              Works with workspace keys. The API key stays on the server; the browser only gets a
              short-lived local WebSocket token.
            </p>
          </div>
          <button
            className={`btn ${vnc ? "danger" : ""}`}
            onClick={() => setVnc((value) => !value)}
            disabled={!desktop?.running}
            title={desktop?.running ? "" : "Start the desktop first"}
          >
            <Icon name="monitor" /> {vnc ? "Disconnect" : "Connect VNC"}
          </button>
        </div>
        {vnc ? <div className="vnc-frame" ref={vncHost} /> : null}
      </div>

      {desktop?.log ? (
        <details className="log-details">
          <summary>Desktop log</summary>
          <pre className="console-log">{desktop.log}</pre>
        </details>
      ) : null}
    </div>
  );
}

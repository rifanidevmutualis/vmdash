import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { Icon } from "../../icons";
import type { Machine, Settings } from "../../types";

export function TerminalTab({
  machine,
  settings,
  theme,
}: {
  machine: Machine;
  settings: Settings | null;
  theme: "dark" | "light";
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [generation, setGeneration] = useState(0);
  const [status, setStatus] = useState<"connecting" | "open" | "closed">("connecting");
  const [error, setError] = useState<string | null>(null);

  const running = machine.state === "running";
  const token = settings?.mcp.token;

  useEffect(() => {
    if (!running || !token || !hostRef.current) return;

    const term = new Terminal({
      fontFamily:
        'ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, monospace',
      fontSize: 12,
      lineHeight: 1.35,
      cursorBlink: true,
      allowProposedApi: true,
      scrollback: 5000,
      theme:
        theme === "light"
          ? {
              background: "#ffffff",
              foreground: "#18212b",
              cursor: "#3f7d00",
              selectionBackground: "rgba(63,125,0,0.18)",
              black: "#18212b",
              brightBlack: "#6b7a88",
              green: "#3f7d00",
              brightGreen: "#4d8f00",
              cyan: "#0f766e",
              brightCyan: "#0d9488",
              red: "#b91c1c",
              brightRed: "#dc2626",
              yellow: "#a16207",
            }
          : {
              background: "#090c10",
              foreground: "#c9d6e2",
              cursor: "#9ef01a",
              selectionBackground: "rgba(158,240,26,0.22)",
              black: "#0a0c0f",
              brightBlack: "#5c6a78",
              green: "#9ef01a",
              brightGreen: "#b3ff3d",
              cyan: "#5eead4",
              brightCyan: "#99f6e4",
              red: "#ff6b6b",
              brightRed: "#ff9b9b",
              yellow: "#fbbf24",
            },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(hostRef.current);
    fit.fit();

    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    const params = new URLSearchParams({
      token,
      cols: String(term.cols),
      rows: String(term.rows),
      session: "vmdash",
    });
    const socket = new WebSocket(
      `${proto}//${window.location.host}/api/ws/terminal/${machine.workspaceId}/${machine.id}?${params}`,
    );
    socket.binaryType = "arraybuffer";
    setStatus("connecting");
    setError(null);

    socket.onopen = () => {
      setStatus("open");
      socket.send(
        JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }),
      );
      fit.fit();
    };
    socket.onmessage = (event) => {
      if (typeof event.data === "string") {
        try {
          const message = JSON.parse(event.data) as {
            type?: string;
            message?: string;
            code?: number;
          };
          if (message.type === "error") {
            setError(message.message ?? "Terminal error");
          } else if (message.type === "exit") {
            setError(`Shell exited with code ${message.code ?? 0}`);
          } else if (message.type === "taken") {
            setError("This session was opened in another terminal.");
          }
        } catch {
          term.write(event.data);
        }
      } else {
        term.write(new Uint8Array(event.data as ArrayBuffer));
      }
    };
    socket.onclose = () => {
      setStatus("closed");
    };
    socket.onerror = () => {
      setStatus("closed");
      setError("WebSocket to the terminal failed.");
    };

    const data = term.onData((value) => {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(new TextEncoder().encode(value));
      }
    });
    const resize = term.onResize(({ cols, rows }) => {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: "resize", cols, rows }));
      }
    });

    const observer = new ResizeObserver(() => {
      try {
        fit.fit();
      } catch {
        /* container detached */
      }
    });
    observer.observe(hostRef.current);

    return () => {
      observer.disconnect();
      data.dispose();
      resize.dispose();
      socket.close();
      term.dispose();
    };
  }, [machine.id, machine.workspaceId, running, token, theme, generation]);

  if (!running) {
    return (
      <div className="callout warn">
        <div className="callout-icon"><Icon name="alert" /></div>
        <div>
          <strong>Machine is {machine.state}</strong>
          <p>Terminal needs a running machine. Start or resume it first.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="terminal-shell">
      <div className="terminal-bar">
        <span className={`term-status ${status}`}>
          <span className="status-dot" />
          {status === "open" ? "connected" : status === "connecting" ? "connecting…" : "disconnected"}
        </span>
        <span className="hint">PTY · persistent session · xterm-256color</span>
        <button className="btn ghost tiny-btn" onClick={() => setGeneration((v) => v + 1)}>
          <Icon name="refresh" size={12} /> Reconnect
        </button>
      </div>
      {error ? <div className="term-inline-error">{error}</div> : null}
      <div className="terminal-host" ref={hostRef} />
    </div>
  );
}

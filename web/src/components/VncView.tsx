import { useEffect, useRef, useState } from "react";
import type RFBType from "@novnc/novnc";

export function VncView({
  workspaceId,
  machineId,
  token,
  viewOnly = false,
  className,
}: {
  workspaceId: string;
  machineId: string;
  token: string;
  viewOnly?: boolean;
  className?: string;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const clientRef = useRef<RFBType | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    let disposed = false;
    let client: RFBType | null = null;

    (async () => {
      try {
        const { default: RFB } = await import("@novnc/novnc");
        if (disposed || !hostRef.current) return;

        const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
        const url = `${proto}//${window.location.host}/api/ws/vnc/${workspaceId}/${machineId}?token=${encodeURIComponent(token)}`;
        client = new RFB(hostRef.current, url, { credentials: {} });
        client.scaleViewport = true;
        client.resizeSession = false;
        client.viewOnly = viewOnly;
        client.showDotCursor = true;
        client.background = "#000";
        client.addEventListener("connect", () => {
          setConnected(true);
          setError(null);
        });
        client.addEventListener("disconnect", (event: CustomEvent) => {
          setConnected(false);
          if (!event.detail?.clean) setError("VNC stream closed.");
        });
        client.addEventListener("securityfailure", () => {
          setError("VNC authentication failed.");
        });
        clientRef.current = client;
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    })();

    return () => {
      disposed = true;
      clientRef.current = null;
      client?.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId, machineId, token]);

  useEffect(() => {
    if (clientRef.current) clientRef.current.viewOnly = viewOnly;
  }, [viewOnly]);

  return (
    <div className={`vnc-live ${className ?? ""}`}>
      <div className="vnc-canvas" ref={hostRef} />
      {!connected && !error ? (
        <div className="vnc-overlay-state">
          <span className="spinner" /> connecting…
        </div>
      ) : null}
      {error ? <div className="vnc-overlay-state error">{error}</div> : null}
    </div>
  );
}

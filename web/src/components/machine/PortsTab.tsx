import { useEffect, useState } from "react";
import {
  errorMessage,
  listPorts,
  publishPort,
  unpublishPort,
} from "../../api";
import { copyText, dateTime } from "../../format";
import { Icon } from "../../icons";
import type { Machine, PublicPort } from "../../types";

export function PortsTab({
  machine,
  notify,
}: {
  machine: Machine;
  notify: (message: string, tone?: "ok" | "error" | "info") => void;
}) {
  const [ports, setPorts] = useState<PublicPort[]>([]);
  const [enabled, setEnabled] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [port, setPort] = useState("3000");
  const [access, setAccess] = useState<"public" | "private">("private");
  const [name, setName] = useState("");

  const running = machine.state === "running";

  async function load() {
    if (!running) return;
    setLoading(true);
    setError(null);
    try {
      const result = await listPorts(machine.workspaceId, machine.id);
      setPorts(result.ports);
      setEnabled(result.enabled);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [machine.id, machine.state]);

  async function publish(event: React.FormEvent) {
    event.preventDefault();
    const value = Number(port);
    if (!Number.isInteger(value) || value < 1 || value > 65535) {
      notify("Port must be between 1 and 65535", "error");
      return;
    }
    try {
      const result = await publishPort(machine.workspaceId, machine.id, {
        port: value,
        access,
        name: name || undefined,
      });
      setPorts((current) => [...current.filter((item) => item.port !== value), result]);
      notify(`Port ${value} published`, "ok");
      setName("");
    } catch (err) {
      notify(errorMessage(err), "error");
    }
  }

  async function remove(value: number) {
    if (!window.confirm(`Remove the public URL for port ${value}?`)) return;
    try {
      await unpublishPort(machine.workspaceId, machine.id, value);
      setPorts((current) => current.filter((item) => item.port !== value));
      notify(`Port ${value} unpublished`, "ok");
    } catch (err) {
      notify(errorMessage(err), "error");
    }
  }

  async function copy(value: string) {
    const ok = await copyText(value);
    notify(ok ? "Copied" : "Could not copy", ok ? "ok" : "error");
  }

  if (!running) {
    return (
      <div className="callout warn">
        <div className="callout-icon"><Icon name="alert" /></div>
        <div>
          <strong>Machine is {machine.state}</strong>
          <p>Ports need a running machine and a server listening inside it.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="ports-panel">
      {!enabled ? (
        <div className="callout warn">
          <div className="callout-icon"><Icon name="alert" /></div>
          <div>
            <strong>Public ports are not configured for this server</strong>
            <p>InstaBox returned enabled=false. The form still works if the server enables them.</p>
          </div>
        </div>
      ) : null}

      <form className="port-form" onSubmit={publish}>
        <label className="field">
          <span className="field-label">Port inside the machine</span>
          <input
            value={port}
            onChange={(event) => setPort(event.target.value)}
            inputMode="numeric"
            placeholder="3000"
          />
        </label>
        <label className="field">
          <span className="field-label">Access</span>
          <select value={access} onChange={(event) => setAccess(event.target.value as "public" | "private")}>
            <option value="private">private (token URL)</option>
            <option value="public">public</option>
          </select>
        </label>
        <label className="field grow">
          <span className="field-label">Label <span className="muted">(optional)</span></span>
          <input value={name} onChange={(event) => setName(event.target.value)} placeholder="web" />
        </label>
        <button className="btn primary" type="submit">
          <Icon name="globe" /> Publish
        </button>
      </form>

      {error ? <div className="term-inline-error">{error}</div> : null}

      {loading && ports.length === 0 ? <div className="row-empty">Loading ports…</div> : null}

      {ports.length === 0 && !loading ? (
        <div className="row-empty">
          No public ports. Start a server inside the machine, then publish its port.
        </div>
      ) : (
        <div className="port-list">
          {ports.map((item) => (
            <div className="port-row" key={item.id}>
              <div className="port-main">
                <span className="port-number mono">:{item.port}</span>
                <span className="port-name">{item.name || "—"}</span>
                <span className={`chip subtle`}>{item.access}</span>
                {item.protocol && item.protocol !== "http" ? (
                  <span className="chip subtle">{item.protocol}</span>
                ) : null}
              </div>
              <div className="port-url">
                {item.url ? (
                  <>
                    <code title={item.url}>{item.url}</code>
                    <button className="icon-btn tiny" onClick={() => copy(item.tokenUrl ?? item.url)}>
                      <Icon name="copy" size={12} />
                    </button>
                  </>
                ) : (
                  <span className="muted small">no public URL</span>
                )}
              </div>
              <span className="muted small" title={dateTime(item.createdAt)}>
                {item.access === "private" ? "token required" : "anyone with link"}
              </span>
              <div className="row-actions">
                {item.url ? (
                  <a className="icon-btn" href={item.tokenUrl ?? item.url} target="_blank" rel="noreferrer" title="Open">
                    <Icon name="external" />
                  </a>
                ) : null}
                <button className="icon-btn danger-hover" onClick={() => void remove(item.port)} title="Unpublish">
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

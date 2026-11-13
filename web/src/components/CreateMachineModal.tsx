import { useState } from "react";
import { createMachine, errorMessage } from "../api";
import { Icon } from "../icons";
import type { Workspace } from "../types";
import { Modal } from "./Modal";

const TEMPLATES = [
  { id: "agent-browser", label: "agent-browser", desc: "Claude Code, Codex, OpenCode, Docker, desktop" },
  { id: "universal", label: "universal", desc: "Same tools, desktop installed on request" },
  { id: "t3", label: "t3", desc: "T3 Code server on port 3774" },
  { id: "herdr", label: "herdr", desc: "Lightweight agent box with herdr" },
  { id: "orca", label: "orca", desc: "Orca runtime, no Docker toolchain" },
  { id: "android", label: "android", desc: "Android 14, adb and desktop" },
  { id: "omarchy", label: "omarchy", desc: "Arch + Hyprland desktop" },
  { id: "ci", label: "ci", desc: "GitHub Actions runner image" },
];

const SIZES = [
  { vcpus: 2, memMiB: 4096, label: "2 vCPU · 4 GiB" },
  { vcpus: 4, memMiB: 8192, label: "4 vCPU · 8 GiB (default)" },
  { vcpus: 8, memMiB: 16384, label: "8 vCPU · 16 GiB" },
  { vcpus: 16, memMiB: 32768, label: "16 vCPU · 32 GiB" },
];

const IDLE = [
  { seconds: 300, label: "5 minutes" },
  { seconds: 900, label: "15 minutes" },
  { seconds: 1800, label: "30 minutes (default)" },
  { seconds: 0, label: "Never (where allowed)" },
];

export function CreateMachineModal({
  workspaces,
  onClose,
  onCreated,
  notify,
}: {
  workspaces: Workspace[];
  onClose: () => void;
  onCreated: () => void;
  notify: (message: string, tone?: "ok" | "error" | "info") => void;
}) {
  const [workspaceId, setWorkspaceId] = useState(workspaces[0]?.id ?? "");
  const [name, setName] = useState("");
  const [template, setTemplate] = useState("agent-browser");
  const [size, setSize] = useState(1);
  const [idle, setIdle] = useState(2);
  const [envRows, setEnvRows] = useState<{ key: string; value: string }[]>([]);
  const [metadata, setMetadata] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const workspace = workspaces.find((item) => item.id === workspaceId);
  const free = workspace?.tier === "free";
  const sizeIndex = free ? 1 : size;
  const idleIndex = free ? 2 : idle;

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!workspaceId || busy) return;
    setBusy(true);
    setError(null);
    try {
      const chosen = SIZES[sizeIndex];
      const env = Object.fromEntries(
        envRows
          .map((row) => [row.key.trim(), row.value] as const)
          .filter(([key]) => key.length > 0),
      );
      let parsedMetadata: Record<string, string> | undefined;
      if (metadata.trim()) {
        const value = JSON.parse(metadata);
        if (typeof value !== "object" || Array.isArray(value)) {
          throw new Error("Metadata must be a JSON object");
        }
        parsedMetadata = Object.fromEntries(
          Object.entries(value).map(([key, item]) => [key, String(item)]),
        );
      }

      await createMachine({
        workspaceId,
        name: name.trim() || undefined,
        templateId: template,
        vcpus: chosen.vcpus,
        memMiB: chosen.memMiB,
        autoSuspendAfterSeconds: IDLE[idleIndex].seconds,
        env: Object.keys(env).length > 0 ? env : undefined,
        metadata: parsedMetadata,
      });
      notify("Create queued. The machine appears once the operation starts.", "ok");
      onCreated();
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title="New machine"
      subtitle="Creates a fresh InstaBox microVM from a template."
      width={580}
      onClose={onClose}
      footer={
        <>
          <button className="btn ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="btn primary" onClick={submit} disabled={busy || !workspaceId}>
            {busy ? <span className="spinner" /> : <Icon name="plus" />}
            {busy ? "Creating…" : "Create machine"}
          </button>
        </>
      }
    >
      <form className="form" onSubmit={submit}>
        <label className="field">
          <span className="field-label">Workspace</span>
          <select
            value={workspaceId}
            onChange={(event) => {
              const next = workspaces.find((item) => item.id === event.target.value);
              setWorkspaceId(event.target.value);
              if (next?.tier === "free") {
                if (!["agent-browser", "android", "omarchy", "ci"].includes(template)) {
                  setTemplate("agent-browser");
                }
                setSize(1);
                setIdle(2);
              }
            }}
          >
            {workspaces.map((item) => (
              <option key={item.id} value={item.id}>
                {item.label} {item.tier ? `· ${item.tier}` : ""}
              </option>
            ))}
          </select>
        </label>

        <div className="form-row">
          <label className="field">
            <span className="field-label">Name <span className="muted">(optional)</span></span>
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="agent-01"
              spellCheck={false}
              pattern="[a-z0-9][a-z0-9-]{0,62}"
              title="Lowercase letters, digits and dashes"
            />
            <span className="field-hint">Lowercase letters, digits and dashes.</span>
          </label>
          <label className="field">
            <span className="field-label">Size</span>
            <select value={sizeIndex} onChange={(event) => setSize(Number(event.target.value))} disabled={free}>
              {SIZES.map((item, index) => (
                <option key={item.label} value={index} disabled={free && index !== 1}>
                  {item.label}
                </option>
              ))}
            </select>
            {free ? <span className="field-hint">Free plan is fixed at 4 vCPU / 8 GiB.</span> : null}
          </label>
        </div>

        <label className="field">
          <span className="field-label">Template</span>
          <select value={template} onChange={(event) => setTemplate(event.target.value)}>
            {TEMPLATES.map((item) => (
              <option key={item.id} value={item.id} disabled={free && !["agent-browser", "android", "omarchy", "ci"].includes(item.id)}>
                {item.label} — {item.desc}
              </option>
            ))}
          </select>
          {free ? (
            <span className="field-hint">
              Free plan can only create agent-browser, android, omarchy or ci, and holds 1 machine in
              total.
            </span>
          ) : null}
        </label>

        <label className="field">
          <span className="field-label">Pause when idle</span>
          <select value={idleIndex} onChange={(event) => setIdle(Number(event.target.value))} disabled={free}>
            {IDLE.map((item, index) => (
              <option key={item.label} value={index} disabled={free && index !== 2}>
                {item.label}
              </option>
            ))}
          </select>
          <span className="field-hint">
            Idle pause keeps memory, so the next use resumes instantly.
            {free ? " Free plan is fixed at 30 minutes." : ""}
          </span>
        </label>

        {error ? (
          <div className="callout bad">
            <div className="callout-icon"><Icon name="alert" /></div>
            <div><strong>Create failed</strong><p>{error}</p></div>
          </div>
        ) : null}

        <div className="form-section">
          <div className="section-head">
            <h3>Environment variables <span className="muted">(create-time only)</span></h3>
            <button
              type="button"
              className="btn ghost"
              onClick={() => setEnvRows((rows) => [...rows, { key: "", value: "" }])}
            >
              <Icon name="plus" /> Add
            </button>
          </div>
          {envRows.length === 0 ? (
            <p className="hint">Optional. Exported in every login shell, including exec and SSH.</p>
          ) : (
            <div className="env-editor">
              {envRows.map((row, index) => (
                <div className="env-row" key={index}>
                  <input
                    value={row.key}
                    onChange={(event) =>
                      setEnvRows((rows) =>
                        rows.map((item, i) => (i === index ? { ...item, key: event.target.value } : item)),
                      )
                    }
                    placeholder="KEY"
                    spellCheck={false}
                  />
                  <input
                    value={row.value}
                    onChange={(event) =>
                      setEnvRows((rows) =>
                        rows.map((item, i) => (i === index ? { ...item, value: event.target.value } : item)),
                      )
                    }
                    placeholder="value"
                    spellCheck={false}
                  />
                  <button
                    type="button"
                    className="icon-btn danger-hover"
                    onClick={() => setEnvRows((rows) => rows.filter((_, i) => i !== index))}
                  >
                    <Icon name="x" size={12} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        <label className="field">
          <span className="field-label">Metadata <span className="muted">(JSON object, optional)</span></span>
          <textarea
            className="metadata-editor"
            value={metadata}
            onChange={(event) => setMetadata(event.target.value)}
            placeholder='{"agent":"scraper","team":"ops"}'
            spellCheck={false}
            rows={3}
          />
        </label>
      </form>
    </Modal>
  );
}

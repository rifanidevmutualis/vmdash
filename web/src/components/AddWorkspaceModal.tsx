import { useState } from "react";
import { addWorkspace, errorMessage } from "../api";
import { Icon } from "../icons";
import { Modal } from "./Modal";

export function AddWorkspaceModal({
  onClose,
  onAdded,
  notify,
}: {
  onClose: () => void;
  onAdded: () => void;
  notify: (message: string, tone?: "ok" | "error" | "info") => void;
}) {
  const [key, setKey] = useState("");
  const [label, setLabel] = useState("");
  const [reveal, setReveal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!key.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      await addWorkspace(key.trim(), label.trim() || undefined);
      notify("Workspace connected. Pulling its machines…", "ok");
      onAdded();
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title="Connect a workspace"
      subtitle="One API key reaches every machine in exactly one workspace."
      onClose={onClose}
      footer={
        <>
          <button className="btn ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="btn primary" onClick={submit} disabled={busy || !key.trim()}>
            {busy ? <span className="spinner" /> : <Icon name="key" />}
            {busy ? "Validating…" : "Connect"}
          </button>
        </>
      }
    >
      <form className="form" onSubmit={submit}>
        <label className="field">
          <span className="field-label">API key</span>
          <div className="input-wrap">
            <input
              type={reveal ? "text" : "password"}
              value={key}
              onChange={(event) => setKey(event.target.value)}
              placeholder="ibk_…"
              autoFocus
              spellCheck={false}
              autoComplete="off"
            />
            <button
              type="button"
              className="input-action"
              onClick={() => setReveal((value) => !value)}
            >
              {reveal ? "hide" : "show"}
            </button>
          </div>
          <span className="field-hint">
            Create one at{" "}
            <a href="https://dashboard.instabox.sh/dashboard/api-keys" target="_blank" rel="noreferrer">
              InstaBox → API keys
            </a>
            . Scopes: <code>machines:read</code>, <code>machines:write</code>,{" "}
            <code>machines:delete</code>, <code>images:read</code>, <code>images:write</code>.
            Writing org Secrets needs a workspace key with <code>workspace:admin</code>.
          </span>
        </label>

        <label className="field">
          <span className="field-label">Label <span className="muted">(optional)</span></span>
          <input
            type="text"
            value={label}
            onChange={(event) => setLabel(event.target.value)}
            placeholder="e.g. agents-prod"
          />
        </label>

        <div className="callout info">
          <div className="callout-icon"><Icon name="key" /></div>
          <div>
            <strong>The key is per workspace, not per VM.</strong>
            <p>
              It sees all machines in that workspace. The key is encrypted with a local master key
              and never leaves this machine — agents get MCP tokens, not your InstaBox key.
            </p>
          </div>
        </div>

        {error ? (
          <div className="callout bad">
            <div className="callout-icon"><Icon name="alert" /></div>
            <div><strong>Could not connect</strong><p>{error}</p></div>
          </div>
        ) : null}
      </form>
    </Modal>
  );
}

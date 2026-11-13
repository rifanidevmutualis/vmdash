import { useEffect, useState } from "react";
import {
  createSshToken,
  errorMessage,
  machineSecrets,
  orgSecrets,
  patchMachine,
  patchMachineSecrets,
  refreshMachineSecrets,
  revokeAllSshTokens,
  revokeSshToken,
  sshTokens,
} from "../../api";
import { copyText, dateTime } from "../../format";
import { Icon } from "../../icons";
import type { Machine, MachineSecrets, SecretMeta, SshToken } from "../../types";

export function SettingsTab({
  machine,
  notify,
  onSaved,
}: {
  machine: Machine;
  notify: (message: string, tone?: "ok" | "error" | "info") => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(machine.name);
  const [vcpus, setVcpus] = useState(String(machine.spec?.vcpus ?? 4));
  const [memMiB, setMemMiB] = useState(String(machine.spec?.memMiB ?? 8192));
  const [diskGiB, setDiskGiB] = useState(String(machine.spec?.persistentDiskGiB ?? 20));
  const [idle, setIdle] = useState(String((machine.autoSuspendAfterSeconds ?? 1800) / 60));
  const [maxRun, setMaxRun] = useState(String(machine.maxRunMinutes ?? -1));
  const [metadata, setMetadata] = useState(
    JSON.stringify(machine.metadata ?? {}, null, 2),
  );
  const [saving, setSaving] = useState(false);

  const [tokens, setTokens] = useState<SshToken[]>([]);
  const [tokenName, setTokenName] = useState("vmdash");
  const [issued, setIssued] = useState<SshToken | null>(null);
  const [sshBusy, setSshBusy] = useState(false);

  const [machineSecretState, setMachineSecretState] = useState<MachineSecrets | null>(null);
  const [available, setAvailable] = useState<SecretMeta[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [secretBusy, setSecretBusy] = useState(false);

  const free = Boolean(machine.free);

  async function loadAux() {
    const [tokenResult, secretState, orgResult] = await Promise.all([
      sshTokens(machine.workspaceId, machine.id).catch(() => null),
      machineSecrets(machine.workspaceId, machine.id).catch(() => null),
      orgSecrets(machine.workspaceId).catch(() => null),
    ]);
    if (tokenResult) setTokens((tokenResult.tokens ?? []).filter((token) => !token.revokedAt));
    if (secretState) {
      setMachineSecretState(secretState);
      setSelected(
        secretState.secrets === "all"
          ? (secretState.items ?? []).map((item) => item.name)
          : (secretState.secrets ?? []),
      );
    }
    if (orgResult) setAvailable(orgResult.items ?? []);
  }

  useEffect(() => {
    void loadAux();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [machine.id]);

  async function save() {
    let parsedMetadata: Record<string, string>;
    try {
      const value = metadata.trim() ? JSON.parse(metadata) : {};
      if (typeof value !== "object" || Array.isArray(value)) throw new Error("must be an object");
      parsedMetadata = Object.fromEntries(
        Object.entries(value).map(([key, item]) => [key, String(item)]),
      );
    } catch (err) {
      notify(`Metadata must be a JSON object: ${errorMessage(err)}`, "error");
      return;
    }

    const idleSeconds = Math.round(Number(idle) * 60);
    if (!Number.isFinite(idleSeconds) || idleSeconds < 0) {
      notify("Idle pause must be minutes", "error");
      return;
    }

    setSaving(true);
    try {
      const patch: Parameters<typeof patchMachine>[2] = {};
      if (name.trim() && name.trim() !== machine.name) patch.name = name.trim();
      if (!free && Number(vcpus) !== machine.spec?.vcpus) patch.vcpus = Number(vcpus);
      if (!free && Number(memMiB) !== machine.spec?.memMiB) patch.memMiB = Number(memMiB);
      if (!free && Number(diskGiB) !== machine.spec?.persistentDiskGiB) {
        patch.persistentDiskGiB = Number(diskGiB);
      }
      if (!free && idleSeconds !== (machine.autoSuspendAfterSeconds ?? 1800)) {
        patch.autoSuspendAfterSeconds = idleSeconds;
      }
      if (!free && Number(maxRun) !== machine.maxRunMinutes) {
        patch.maxRunMinutes = Number(maxRun);
      }
      if (JSON.stringify(parsedMetadata) !== JSON.stringify(machine.metadata ?? {})) {
        patch.metadata = parsedMetadata;
      }

      if (Object.keys(patch).length === 0) {
        notify("Nothing changed", "info");
        return;
      }

      await patchMachine(machine.workspaceId, machine.id, patch);
      notify("Machine settings updated", "ok");
      onSaved();
    } catch (err) {
      notify(errorMessage(err), "error");
    } finally {
      setSaving(false);
    }
  }

  async function issueToken() {
    setSshBusy(true);
    try {
      const token = await createSshToken(machine.workspaceId, machine.id, tokenName || undefined, 3600);
      setIssued(token);
      notify("SSH token issued (valid 1 hour)", "ok");
      void loadAux();
    } catch (err) {
      notify(errorMessage(err), "error");
    } finally {
      setSshBusy(false);
    }
  }

  async function revokeOne(id: string) {
    try {
      await revokeSshToken(machine.workspaceId, machine.id, id);
      notify("SSH token revoked", "ok");
      void loadAux();
    } catch (err) {
      notify(errorMessage(err), "error");
    }
  }

  async function revokeAll() {
    if (!window.confirm("Revoke every SSH token for this machine and close its SSH sessions?")) return;
    try {
      const result = await revokeAllSshTokens(machine.workspaceId, machine.id);
      setIssued(null);
      notify(`Revoked ${result.revoked ?? 0} token(s)`, "ok");
      void loadAux();
    } catch (err) {
      notify(errorMessage(err), "error");
    }
  }

  async function saveSecrets() {
    setSecretBusy(true);
    try {
      const result = await patchMachineSecrets(machine.workspaceId, machine.id, {
        secrets: selected,
      });
      setMachineSecretState(result);
      notify("Secret selection saved", "ok");
    } catch (err) {
      notify(errorMessage(err), "error");
    } finally {
      setSecretBusy(false);
    }
  }

  async function refreshSecrets() {
    setSecretBusy(true);
    try {
      const result = await refreshMachineSecrets(machine.workspaceId, machine.id);
      setMachineSecretState(result);
      notify("Delivery refresh requested", "ok");
    } catch (err) {
      notify(errorMessage(err), "error");
    } finally {
      setSecretBusy(false);
    }
  }

  return (
    <div className="settings-panel">
      <section className="settings-section">
        <div className="section-head">
          <h3>Identity & size</h3>
          {free ? <span className="chip subtle">free plan · size fixed</span> : null}
        </div>
        <div className="settings-grid">
          <label className="field">
            <span className="field-label">Name</span>
            <input value={name} onChange={(event) => setName(event.target.value)} spellCheck={false} />
          </label>
          <label className="field">
            <span className="field-label">vCPU</span>
            <input
              value={vcpus}
              onChange={(event) => setVcpus(event.target.value)}
              inputMode="numeric"
              disabled={free}
            />
          </label>
          <label className="field">
            <span className="field-label">Memory (MiB)</span>
            <input
              value={memMiB}
              onChange={(event) => setMemMiB(event.target.value)}
              inputMode="numeric"
              disabled={free}
            />
          </label>
          <label className="field">
            <span className="field-label">Disk /data (GiB)</span>
            <input
              value={diskGiB}
              onChange={(event) => setDiskGiB(event.target.value)}
              inputMode="numeric"
              disabled={free}
            />
          </label>
          <label className="field">
            <span className="field-label">Idle pause (minutes, 0 = off)</span>
            <input
              value={idle}
              onChange={(event) => setIdle(event.target.value)}
              inputMode="numeric"
              disabled={free}
            />
          </label>
          <label className="field">
            <span className="field-label">Max run (minutes, -1 = unlimited)</span>
            <input
              value={maxRun}
              onChange={(event) => setMaxRun(event.target.value)}
              inputMode="numeric"
              disabled={free}
            />
          </label>
        </div>
        <p className="hint">
          InstaBox applies vCPU/memory/disk changes to stopped machines. If the API asks for a stop,
          stop the machine and save again. A running disk can grow live.
        </p>

        <label className="field">
          <span className="field-label">Metadata (JSON object)</span>
          <textarea
            className="metadata-editor"
            value={metadata}
            onChange={(event) => setMetadata(event.target.value)}
            spellCheck={false}
            rows={5}
          />
        </label>
        <div className="settings-actions">
          <button className="btn primary" onClick={() => void save()} disabled={saving}>
            {saving ? <span className="spinner" /> : <Icon name="save" />} Save changes
          </button>
        </div>
      </section>

      <section className="settings-section">
        <div className="section-head">
          <h3>SSH access</h3>
          <span className="muted small">tokens are secrets; revoke when done</span>
        </div>
        <div className="inline-form">
          <input
            value={tokenName}
            onChange={(event) => setTokenName(event.target.value)}
            placeholder="token name"
          />
          <button className="btn" onClick={() => void issueToken()} disabled={sshBusy}>
            {sshBusy ? <span className="spinner" /> : <Icon name="key" />} Issue 1h token
          </button>
          <button className="btn ghost" onClick={() => void revokeAll()}>
            Revoke all
          </button>
        </div>

        {issued ? (
          <div className="ssh-token-box">
            <div className="ssh-token-head">
              <strong>{issued.name || "ssh token"}</strong>
              <button
                className="icon-btn tiny"
                onClick={async () => {
                  const ok = await copyText(issued.command);
                  notify(ok ? "SSH command copied" : "Could not copy", ok ? "ok" : "error");
                }}
              >
                <Icon name="copy" size={12} />
              </button>
            </div>
            <pre className="code-inline">{issued.command}</pre>
            <span className="hint">
              expires {dateTime(issued.expiresAt)} · token {issued.token.slice(0, 12)}…
            </span>
          </div>
        ) : null}

        {tokens.length > 0 ? (
          <div className="token-list">
            {tokens.map((token) => (
              <div className="token-row" key={token.id}>
                <span className="mono small">{token.name || token.id}</span>
                <span className="muted small">{token.expiresAt ? dateTime(token.expiresAt) : "no expiry"}</span>
                <button
                  className="icon-btn danger-hover"
                  onClick={() => void revokeOne(token.id)}
                  title="Revoke"
                >
                  <Icon name="trash" size={13} />
                </button>
              </div>
            ))}
          </div>
        ) : (
          <div className="row-empty small-empty">No active SSH tokens.</div>
        )}
      </section>

      <section className="settings-section">
        <div className="section-head">
          <h3>Org Secrets</h3>
          <div className="row-actions">
            <button className="btn ghost" onClick={() => void refreshSecrets()} disabled={secretBusy}>
              <Icon name="refresh" /> Refresh delivery
            </button>
            <button className="btn primary" onClick={() => void saveSecrets()} disabled={secretBusy}>
              Save selection
            </button>
          </div>
        </div>
        <p className="hint">
          Proxy Secrets inject placeholders in the machine; the real value never lands there. Env
          Secrets are delivered as environment variables. Manage values in the workspace panel.
        </p>

        {machineSecretState?.proxy ? (
          <div className="secret-status">
            <span className={`status-dot tone-${machineSecretState.proxy.state === "applied" ? "ok" : "warn"}`} />
            proxy {machineSecretState.proxy.state} · rev {machineSecretState.proxy.appliedRevision}/
            {machineSecretState.proxy.revision}
          </div>
        ) : null}

        {available.length === 0 ? (
          <div className="row-empty small-empty">No org Secrets. Add them in Workspaces → Secrets.</div>
        ) : (
          <div className="secret-select-list">
            {available.map((secret) => (
              <label className="check-row" key={secret.name}>
                <input
                  type="checkbox"
                  checked={selected.includes(secret.name)}
                  onChange={(event) => {
                    setSelected((current) =>
                      event.target.checked
                        ? [...new Set([...current, secret.name])]
                        : current.filter((name) => name !== secret.name),
                    );
                  }}
                />
                <code>{secret.name}</code>
                <span className="chip subtle">{secret.delivery}</span>
                {secret.hosts?.length ? (
                  <span className="muted small">{secret.hosts.join(", ")}</span>
                ) : null}
              </label>
            ))}
          </div>
        )}

        {machine.envNames?.length ? (
          <div className="env-names">
            <span className="field-label">Create-time env vars</span>
            <div className="chips">
              {machine.envNames.map((name) => (
                <span className="chip" key={name}>{name}</span>
              ))}
            </div>
            <span className="hint">Env vars are fixed at create time.</span>
          </div>
        ) : null}
      </section>
    </div>
  );
}

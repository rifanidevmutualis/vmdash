import type { Fleet, Workspace } from "../types";
import { ago, dateTime, money } from "../format";
import { Icon } from "../icons";
import { TierBadge } from "../components/Status";

export function WorkspacesView({
  fleet,
  onAdd,
  onSync,
  onRemove,
  onTools,
  busyId,
}: {
  fleet: Fleet | null;
  onAdd: () => void;
  onSync: (workspace: Workspace) => void;
  onRemove: (workspace: Workspace) => void;
  onTools: (workspace: Workspace) => void;
  busyId?: string | null;
}) {
  const workspaces = fleet?.workspaces ?? [];

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <div className="eyebrow">Credentials</div>
          <h1>Workspaces</h1>
          <p>Each API key reaches one workspace and every machine inside it.</p>
        </div>
        <div className="head-actions">
          <button className="btn primary" onClick={onAdd}>
            <Icon name="plus" /> Add workspace
          </button>
        </div>
      </header>

      <div className="callout info wide">
        <div className="callout-icon"><Icon name="key" /></div>
        <div>
          <strong>One key, many VMs.</strong>
          <p>
            InstaBox keys are scoped to a workspace, not to a machine. The dashboard fans one key
            out to the whole fleet. Keys are sealed with ChaCha20-Poly1305 under a local master key
            at <code>~/Library/Application Support/vmdash/master.key</code> and are never exposed to
            the browser or to MCP clients.
          </p>
        </div>
      </div>

      {workspaces.length === 0 ? (
        <div className="table-empty card">
          <div className="empty-icon"><Icon name="workspace" size={22} /></div>
          <h3>No workspace connected</h3>
          <p>Paste an InstaBox API key to load its machines.</p>
          <button className="btn primary" onClick={onAdd}>
            <Icon name="key" /> Connect workspace
          </button>
        </div>
      ) : (
        <div className="workspace-grid">
          {workspaces.map((workspace) => {
            const cost = workspace.usage?.cost?.costUSD ?? 0;
            const max = workspace.usage?.limits?.maxMachines;
            const unlimited = workspace.usage?.limits?.unlimited?.includes("maxMachines");
            const busy = busyId === workspace.id;
            return (
              <article className="workspace-card card" key={workspace.id}>
                <header>
                  <div className="ws-title">
                    <span className="ws-mark"><Icon name="workspace" /></span>
                    <div>
                      <h3>{workspace.label}</h3>
                      <div className="ws-org">
                        {workspace.orgName ?? "—"}
                        <TierBadge tier={workspace.tier} />
                      </div>
                    </div>
                  </div>
                  <div className="ws-key" title="API key disimpan terenkripsi di mesin ini">
                    <Icon name="lock" size={12} />
                    <span>encrypted</span>
                  </div>
                </header>

                <div className="ws-stats">
                  <div>
                    <span className="ws-stat-label">Machines</span>
                    <span className="ws-stat-value">
                      {workspace.machineCount}
                      {max ? <span className="muted small"> / {unlimited ? "∞" : max}</span> : null}
                    </span>
                  </div>
                  <div>
                    <span className="ws-stat-label">This month</span>
                    <span className="ws-stat-value">{money(cost)}</span>
                  </div>
                  <div>
                    <span className="ws-stat-label">Snapshots</span>
                    <span className="ws-stat-value">{workspace.usage?.snapshots ?? 0}</span>
                  </div>
                </div>

                <div className="ws-sync">
                  {workspace.lastError ? (
                    <span className="ws-error" title={workspace.lastError}>
                      <Icon name="alert" size={12} /> {workspace.lastError}
                    </span>
                  ) : (
                    <span className={busy ? "ws-ok syncing" : "ws-ok"}>
                      <span className="status-dot tone-ok" />
                      {busy ? "Syncing…" : `Synced ${ago(workspace.lastSyncedAt)}`}
                    </span>
                  )}
                </div>

                <footer>
                  <span className="muted small" title={dateTime(workspace.createdAt)}>
                    added {ago(workspace.createdAt)}
                  </span>
                  <div className="row-actions">
                    <button
                      className="icon-btn"
                      title="Secrets & webhooks"
                      onClick={() => onTools(workspace)}
                    >
                      <Icon name="lock" />
                    </button>
                    <button
                      className="icon-btn"
                      title="Sync now"
                      onClick={() => onSync(workspace)}
                      disabled={busy}
                    >
                      <Icon name="refresh" className={busy ? "spin" : undefined} />
                    </button>
                    <button
                      className="icon-btn danger-hover"
                      title="Remove workspace"
                      onClick={() => onRemove(workspace)}
                      disabled={busy}
                    >
                      <Icon name="trash" />
                    </button>
                  </div>
                </footer>
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}

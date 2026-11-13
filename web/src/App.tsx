import { useCallback, useEffect, useMemo, useState } from "react";
import {
  errorMessage,
  getFleet,
  getSettings,
  machineAction,
  removeWorkspace,
  rotateMcpToken,
  syncAll,
  syncWorkspace,
} from "./api";
import { MachineDrawer } from "./components/Drawer";
import { AddWorkspaceModal } from "./components/AddWorkspaceModal";
import { CreateMachineModal } from "./components/CreateMachineModal";
import { ConfirmDialog, Toasts, type Toast, type ToastTone } from "./components/Modal";
import { Icon, type IconName } from "./icons";
import { ago } from "./format";
import type { Fleet, Machine, Settings, Workspace } from "./types";
import { ActivityView } from "./views/ActivityView";
import { FleetView } from "./views/FleetView";
import { McpView } from "./views/McpView";
import { SnapshotsView } from "./views/SnapshotsView";
import { WorkspacesView } from "./views/WorkspacesView";
import { WorkspaceToolsModal } from "./components/WorkspaceToolsModal";
import { DocsView } from "./views/DocsView";
import { DesktopsView } from "./views/DesktopsView";
import { SchedulesView } from "./views/SchedulesView";

type Tab =
  | "fleet"
  | "desktops"
  | "schedules"
  | "snapshots"
  | "workspaces"
  | "activity"
  | "mcp"
  | "docs";

const NAV: { id: Tab; label: string; icon: IconName }[] = [
  { id: "fleet", label: "Fleet", icon: "server" },
  { id: "desktops", label: "Desktops", icon: "monitor" },
  { id: "schedules", label: "Schedules", icon: "clock" },
  { id: "snapshots", label: "Snapshots", icon: "camera" },
  { id: "workspaces", label: "Workspaces", icon: "workspace" },
  { id: "activity", label: "Activity", icon: "activity" },
  { id: "mcp", label: "MCP", icon: "box" },
  { id: "docs", label: "Docs", icon: "book" },
];

function initialTheme(): "dark" | "light" {
  try {
    const stored = localStorage.getItem("vmdash-theme");
    if (stored === "light" || stored === "dark") return stored;
    return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
  } catch {
    return "dark";
  }
}

export default function App() {
  const [tab, setTab] = useState<Tab>("fleet");
  const [fleet, setFleet] = useState<Fleet | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [selectedKey, setSelectedKey] = useState<{ workspaceId: string; id: string } | null>(null);
  const [selectedTab, setSelectedTab] = useState<"desktop" | undefined>(undefined);
  const [addOpen, setAddOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Machine | null>(null);
  const [removeTarget, setRemoveTarget] = useState<Workspace | null>(null);
  const [toolsTarget, setToolsTarget] = useState<Workspace | null>(null);
  const [theme, setTheme] = useState<"dark" | "light">(initialTheme);
  const [busy, setBusy] = useState(false);
  const [syncingWorkspace, setSyncingWorkspace] = useState<string | null>(null);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("vmdash-theme", theme);
  }, [theme]);

  const notify = useCallback((message: string, tone: ToastTone = "info") => {
    const id = Date.now() + Math.random();
    setToasts((current) => [...current, { id, message, tone }]);
    window.setTimeout(() => {
      setToasts((current) => current.filter((toast) => toast.id !== id));
    }, 4600);
  }, []);

  const refresh = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const data = await getFleet();
      setFleet(data);
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    getSettings()
      .then(setSettings)
      .catch((err) => notify(errorMessage(err), "error"));
  }, [refresh, notify]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      void refresh(true);
    }, 15000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  useEffect(() => {
    const source = new EventSource("/api/events");
    let handle: number | undefined;
    const onChange = () => {
      window.clearTimeout(handle);
      handle = window.setTimeout(() => void refresh(true), 450);
    };
    source.addEventListener("change", onChange);
    return () => {
      window.clearTimeout(handle);
      source.removeEventListener("change", onChange);
      source.close();
    };
  }, [refresh]);

  const selected = useMemo(() => {
    if (!selectedKey || !fleet) return null;
    return (
      fleet.machines.find(
        (machine) => machine.workspaceId === selectedKey.workspaceId && machine.id === selectedKey.id,
      ) ?? null
    );
  }, [fleet, selectedKey]);

  async function act(machine: Machine, action: string) {
    try {
      await machineAction(machine.workspaceId, machine.id, action);
      notify(`${action} queued for ${machine.name}`, "ok");
      void refresh(true);
    } catch (err) {
      notify(errorMessage(err), "error");
    }
  }

  async function confirmDelete() {
    if (!deleteTarget) return;
    setBusy(true);
    try {
      await machineAction(
        deleteTarget.workspaceId,
        deleteTarget.id,
        "delete",
        deleteTarget.id,
      );
      notify(`Delete queued for ${deleteTarget.name}`, "ok");
      setDeleteTarget(null);
      setSelectedKey(null);
      void refresh(true);
    } catch (err) {
      notify(errorMessage(err), "error");
    } finally {
      setBusy(false);
    }
  }

  async function confirmRemove() {
    if (!removeTarget) return;
    setBusy(true);
    try {
      await removeWorkspace(removeTarget.id);
      notify(`Removed ${removeTarget.label}`, "ok");
      setRemoveTarget(null);
      if (fleet?.workspaces.length === 1) setTab("fleet");
      void refresh(true);
    } catch (err) {
      notify(errorMessage(err), "error");
    } finally {
      setBusy(false);
    }
  }

  async function doSyncAll() {
    try {
      await syncAll();
      notify("Sync started", "info");
    } catch (err) {
      notify(errorMessage(err), "error");
    }
  }

  async function doSyncWorkspace(workspace: Workspace) {
    setSyncingWorkspace(workspace.id);
    try {
      await syncWorkspace(workspace.id);
      notify(`Syncing ${workspace.label}`, "info");
      window.setTimeout(() => setSyncingWorkspace(null), 2200);
    } catch (err) {
      notify(errorMessage(err), "error");
      setSyncingWorkspace(null);
    }
  }

  async function rotate() {
    try {
      const result = await rotateMcpToken();
      setSettings((current) =>
        current ? { ...current, mcp: { ...current.mcp, token: result.token } } : current,
      );
      notify("MCP token rotated. Reconnect clients.", "ok");
    } catch (err) {
      notify(errorMessage(err), "error");
    }
  }

  function openNewMachine() {
    if (!fleet || fleet.workspaces.length === 0) {
      setAddOpen(true);
      return;
    }
    setCreateOpen(true);
  }

  const workspaces = fleet?.workspaces ?? [];
  const counts = fleet?.stats;
  const lastSync = fleet?.generatedAt;

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark" aria-hidden="true">
            <span /><span /><span />
          </div>
          <div className="brand-text">
            <strong>vmdash</strong>
            <span>fleet control</span>
          </div>
          <button
            className="icon-btn theme-toggle"
            title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
            onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
          >
            <Icon name={theme === "dark" ? "sun" : "moon"} size={15} />
          </button>
        </div>

        <nav className="nav" aria-label="Main">
          {NAV.map((item) => {
            const badge =
              item.id === "fleet"
                ? counts?.total
                : item.id === "workspaces"
                  ? workspaces.length
                  : undefined;
            return (
              <button
                key={item.id}
                className={tab === item.id ? "nav-item active" : "nav-item"}
                onClick={() => setTab(item.id)}
              >
                <Icon name={item.icon} size={15} />
                <span>{item.label}</span>
                {badge !== undefined ? <span className="nav-count">{badge}</span> : null}
              </button>
            );
          })}
        </nav>

        <div className="sidebar-spacer" />

        <div className="sidebar-card">
          <div className="sidebar-card-row">
            <span className="status-dot tone-ok" />
            <span>local control plane</span>
          </div>
          <div className="sidebar-meta">
            <span>{workspaces.length} keys</span>
            <span>{counts?.running ?? 0} running</span>
          </div>
          <div className="sidebar-meta">
            <span>MCP</span>
            <span className="mono">:8787/mcp</span>
          </div>
        </div>

        <div className="sidebar-foot">
          <span>synced {ago(lastSync)}</span>
          <span className="muted">v{settings?.version ?? "0.1.0"}</span>
        </div>
      </aside>

      <main className="main">
        {error ? (
          <div className="conn-banner">
            <Icon name="alert" />
            <span>{error}</span>
            <button className="btn ghost" onClick={() => void refresh()}>
              <Icon name="refresh" /> Retry
            </button>
          </div>
        ) : null}

        {tab === "fleet" ? (
          <FleetView
            fleet={fleet}
            loading={loading}
            onSelect={(machine) => {
              setSelectedTab(undefined);
              setSelectedKey({ workspaceId: machine.workspaceId, id: machine.id });
            }}
            onAction={(machine, action) => void act(machine, action)}
            onDelete={(machine) => setDeleteTarget(machine)}
            onNew={openNewMachine}
            onAddWorkspace={() => setAddOpen(true)}
            onSync={() => void doSyncAll()}
            notify={notify}
            onRefresh={() => void refresh(true)}
          />
        ) : null}

        {tab === "desktops" ? (
          <DesktopsView
            settings={settings}
            notify={notify}
            onOpenMachine={(machine) => {
              setSelectedTab("desktop");
              setSelectedKey({ workspaceId: machine.workspaceId, id: machine.id });
            }}
          />
        ) : null}

        {tab === "schedules" ? <SchedulesView fleet={fleet} notify={notify} /> : null}

        {tab === "workspaces" ? (
          <WorkspacesView
            fleet={fleet}
            onAdd={() => setAddOpen(true)}
            onSync={(workspace) => void doSyncWorkspace(workspace)}
            onRemove={(workspace) => setRemoveTarget(workspace)}
            onTools={(workspace) => setToolsTarget(workspace)}
            busyId={syncingWorkspace}
          />
        ) : null}

        {tab === "snapshots" ? (
          <SnapshotsView
            fleet={fleet}
            notify={notify}
            onRefresh={() => void refresh(true)}
          />
        ) : null}

        {tab === "activity" ? <ActivityView fleet={fleet} /> : null}

        {tab === "mcp" ? (
          <McpView settings={settings} onRotate={() => void rotate()} notify={notify} />
        ) : null}

        {tab === "docs" ? <DocsView settings={settings} /> : null}
      </main>

      {selected ? (
        <MachineDrawer
          key={`${selected.workspaceId}:${selected.id}`}
          machine={selected}
          settings={settings}
          theme={theme}
          initialTab={selectedTab}
          onClose={() => {
            setSelectedKey(null);
            setSelectedTab(undefined);
          }}
          onAction={(action) => void act(selected, action)}
          onDelete={() => setDeleteTarget(selected)}
          onRefresh={() => void refresh(true)}
          notify={notify}
        />
      ) : null}

      {addOpen ? (
        <AddWorkspaceModal
          onClose={() => setAddOpen(false)}
          onAdded={() => void refresh(true)}
          notify={notify}
        />
      ) : null}

      {createOpen && workspaces.length > 0 ? (
        <CreateMachineModal
          workspaces={workspaces}
          onClose={() => setCreateOpen(false)}
          onCreated={() => {
            setTab("fleet");
            window.setTimeout(() => void refresh(true), 800);
          }}
          notify={notify}
        />
      ) : null}

      {toolsTarget ? (
        <WorkspaceToolsModal
          workspace={toolsTarget}
          settings={settings}
          onClose={() => setToolsTarget(null)}
          notify={notify}
        />
      ) : null}

      {deleteTarget ? (
        <ConfirmDialog
          title={`Delete ${deleteTarget.name}?`}
          body={
            <>
              <p>This deletes the machine and its disk. It cannot be undone.</p>
              <p className="muted small">
                Snapshots are kept. Type the machine name in the InstaBox dashboard if you need a
                second confirmation.
              </p>
              <code className="confirm-id">{deleteTarget.id}</code>
            </>
          }
          confirmLabel="Delete machine"
          busy={busy}
          onConfirm={() => void confirmDelete()}
          onClose={() => setDeleteTarget(null)}
        />
      ) : null}

      {removeTarget ? (
        <ConfirmDialog
          title={`Remove ${removeTarget.label}?`}
          body={
            <>
              <p>
                The dashboard forgets this API key and its cached machines. Nothing is deleted on
                InstaBox.
              </p>
              <p className="muted small">
                {removeTarget.machineCount} machines will disappear from this fleet view.
              </p>
            </>
          }
          confirmLabel="Remove workspace"
          busy={busy}
          onConfirm={() => void confirmRemove()}
          onClose={() => setRemoveTarget(null)}
        />
      ) : null}

      <Toasts
        toasts={toasts}
        onDismiss={(id) => setToasts((current) => current.filter((toast) => toast.id !== id))}
      />
    </div>
  );
}

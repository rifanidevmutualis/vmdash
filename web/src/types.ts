export type MachineState =
  | "creating"
  | "starting"
  | "running"
  | "stopping"
  | "stopped"
  | "suspending"
  | "suspended"
  | "resuming"
  | "deleting"
  | "deleted"
  | "error"
  | string;

export type Machine = {
  id: string;
  name: string;
  state: MachineState;
  desiredState?: MachineState;
  workspaceId: string;
  workspaceLabel?: string;
  workspaceOrg?: string | null;
  workspaceTier?: string | null;
  template?: { id: string; version?: string; digest?: string };
  spec?: { vcpus: number; memMiB: number; persistentDiskGiB: number };
  runtime?: { ready?: boolean; processesPreserved?: boolean };
  autoSuspendAfterSeconds?: number | null;
  maxRunMinutes?: number;
  envNames?: string[];
  createdAt?: string;
  updatedAt?: string;
  readyAt?: string;
  metadata?: Record<string, string>;
  lastError?: { code: string; message: string } | null;
  oomKills?: number;
  free?: boolean;
  [key: string]: unknown;
};

export type Usage = {
  machines?: number;
  snapshots?: number;
  storedBytes?: number;
  logicalBytes?: number;
  cost?: {
    costUSD?: number;
    allowanceUSD?: number;
    creditRemainingUSD?: number;
    runtimeUSD?: number;
    storageUSD?: number;
    egressUSD?: number;
  };
  limits?: {
    maxMachines?: number;
    maxSnapshots?: number;
    maxStoredGiB?: number;
    unlimited?: string[] | null;
  };
  [key: string]: unknown;
};

export type Workspace = {
  id: string;
  label: string;
  orgId?: string | null;
  orgName?: string | null;
  tier?: string | null;
  login?: string | null;
  createdAt: string;
  lastSyncedAt?: string | null;
  lastError?: string | null;
  machineCount: number;
  usage?: Usage | null;
};

export type Stats = {
  total: number;
  running: number;
  paused: number;
  stopped: number;
  error: number;
  other: number;
};

export type Operation = {
  id: string;
  workspaceId: string;
  machineId?: string | null;
  kind: string;
  state: string;
  error?: string | null;
  createdAt: string;
  updatedAt: string;
};

export type Spend = {
  monthUSD: number;
  workspaces: {
    workspaceId: string;
    label: string;
    costUSD: number;
    maxMachines?: number | null;
    machines: number;
  }[];
};

export type Fleet = {
  machines: Machine[];
  workspaces: Workspace[];
  stats: Stats;
  spend: Spend;
  operations: Operation[];
  generatedAt: string;
};

export type AuditEntry = {
  id: number;
  ts: string;
  workspaceId?: string | null;
  machineId?: string | null;
  action: string;
  detail?: string | null;
  ok: number;
};

export type Settings = {
  version: string;
  dataDir: string;
  mcp: { url: string; token: string; stdioCommand: string };
  syncSeconds: number;
  apiBase: string;
  publicUrl?: string | null;
};

export type ExecResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
  truncated: boolean;
  signal?: string;
  oomKilled?: boolean;
};

export type FileEntry = {
  name: string;
  type: "dir" | "file" | "symlink" | "other";
  size: number;
  mode: string;
  modTime: string;
  target?: string;
};

export type FilesResponse = {
  path: string;
  type: "dir" | "file" | "other";
  size: number;
  mode: string;
  modTime: string;
  content?: string;
  binary?: boolean;
  truncated?: boolean;
  entries?: FileEntry[];
};

export type PublicPort = {
  id: string;
  machineId: string;
  port: number;
  name: string;
  url: string;
  access: "public" | "private";
  protocol?: "http" | "tcp";
  address?: string;
  token?: string;
  tokenUrl?: string;
  createdAt: string;
};

export type Snapshot = {
  id: string;
  name: string;
  description?: string;
  orgId: string;
  sourceMachineId: string;
  template?: { id: string; version?: string };
  rootSizeBytes: number;
  dataSizeBytes?: number;
  createdAt: string;
  status: "pending" | "ready" | "failed";
  error?: string;
};

export type SshToken = {
  id: string;
  name: string;
  machineId: string;
  host: string;
  port: number;
  token: string;
  command: string;
  moshCommand?: string;
  expiresAt?: string;
  revokedAt?: string;
  hostKeyFingerprint: string;
};

export type MetricSample = {
  at?: string;
  cpuUsedPct?: number;
  cpuCount?: number;
  memUsed?: number;
  memTotal?: number;
  netInBytesPerSec?: number;
  netOutBytesPerSec?: number;
  diskReadBytesPerSec?: number;
  diskWriteBytesPerSec?: number;
  diskUsed?: number;
  diskTotal?: number;
};

export type MachineMetrics = {
  metrics: MetricSample[];
  disk?: {
    measuredAt: string;
    warning?: { message: string; level: string; mount: string; usedPct: number };
    filesystems: {
      mount: string;
      sizeBytes: number;
      usedBytes: number;
      availableBytes: number;
      usedPct: number;
      inodesUsedPct: number;
      level: string;
    }[];
  };
};

export type MachineLogs = {
  machineId: string;
  state: string;
  console: string;
  cursor: number;
  consoleReset?: boolean;
  consoleTruncated?: boolean;
  consoleUnavailable?: string;
  operations: {
    id: string;
    type?: string;
    kind?: string;
    state: string;
    error?: string | null;
    updatedAt: string;
  }[];
};

export type ExecHistoryEntry = {
  id: string;
  machineId: string;
  command: string;
  cwd?: string;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  status: string;
  exitCode: number;
  timedOut: boolean;
  stdout?: string;
  stderr?: string;
  truncated?: boolean;
};

export type DesktopState = {
  installed: boolean;
  installing: boolean;
  running: boolean;
  failed: boolean;
  installedPath?: string;
  kind?: string;
  controller?: string;
  yours?: boolean;
  hint?: string;
  log?: string;
  actions?: { time: string; tool: string; refused?: boolean }[];
};

export type SecretMeta = {
  id: string;
  orgId: string;
  name: string;
  delivery: "proxy" | "env";
  hosts: string[];
  version: number;
  size: number;
  createdAt: string;
  updatedAt: string;
};

export type MachineSecrets = {
  secrets: "all" | string[];
  envSecrets: string[];
  directSecrets: unknown[];
  items: SecretMeta[];
  version: number;
  proxy?: { state: string; revision: number; appliedRevision: number; expiresAt?: string };
  guest?: { state: string; revision: number; appliedRevision: number; error?: string };
};

export type Webhook = {
  id: string;
  orgId: string;
  url: string;
  description?: string;
  events: string[];
  enabled: boolean;
  secret?: string;
  createdAt: string;
  updatedAt: string;
  disabledReason?: string;
  failingSince?: string;
};

export type WebhookList = {
  items: Webhook[];
  eventTypes: string[];
  maxEndpoints: number;
};

export type WebhookDelivery = {
  id: string;
  eventId: string;
  eventType: string;
  state: "pending" | "succeeded" | "failed";
  attempts: number;
  createdAt: string;
  lastError?: string;
  lastStatus?: number;
  retryable: boolean;
};

export type WebhookEventRow = {
  id: string;
  workspaceId: string;
  eventType: string;
  payload: string;
  receivedAt: string;
};

export type DesktopEntry = {
  workspaceId: string;
  workspaceLabel?: string;
  workspaceOrg?: string | null;
  workspaceTier?: string | null;
  machine: Machine;
  desktop: DesktopState | null;
  error: { code: string; message: string } | null;
  vncAvailable: boolean;
};

export type DesktopWall = {
  desktops: DesktopEntry[];
  generatedAt: string;
  maxLive: number;
};

export type BulkItem = { workspaceId: string; machineId: string };

export type BulkResultItem = {
  workspaceId: string;
  machineId: string;
  name?: string;
  ok: boolean;
  operationId?: string;
  operationState?: string;
  error?: { code: string; message: string; retryable?: boolean };
};

export type BulkResponse = {
  action: string;
  ok: number;
  failed: number;
  results: BulkResultItem[];
};

export type ScheduleResult = {
  ok: number;
  failed: number;
  skipped: number;
  missed?: boolean;
  message?: string;
  error?: string;
  results?: { name: string; ok: boolean; error?: { code: string; message: string } }[];
};

export type Schedule = {
  id: string;
  name: string;
  action: "start" | "resume" | "suspend" | "stop";
  scope: "workspace" | "machines";
  workspaceId?: string | null;
  machineIds?: string[] | null;
  kind: "daily" | "weekdays" | "hourly" | "once";
  timeOfDay?: string | null;
  minute?: number | null;
  runAt?: string | null;
  enabled: boolean;
  nextRunAt?: string | null;
  lastRunAt?: string | null;
  lastResult?: ScheduleResult | null;
  createdAt: string;
  updatedAt: string;
};

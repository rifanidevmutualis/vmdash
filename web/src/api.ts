import type {
  AuditEntry,
  ExecResult,
  Fleet,
  Machine,
  Operation,
  Settings,
  Workspace,
} from "./types";

export class ApiError extends Error {
  code: string;
  details: Record<string, unknown>;

  constructor(code: string, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      ...init,
      headers: {
        "content-type": "application/json",
        ...(init?.headers ?? {}),
      },
    });
  } catch {
    throw new ApiError("network", "Cannot reach the vmdash server. Is it running?");
  }

  const text = await res.text();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }

  if (!res.ok) {
    const body = data as { error?: { code?: string; message?: string } } | null;
    throw new ApiError(
      body?.error?.code ?? `http_${res.status}`,
      body?.error?.message ?? res.statusText ?? "Request failed",
      (body?.error ?? {}) as Record<string, unknown>,
    );
  }
  return (data ?? {}) as T;
}

export function getFleet(): Promise<Fleet> {
  return request<Fleet>("/api/fleet");
}

export function addWorkspace(key: string, label?: string): Promise<{ workspace: Workspace }> {
  return request("/api/workspaces", {
    method: "POST",
    body: JSON.stringify({ key, label: label || null }),
  });
}

export function removeWorkspace(id: string): Promise<{ ok: boolean }> {
  return request(`/api/workspaces/${id}`, { method: "DELETE" });
}

export function syncWorkspace(id: string): Promise<{ started: boolean }> {
  return request(`/api/workspaces/${id}/sync`, { method: "POST", body: "{}" });
}

export function syncAll(): Promise<{ started: boolean }> {
  return request("/api/sync", { method: "POST", body: "{}" });
}

export function machineAction(
  workspaceId: string,
  machineId: string,
  action: string,
  confirm?: string,
): Promise<{ operation: Operation }> {
  return request(`/api/machines/${workspaceId}/${machineId}/action`, {
    method: "POST",
    body: JSON.stringify({ action, confirm }),
  });
}

export function execCommand(
  workspaceId: string,
  machineId: string,
  cmd: string,
  timeoutSeconds = 60,
): Promise<{ result: ExecResult }> {
  return request(`/api/machines/${workspaceId}/${machineId}/exec`, {
    method: "POST",
    body: JSON.stringify({ cmd, timeoutSeconds }),
  });
}

export type CreateMachineInput = {
  workspaceId: string;
  name?: string;
  templateId?: string;
  vcpus?: number;
  memMiB?: number;
  autoSuspendAfterSeconds?: number;
  metadata?: Record<string, string>;
  env?: Record<string, string>;
};

export function createMachine(input: CreateMachineInput): Promise<{ operation: Operation }> {
  return request("/api/machines", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function getAudit(limit = 120): Promise<{ audit: AuditEntry[] }> {
  return request(`/api/audit?limit=${limit}`);
}

export function getSettings(): Promise<Settings> {
  return request("/api/settings");
}

export function rotateMcpToken(): Promise<{ token: string }> {
  return request("/api/settings/mcp-token", { method: "POST", body: "{}" });
}

export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return String(err);
}

export type { Machine };

// ── Files ──────────────────────────────────────────────────────────────

export function listFiles(workspaceId: string, machineId: string, path: string) {
  return request<import("./types").FilesResponse>(
    `/api/machines/${workspaceId}/${machineId}/files?path=${encodeURIComponent(path)}`,
  );
}

export function downloadFileUrl(workspaceId: string, machineId: string, path: string): string {
  return `/api/machines/${workspaceId}/${machineId}/files/content?path=${encodeURIComponent(path)}`;
}

export async function writeFile(
  workspaceId: string,
  machineId: string,
  path: string,
  content: Blob | string,
  options: { mode?: string; parents?: boolean } = {},
) {
  const params = new URLSearchParams({ path });
  if (options.mode) params.set("mode", options.mode);
  if (options.parents) params.set("parents", "true");
  const res = await fetch(
    `/api/machines/${workspaceId}/${machineId}/files?${params.toString()}`,
    {
      method: "PUT",
      headers: { "content-type": "application/octet-stream" },
      body: content,
    },
  );
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) {
    throw new ApiError(
      data?.error?.code ?? "upload_failed",
      data?.error?.message ?? "Upload failed",
    );
  }
  return data;
}

export function deleteFile(workspaceId: string, machineId: string, path: string) {
  return request<{ result: unknown }>(
    `/api/machines/${workspaceId}/${machineId}/files`,
    { method: "DELETE", body: JSON.stringify({ path }) },
  );
}

// ── SSH ────────────────────────────────────────────────────────────────

export function sshTokens(workspaceId: string, machineId: string) {
  return request<{ tokens: import("./types").SshToken[] }>(
    `/api/machines/${workspaceId}/${machineId}/ssh-tokens`,
  );
}

export function createSshToken(
  workspaceId: string,
  machineId: string,
  name?: string,
  ttlSeconds?: number,
) {
  return request<import("./types").SshToken>(
    `/api/machines/${workspaceId}/${machineId}/ssh-tokens`,
    { method: "POST", body: JSON.stringify({ name, ttlSeconds }) },
  );
}

export function revokeSshToken(workspaceId: string, machineId: string, tokenId: string) {
  return request<{ ok: boolean }>(
    `/api/machines/${workspaceId}/${machineId}/ssh-tokens/${tokenId}`,
    { method: "DELETE" },
  );
}

export function revokeAllSshTokens(workspaceId: string, machineId: string) {
  return request<{ revoked: number }>(
    `/api/machines/${workspaceId}/${machineId}/ssh-tokens`,
    { method: "DELETE" },
  );
}

// ── Desktop ────────────────────────────────────────────────────────────

export function desktopAction(
  workspaceId: string,
  machineId: string,
  action: string,
  width?: number,
  height?: number,
) {
  return request<import("./types").DesktopState>(
    `/api/machines/${workspaceId}/${machineId}/desktop`,
    { method: "POST", body: JSON.stringify({ action, width, height }) },
  );
}

export function desktopStream(
  workspaceId: string,
  machineId: string,
  viewOnly: boolean,
  ttlSeconds?: number,
) {
  return request<{ url: string; expiresAt: string }>(
    `/api/machines/${workspaceId}/${machineId}/desktop/stream`,
    { method: "POST", body: JSON.stringify({ viewOnly, ttlSeconds }) },
  );
}

export function revokeDesktopStream(workspaceId: string, machineId: string) {
  return request<{ ok: boolean }>(
    `/api/machines/${workspaceId}/${machineId}/desktop/stream`,
    { method: "DELETE" },
  );
}

// ── Ports ──────────────────────────────────────────────────────────────

export function listPorts(workspaceId: string, machineId: string) {
  return request<{ enabled: boolean; ports: import("./types").PublicPort[] }>(
    `/api/machines/${workspaceId}/${machineId}/ports`,
  );
}

export function publishPort(
  workspaceId: string,
  machineId: string,
  input: { port: number; access?: string; protocol?: string; name?: string },
) {
  return request<import("./types").PublicPort>(
    `/api/machines/${workspaceId}/${machineId}/ports`,
    { method: "POST", body: JSON.stringify(input) },
  );
}

export function unpublishPort(workspaceId: string, machineId: string, port: number) {
  return request<{ ok: boolean }>(
    `/api/machines/${workspaceId}/${machineId}/ports/${port}`,
    { method: "DELETE" },
  );
}

// ── Snapshots / fork / restore ─────────────────────────────────────────

export function workspaceSnapshots(workspaceId: string) {
  return request<{ snapshots: import("./types").Snapshot[] }>(
    `/api/workspaces/${workspaceId}/snapshots`,
  );
}

export function createSnapshot(
  workspaceId: string,
  machineId: string,
  input: { name: string; description?: string; rootOnly?: boolean; forFork?: boolean },
) {
  return request<import("./types").Snapshot>(
    `/api/machines/${workspaceId}/${machineId}/snapshots`,
    { method: "POST", body: JSON.stringify(input) },
  );
}

export function deleteSnapshot(workspaceId: string, snapshotId: string) {
  return request<{ ok: boolean }>(`/api/snapshots/${workspaceId}/${snapshotId}`, {
    method: "DELETE",
  });
}

export function restoreSnapshot(
  workspaceId: string,
  machineId: string,
  snapshotId: string,
  startAfterRestore = false,
) {
  return request<{ operation: import("./types").Operation }>(
    `/api/machines/${workspaceId}/${machineId}/restore`,
    {
      method: "POST",
      body: JSON.stringify({
        snapshotId,
        desiredState: startAfterRestore ? "running" : undefined,
      }),
    },
  );
}

export function forkMachine(
  workspaceId: string,
  machineId: string,
  input: { name?: string; vcpus?: number; memMiB?: number } = {},
) {
  return request<{ operation: import("./types").Operation }>(
    `/api/machines/${workspaceId}/${machineId}/fork`,
    { method: "POST", body: JSON.stringify(input) },
  );
}

// ── Machine config ─────────────────────────────────────────────────────

export function patchMachine(
  workspaceId: string,
  machineId: string,
  input: {
    name?: string;
    vcpus?: number;
    memMiB?: number;
    persistentDiskGiB?: number;
    autoSuspendAfterSeconds?: number;
    maxRunMinutes?: number;
    metadata?: Record<string, string>;
  },
) {
  return request<Record<string, unknown>>(
    `/api/machines/${workspaceId}/${machineId}`,
    { method: "PATCH", body: JSON.stringify(input) },
  );
}

// ── Telemetry ──────────────────────────────────────────────────────────

export function machineMetrics(workspaceId: string, machineId: string, since?: string) {
  const query = since ? `?since=${encodeURIComponent(since)}` : "";
  return request<import("./types").MachineMetrics>(
    `/api/machines/${workspaceId}/${machineId}/metrics${query}`,
  );
}

export function machineLogs(workspaceId: string, machineId: string, tail = 400) {
  return request<import("./types").MachineLogs>(
    `/api/machines/${workspaceId}/${machineId}/logs?tail=${tail}`,
  );
}

export function machineHistory(workspaceId: string, machineId: string, limit = 30) {
  return request<{ commands: import("./types").ExecHistoryEntry[] }>(
    `/api/machines/${workspaceId}/${machineId}/history?limit=${limit}`,
  );
}

// ── Secrets ────────────────────────────────────────────────────────────

export function orgSecrets(workspaceId: string) {
  return request<{ items: import("./types").SecretMeta[] }>(
    `/api/workspaces/${workspaceId}/secrets`,
  );
}

export function putSecret(
  workspaceId: string,
  name: string,
  input: { value: string; delivery: "proxy" | "env"; hosts?: string[] },
) {
  return request<import("./types").SecretMeta>(
    `/api/workspaces/${workspaceId}/secrets/${encodeURIComponent(name)}`,
    { method: "PUT", body: JSON.stringify(input) },
  );
}

export function deleteSecret(workspaceId: string, name: string) {
  return request<{ ok: boolean }>(
    `/api/workspaces/${workspaceId}/secrets/${encodeURIComponent(name)}`,
    { method: "DELETE" },
  );
}

export function machineSecrets(workspaceId: string, machineId: string) {
  return request<import("./types").MachineSecrets>(
    `/api/machines/${workspaceId}/${machineId}/secrets`,
  );
}

export function patchMachineSecrets(
  workspaceId: string,
  machineId: string,
  input: { secrets?: "all" | string[]; envSecrets?: string[] },
) {
  return request<import("./types").MachineSecrets>(
    `/api/machines/${workspaceId}/${machineId}/secrets`,
    { method: "PATCH", body: JSON.stringify(input) },
  );
}

export function refreshMachineSecrets(workspaceId: string, machineId: string) {
  return request<import("./types").MachineSecrets>(
    `/api/machines/${workspaceId}/${machineId}/secrets`,
    { method: "POST", body: "{}" },
  );
}

// ── Webhooks ───────────────────────────────────────────────────────────

export function listWebhooks(workspaceId: string) {
  return request<import("./types").WebhookList>(
    `/api/workspaces/${workspaceId}/webhooks`,
  );
}

export function createWebhook(
  workspaceId: string,
  input: { url: string; events: string[]; description?: string; enabled?: boolean },
) {
  return request<import("./types").Webhook>(
    `/api/workspaces/${workspaceId}/webhooks`,
    { method: "POST", body: JSON.stringify(input) },
  );
}

export function updateWebhook(
  workspaceId: string,
  webhookId: string,
  input: { url?: string; events?: string[]; description?: string; enabled?: boolean },
) {
  return request<import("./types").Webhook>(
    `/api/workspaces/${workspaceId}/webhooks/${webhookId}`,
    { method: "PATCH", body: JSON.stringify(input) },
  );
}

export function deleteWebhook(workspaceId: string, webhookId: string) {
  return request<{ ok: boolean }>(
    `/api/workspaces/${workspaceId}/webhooks/${webhookId}`,
    { method: "DELETE" },
  );
}

export function rotateWebhook(workspaceId: string, webhookId: string) {
  return request<import("./types").Webhook>(
    `/api/workspaces/${workspaceId}/webhooks/${webhookId}/rotate`,
    { method: "POST", body: "{}" },
  );
}

export function testWebhook(workspaceId: string, webhookId: string) {
  return request<unknown>(
    `/api/workspaces/${workspaceId}/webhooks/${webhookId}/test`,
    { method: "POST", body: "{}" },
  );
}

export function webhookDeliveries(workspaceId: string, webhookId: string) {
  return request<{ items: import("./types").WebhookDelivery[] }>(
    `/api/workspaces/${workspaceId}/webhooks/${webhookId}/deliveries`,
  );
}

export function webhookEvents(limit = 50) {
  return request<{ events: import("./types").WebhookEventRow[] }>(
    `/api/webhook-events?limit=${limit}`,
  );
}

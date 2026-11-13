use axum::Json;
use serde_json::{json, Value};

use crate::extras::{execute_bulk, BulkItem};
use crate::instabox::{new_idempotency_key, ApiError};
use crate::state::SharedState;
use crate::store::{MachineRow, Workspace};

const PROTOCOL_VERSION: &str = "2025-06-18";

pub fn tools() -> Value {
    json!([
        {
            "name": "list_workspaces",
            "description": "List the InstaBox workspaces connected to this dashboard. Each workspace is one API key and owns its own machines. Shows org, plan, machine count and this month's spend.",
            "inputSchema": { "type": "object", "properties": {} }
        },
        {
            "name": "list_machines",
            "description": "List cached InstaBox machines across all connected workspaces. Filter by workspace, state (running, suspended, stopped, error) or a name substring. The cache refreshes every ~15 seconds and after every action.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "workspace": { "type": "string", "description": "Workspace id, label or org name. Optional when only one workspace is connected." },
                    "status": { "type": "string", "description": "running | suspended | stopped | error | all" },
                    "query": { "type": "string", "description": "Substring of the machine name or id." }
                }
            }
        },
        {
            "name": "get_machine",
            "description": "Get one machine by id or name: state, size, template, metadata, auto-pause, runtime and storage.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "machine": { "type": "string", "description": "Machine id (m_...) or unique name." },
                    "workspace": { "type": "string", "description": "Workspace id, label or org name when the machine name is ambiguous." }
                },
                "required": ["machine"]
            }
        },
        {
            "name": "create_machine",
            "description": "Create a machine from a template and wait for the create operation. Default template is agent-browser (Claude Code, Codex, OpenCode, Docker, desktop preinstalled). Default size is 4 vCPU / 8 GiB.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "workspace": { "type": "string", "description": "Workspace id, label or org name. Optional when only one workspace is connected." },
                    "name": { "type": "string", "description": "1-63 lowercase letters, digits or dashes; unique in the workspace." },
                    "template": { "type": "string", "enum": ["agent-browser", "universal", "t3", "herdr", "orca", "android", "omarchy", "ci"] },
                    "vcpus": { "type": "integer" },
                    "mem_mib": { "type": "integer" },
                    "idle_pause_minutes": { "type": "integer", "description": "Pause after this many idle minutes; paid plans take 5-30, 0 means never where allowed." },
                    "metadata": { "type": "object", "additionalProperties": { "type": "string" } }
                }
            }
        },
        {
            "name": "machine_action",
            "description": "Start, stop, suspend (pause, memory kept) or resume a machine. Returns the InstaBox operation; the dashboard follows it to completion.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "machine": { "type": "string" },
                    "workspace": { "type": "string" },
                    "action": { "type": "string", "enum": ["start", "stop", "suspend", "resume"] }
                },
                "required": ["machine", "action"]
            }
        },
        {
            "name": "delete_machine",
            "description": "Permanently delete a machine. Requires confirm to equal the machine's id or name, so a mistyped target cannot destroy another machine. Snapshots are kept.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "machine": { "type": "string" },
                    "workspace": { "type": "string" },
                    "confirm": { "type": "string", "description": "The machine's exact id or name." }
                },
                "required": ["machine", "confirm"]
            }
        },
        {
            "name": "exec",
            "description": "Run a shell command (bash -lc) in a machine and return stdout, stderr and the exit code. The machine must be running. Timeout defaults to 60s; maximum 600s. For longer work, redirect to a file and start it in the background.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "machine": { "type": "string" },
                    "workspace": { "type": "string" },
                    "cmd": { "type": "string" },
                    "timeout_seconds": { "type": "integer", "minimum": 1, "maximum": 600 }
                },
                "required": ["machine", "cmd"]
            }
        },
        {
            "name": "get_usage",
            "description": "Read this month's InstaBox usage and limits per workspace: machines, snapshots, stored GiB, cost in USD and the plan's caps.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "workspace": { "type": "string", "description": "Optional; omit for every connected workspace." }
                }
            }
        },
        {
            "name": "files",
            "description": "Work with files inside a running machine. op=list lists a directory (default /data/home), op=read returns a text file up to 256 KiB, op=write uploads UTF-8 content to a path. Binary reads are reported with binary=true; use download_file from the dashboard for raw bytes.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "op": { "type": "string", "enum": ["list", "read", "write"] },
                    "machine": { "type": "string" },
                    "workspace": { "type": "string" },
                    "path": { "type": "string" },
                    "content": { "type": "string", "description": "op=write: UTF-8 file body." },
                    "mode": { "type": "string", "description": "op=write: octal mode such as 0644." },
                    "parents": { "type": "boolean", "description": "op=write: create missing parent directories." }
                },
                "required": ["op", "machine"]
            }
        },
        {
            "name": "ssh_token",
            "description": "Issue a short-lived SSH token for a supported external ssh client. Returns the token, host, port and a ready-to-run ssh command. The token is a secret and works until it expires or is revoked.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "machine": { "type": "string" },
                    "workspace": { "type": "string" },
                    "name": { "type": "string" },
                    "ttl_seconds": { "type": "integer", "minimum": 60, "maximum": 2592000 }
                },
                "required": ["machine"]
            }
        },
        {
            "name": "desktop",
            "description": "Inspect or start a machine's desktop, or mint a short-lived shareable viewer URL (op=link). The URL is view-only unless view_only=false; embedding it needs a browser. With a workspace key the link may be refused (403) because links belong to the machine creator; use the dashboard's VNC tab instead.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "op": { "type": "string", "enum": ["status", "start", "install", "link"] },
                    "machine": { "type": "string" },
                    "workspace": { "type": "string" },
                    "view_only": { "type": "boolean" },
                    "ttl_seconds": { "type": "integer", "minimum": 60, "maximum": 86400 }
                },
                "required": ["op", "machine"]
            }
        },
        {
            "name": "ports",
            "description": "Publish, list or remove public HTTPS/TCP ports of a running machine. op=publish needs port; access is public or private. Returns the URL (and token URL for private ports).",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "op": { "type": "string", "enum": ["list", "publish", "unpublish"] },
                    "machine": { "type": "string" },
                    "workspace": { "type": "string" },
                    "port": { "type": "integer", "minimum": 1, "maximum": 65535 },
                    "access": { "type": "string", "enum": ["public", "private"] },
                    "protocol": { "type": "string", "enum": ["http", "tcp"] },
                    "name": { "type": "string" }
                },
                "required": ["op", "machine"]
            }
        },
        {
            "name": "snapshots",
            "description": "Save, list, delete or restore snapshots. op=create saves a machine's disks (name required), op=restore puts a machine's disks back to a snapshot, op=list returns snapshots for a workspace, op=delete removes one. Snapshots survive machine deletion.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "op": { "type": "string", "enum": ["list", "create", "delete", "restore"] },
                    "workspace": { "type": "string" },
                    "machine": { "type": "string" },
                    "snapshot": { "type": "string", "description": "Snapshot id for delete/restore." },
                    "name": { "type": "string", "description": "op=create snapshot name." },
                    "description": { "type": "string" },
                    "root_only": { "type": "boolean" },
                    "for_fork": { "type": "boolean" },
                    "start_after_restore": { "type": "boolean" }
                },
                "required": ["op"]
            }
        },
        {
            "name": "fork_machine",
            "description": "Copy a machine's disks to a new machine on the same host, without a snapshot. Much faster than snapshot+create. Returns the create operation.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "machine": { "type": "string" },
                    "workspace": { "type": "string" },
                    "name": { "type": "string" },
                    "vcpus": { "type": "integer" },
                    "mem_mib": { "type": "integer" },
                    "idle_pause_minutes": { "type": "integer" }
                },
                "required": ["machine"]
            }
        },
        {
            "name": "resize_machine",
            "description": "Rename a machine, resize vCPU/memory/disk, change idle auto-pause or max-run minutes, or replace metadata. Resizes may need the machine stopped; InstaBox returns a retryable conflict when it does.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "machine": { "type": "string" },
                    "workspace": { "type": "string" },
                    "name": { "type": "string" },
                    "vcpus": { "type": "integer" },
                    "mem_mib": { "type": "integer" },
                    "disk_gib": { "type": "integer" },
                    "idle_pause_minutes": { "type": "integer" },
                    "max_run_minutes": { "type": "integer" },
                    "metadata": { "type": "object", "additionalProperties": { "type": "string" } }
                },
                "required": ["machine"]
            }
        },
        {
            "name": "metrics",
            "description": "Read host-level CPU, memory, disk and network samples for a machine (one per 30 seconds), plus filesystem usage.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "machine": { "type": "string" },
                    "workspace": { "type": "string" },
                    "since": { "type": "string", "description": "RFC 3339 timestamp; omit for recent samples." }
                },
                "required": ["machine"]
            }
        },
        {
            "name": "logs",
            "description": "Read a machine's console log and its last operations, useful when it fails to boot or is unreachable.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "machine": { "type": "string" },
                    "workspace": { "type": "string" },
                    "tail": { "type": "integer", "minimum": 1, "maximum": 5000 }
                },
                "required": ["machine"]
            }
        },
        {
            "name": "history",
            "description": "List the most recent exec commands of a machine, newest first, with their exit status and stored output.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "machine": { "type": "string" },
                    "workspace": { "type": "string" },
                    "limit": { "type": "integer", "minimum": 1, "maximum": 100 }
                },
                "required": ["machine"]
            }
        },
        {
            "name": "secrets",
            "description": "Manage org Secrets and a machine's Secret selections. op=list/set/delete work on the workspace (set sends a write-only value), op=machine reads a machine's selections and delivery status, op=select replaces selections, op=refresh re-applies delivery in a running machine. Secrets are never returned by value.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "op": { "type": "string", "enum": ["list", "set", "delete", "machine", "select", "refresh"] },
                    "workspace": { "type": "string" },
                    "machine": { "type": "string" },
                    "name": { "type": "string" },
                    "value": { "type": "string" },
                    "delivery": { "type": "string", "enum": ["proxy", "env"] },
                    "hosts": { "type": "array", "items": { "type": "string" } },
                    "secrets": { "description": "op=select: 'all' or an array of names." },
                    "env_secrets": { "type": "array", "items": { "type": "string" } }
                },
                "required": ["op"]
            }
        },
        {
            "name": "webhooks",
            "description": "Manage InstaBox webhook endpoints for a workspace: list, create, update, delete, rotate the signing secret, send a test, or read deliveries. The URL must be public HTTPS. The dashboard can also receive events at /webhooks/instabox/<workspaceId> when VMDASH_PUBLIC_URL is set.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "op": { "type": "string", "enum": ["list", "create", "update", "delete", "rotate", "test", "deliveries"] },
                    "workspace": { "type": "string" },
                    "webhook": { "type": "string", "description": "Webhook id for update/delete/rotate/test/deliveries." },
                    "url": { "type": "string" },
                    "events": { "type": "array", "items": { "type": "string" } },
                    "description": { "type": "string" },
                    "enabled": { "type": "boolean" }
                },
                "required": ["op"]
            }
        },
        {
            "name": "bulk_action",
            "description": "Run one lifecycle action (start, stop, suspend, resume, delete) on up to 50 machines at once. Machines are ids or names, optionally scoped by workspace. The server runs four at a time and returns a per-machine result. For delete, confirm must be the literal string 'delete' and count must equal the number of resolved machines.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "action": { "type": "string", "enum": ["start", "stop", "suspend", "resume", "delete"] },
                    "machines": {
                        "type": "array",
                        "minItems": 1,
                        "maxItems": 50,
                        "items": { "type": "string", "description": "Machine id or unique name." }
                    },
                    "workspace": { "type": "string", "description": "Workspace id, label or org name when names are ambiguous." },
                    "confirm": { "type": "string", "description": "Bulk delete requires 'delete'." },
                    "count": { "type": "integer", "description": "Bulk delete requires the exact number of resolved machines." }
                },
                "required": ["action", "machines"]
            }
        }
    ])
}

fn text_result(value: &Value) -> Value {
    json!({
        "content": [{ "type": "text", "text": serde_json::to_string_pretty(value).unwrap_or_else(|_| value.to_string()) }],
        "isError": false
    })
}

fn error_result(message: impl Into<String>) -> Value {
    json!({
        "content": [{ "type": "text", "text": message.into() }],
        "isError": true
    })
}

fn api_error(err: ApiError) -> Value {
    error_result(format!(
        "InstaBox error [{}]: {}{}",
        err.code,
        err.message,
        err.retry_after_seconds
            .map(|s| format!(" (retry after {s}s)"))
            .unwrap_or_default()
    ))
}

fn arg_str<'a>(args: &'a Value, key: &str) -> Option<&'a str> {
    args.get(key).and_then(Value::as_str).filter(|s| !s.is_empty())
}

async fn find_workspace(state: &SharedState, args: &Value) -> Result<Workspace, String> {
    let workspaces = state
        .store
        .list_workspaces()
        .await
        .map_err(|e| e.to_string())?;
    if workspaces.is_empty() {
        return Err("No workspace is connected yet. Add an InstaBox API key in the dashboard first.".into());
    }
    if let Some(needle) = arg_str(args, "workspace") {
        let needle = needle.to_lowercase();
        return workspaces
            .into_iter()
            .find(|w| {
                w.id.to_lowercase() == needle
                    || w.label.to_lowercase() == needle
                    || w.org_name
                        .as_deref()
                        .map(|o| o.to_lowercase() == needle)
                        .unwrap_or(false)
                    || w.org_id.as_deref().map(|o| o.to_lowercase() == needle).unwrap_or(false)
            })
            .ok_or_else(|| format!("No workspace matches \"{needle}\"."));
    }
    if workspaces.len() == 1 {
        return Ok(workspaces.into_iter().next().unwrap());
    }
    Err(format!(
        "{} workspaces are connected; name one with the workspace argument: {}",
        workspaces.len(),
        workspaces
            .iter()
            .map(|w| w.label.as_str())
            .collect::<Vec<_>>()
            .join(", ")
    ))
}

async fn find_machine(
    state: &SharedState,
    args: &Value,
) -> Result<(Workspace, MachineRow), String> {
    let machine_ref = arg_str(args, "machine").ok_or("machine is required")?;
    let workspaces = state
        .store
        .list_workspaces()
        .await
        .map_err(|e| e.to_string())?;
    if workspaces.is_empty() {
        return Err("No workspace is connected yet.".into());
    }
    let rows = state
        .store
        .list_machines()
        .await
        .map_err(|e| e.to_string())?;

    let hint = arg_str(args, "workspace").map(str::to_lowercase);
    let mut candidates: Vec<(Workspace, MachineRow)> = Vec::new();
    for ws in &workspaces {
        if let Some(hint) = &hint {
            let matches = ws.id.to_lowercase() == *hint
                || ws.label.to_lowercase() == *hint
                || ws
                    .org_name
                    .as_deref()
                    .map(|o| o.to_lowercase() == *hint)
                    .unwrap_or(false);
            if !matches {
                continue;
            }
        }
        for row in &rows {
            if row.workspace_id == ws.id && (row.id == machine_ref || row.name == machine_ref) {
                candidates.push((ws.clone(), row.clone()));
            }
        }
    }

    match candidates.len() {
        0 => Err(format!("No machine matches \"{machine_ref}\".")),
        1 => Ok(candidates.remove(0)),
        _ => Err(format!(
            "\"{machine_ref}\" is ambiguous across workspaces: {}",
            candidates
                .iter()
                .map(|(w, _)| w.label.as_str())
                .collect::<Vec<_>>()
                .join(", ")
        )),
    }
}

pub async fn handle(state: &SharedState, request: &Value) -> Option<Value> {
    let id = request.get("id").cloned();
    let method = request.get("method").and_then(Value::as_str).unwrap_or("");
    let is_notification = id.is_none();

    let result: Result<Value, (i64, String)> = match method {
        "initialize" => {
            let requested = request
                .get("params")
                .and_then(|p| p.get("protocolVersion"))
                .and_then(Value::as_str)
                .unwrap_or(PROTOCOL_VERSION);
            let version = match requested {
                "2024-11-05" | "2025-03-26" | "2025-06-18" => requested,
                _ => PROTOCOL_VERSION,
            };
            Ok(json!({
                "protocolVersion": version,
                "capabilities": {
                    "tools": { "listChanged": false }
                },
                "serverInfo": {
                    "name": "vmdash",
                    "title": "vmdash fleet control plane",
                    "version": env!("CARGO_PKG_VERSION")
                },
                "instructions": "Controls InstaBox machines across every connected workspace. Machines are identified by id or name. Use list_workspaces first when more than one workspace is connected."
            }))
        }
        "ping" => Ok(json!({})),
        "tools/list" => Ok(json!({ "tools": tools() })),
        "resources/list" => Ok(json!({ "resources": [] })),
        "resources/templates/list" => Ok(json!({ "resourceTemplates": [] })),
        "prompts/list" => Ok(json!({ "prompts": [] })),
        "tools/call" => {
            let params = request.get("params").cloned().unwrap_or(json!({}));
            let name = params.get("name").and_then(Value::as_str).unwrap_or("");
            let args = params.get("arguments").cloned().unwrap_or(json!({}));
            Ok(call_tool(state, name, &args).await)
        }
        "notifications/initialized" | "notifications/cancelled" => return None,
        other => Err((-32601, format!("Method not found: {other}"))),
    };

    if is_notification {
        return None;
    }

    let id = id.unwrap_or(Value::Null);
    Some(match result {
        Ok(result) => json!({ "jsonrpc": "2.0", "id": id, "result": result }),
        Err((code, message)) => json!({
            "jsonrpc": "2.0",
            "id": id,
            "error": { "code": code, "message": message }
        }),
    })
}

async fn call_tool(state: &SharedState, name: &str, args: &Value) -> Value {
    match name {
        "list_workspaces" => {
            let workspaces = match state.store.list_workspaces().await {
                Ok(w) => w,
                Err(e) => return error_result(e.to_string()),
            };
            let items: Vec<Value> = workspaces
                .iter()
                .map(|w| {
                    let cost = w
                        .usage_json
                        .as_deref()
                        .and_then(|s| serde_json::from_str::<Value>(s).ok())
                        .and_then(|u| u.get("cost").and_then(|c| c.get("costUSD")).and_then(Value::as_f64));
                    json!({
                        "workspaceId": w.id,
                        "label": w.label,
                        "org": w.org_name,
                        "orgId": w.org_id,
                        "tier": w.tier,
                        "machines": w.machine_count,
                        "costUSD": cost,
                        "lastSyncedAt": w.last_synced_at,
                        "lastError": w.last_error,
                    })
                })
                .collect();
            text_result(&json!({ "workspaces": items }))
        }
        "list_machines" => {
            let workspaces = match state.store.list_workspaces().await {
                Ok(w) => w,
                Err(e) => return error_result(e.to_string()),
            };
            let rows = match state.store.list_machines().await {
                Ok(r) => r,
                Err(e) => return error_result(e.to_string()),
            };
            let status = arg_str(args, "status").unwrap_or("all");
            let query = arg_str(args, "query").map(str::to_lowercase);
            let workspace_filter = arg_str(args, "workspace").map(str::to_lowercase);

            let mut items = Vec::new();
            for row in &rows {
                if status != "all" {
                    let matches = if status == "paused" {
                        row.state == "suspended"
                    } else {
                        row.state == status
                    };
                    if !matches {
                        continue;
                    }
                }
                if let Some(q) = &query {
                    if !row.name.to_lowercase().contains(q) && !row.id.to_lowercase().contains(q) {
                        continue;
                    }
                }
                if let Some(w) = &workspace_filter {
                    let ws = workspaces.iter().find(|x| x.id == row.workspace_id);
                    let matches = row.workspace_id.to_lowercase() == *w
                        || ws
                            .map(|x| {
                                x.label.to_lowercase() == *w
                                    || x.org_name.as_deref().map(|o| o.to_lowercase() == *w).unwrap_or(false)
                            })
                            .unwrap_or(false);
                    if !matches {
                        continue;
                    }
                }
                let ws = workspaces.iter().find(|x| x.id == row.workspace_id);
                items.push(row.to_json(ws));
            }
            text_result(&json!({ "machines": items, "count": items.len() }))
        }
        "get_machine" => match find_machine(state, args).await {
            Ok((ws, row)) => {
                let key = match state.key_for(&ws).await {
                    Ok(k) => k,
                    Err(e) => return api_error(e),
                };
                match state.ib.get_machine(&key, &row.id).await {
                    Ok(machine) => text_result(&machine),
                    Err(e) => api_error(e),
                }
            }
            Err(e) => error_result(e),
        },
        "create_machine" => {
            let ws = match find_workspace(state, args).await {
                Ok(w) => w,
                Err(e) => return error_result(e),
            };
            let key = match state.key_for(&ws).await {
                Ok(k) => k,
                Err(e) => return api_error(e),
            };

            let mut payload = serde_json::Map::new();
            if let Some(name) = arg_str(args, "name") {
                payload.insert("name".into(), json!(name));
            }
            payload.insert(
                "templateId".into(),
                json!(arg_str(args, "template").unwrap_or("agent-browser")),
            );
            if let (Some(v), Some(m)) = (
                args.get("vcpus").and_then(Value::as_i64),
                args.get("mem_mib").and_then(Value::as_i64),
            ) {
                payload.insert("vcpus".into(), json!(v));
                payload.insert("memMiB".into(), json!(m));
            }
            if let Some(minutes) = args.get("idle_pause_minutes").and_then(Value::as_i64) {
                payload.insert("autoSuspendAfterSeconds".into(), json!(minutes * 60));
            }
            if let Some(meta) = args.get("metadata").filter(|m| m.is_object()) {
                payload.insert("metadata".into(), meta.clone());
            }

            let idem = new_idempotency_key();
            match state.ib.create_machine(&key, Value::Object(payload), &idem).await {
                Ok(op) => {
                    let op_id = op
                        .get("id")
                        .and_then(Value::as_str)
                        .map(str::to_string)
                        .unwrap_or_else(|| idem.clone());
                    let machine_id = op.get("machineId").and_then(Value::as_str).map(str::to_string);
                    let _ = state
                        .store
                        .upsert_operation(
                            &op_id,
                            &ws.id,
                            machine_id.as_deref(),
                            "machine.create",
                            op.get("state").and_then(Value::as_str).unwrap_or("queued"),
                            None,
                        )
                        .await;
                    let _ = state
                        .store
                        .audit(Some(&ws.id), machine_id.as_deref(), "machine.create", None, true)
                        .await;
                    crate::api::spawn_operation_watch(state.clone(), ws.id.clone(), op_id);
                    text_result(&op)
                }
                Err(e) => api_error(e),
            }
        }
        "machine_action" => {
            let action = arg_str(args, "action").unwrap_or("");
            if !["start", "stop", "suspend", "pause", "resume"].contains(&action) {
                return error_result("action must be start, stop, suspend or resume");
            }
            match find_machine(state, args).await {
                Ok((ws, row)) => {
                    let key = match state.key_for(&ws).await {
                        Ok(k) => k,
                        Err(e) => return api_error(e),
                    };
                    let api_action = if action == "pause" { "suspend" } else { action };
                    match state.ib.action(&key, &row.id, api_action).await {
                        Ok(op) => {
                            let op_id = op
                                .get("id")
                                .and_then(Value::as_str)
                                .map(str::to_string)
                                .unwrap_or_else(new_idempotency_key);
                            let _ = state
                                .store
                                .upsert_operation(
                                    &op_id,
                                    &ws.id,
                                    Some(&row.id),
                                    &format!("machine.{api_action}"),
                                    op.get("state").and_then(Value::as_str).unwrap_or("queued"),
                                    None,
                                )
                                .await;
                            let _ = state
                                .store
                                .audit(
                                    Some(&ws.id),
                                    Some(&row.id),
                                    &format!("machine.{api_action}"),
                                    Some(&row.name),
                                    true,
                                )
                                .await;
                            crate::api::spawn_operation_watch(state.clone(), ws.id.clone(), op_id);
                            text_result(&op)
                        }
                        Err(e) => api_error(e),
                    }
                }
                Err(e) => error_result(e),
            }
        }
        "delete_machine" => {
            let confirm = arg_str(args, "confirm").unwrap_or("");
            match find_machine(state, args).await {
                Ok((ws, row)) => {
                    if confirm != row.id && confirm != row.name {
                        return error_result(
                            "confirm must be the machine's exact id or name; nothing was deleted",
                        );
                    }
                    let key = match state.key_for(&ws).await {
                        Ok(k) => k,
                        Err(e) => return api_error(e),
                    };
                    match state.ib.action(&key, &row.id, "delete").await {
                        Ok(op) => {
                            let _ = state
                                .store
                                .audit(
                                    Some(&ws.id),
                                    Some(&row.id),
                                    "machine.delete",
                                    Some(&row.name),
                                    true,
                                )
                                .await;
                            let op_id = op
                                .get("id")
                                .and_then(Value::as_str)
                                .map(str::to_string);
                            if let Some(op_id) = op_id {
                                crate::api::spawn_operation_watch(state.clone(), ws.id.clone(), op_id);
                            }
                            text_result(&op)
                        }
                        Err(e) => api_error(e),
                    }
                }
                Err(e) => error_result(e),
            }
        }
        "exec" => {
            let cmd = arg_str(args, "cmd").unwrap_or("");
            if cmd.is_empty() {
                return error_result("cmd is required");
            }
            let timeout = args
                .get("timeout_seconds")
                .and_then(Value::as_u64)
                .unwrap_or(60)
                .clamp(1, 600);
            match find_machine(state, args).await {
                Ok((ws, row)) => {
                    let key = match state.key_for(&ws).await {
                        Ok(k) => k,
                        Err(e) => return api_error(e),
                    };
                    match state.ib.exec(&key, &row.id, cmd, timeout).await {
                        Ok(result) => {
                            let _ = state
                                .store
                                .audit(
                                    Some(&ws.id),
                                    Some(&row.id),
                                    "machine.exec",
                                    Some(&cmd.chars().take(240).collect::<String>()),
                                    true,
                                )
                                .await;
                            text_result(&result)
                        }
                        Err(e) => api_error(e),
                    }
                }
                Err(e) => error_result(e),
            }
        }
        "get_usage" => {
            let workspaces = match state.store.list_workspaces().await {
                Ok(w) => w,
                Err(e) => return error_result(e.to_string()),
            };
            let filter = arg_str(args, "workspace").map(str::to_lowercase);
            let mut items = Vec::new();
            for ws in workspaces {
                if let Some(f) = &filter {
                    let matches = ws.id.to_lowercase() == *f
                        || ws.label.to_lowercase() == *f
                        || ws.org_name.as_deref().map(|o| o.to_lowercase() == *f).unwrap_or(false);
                    if !matches {
                        continue;
                    }
                }
                let usage = ws
                    .usage_json
                    .as_deref()
                    .and_then(|s| serde_json::from_str::<Value>(s).ok())
                    .unwrap_or(Value::Null);
                let stored_gib = usage
                    .get("storedBytes")
                    .and_then(Value::as_f64)
                    .map(|bytes| (bytes / 1_073_741_824.0 * 10.0).round() / 10.0);
                let compact = json!({
                    "workspaceId": ws.id,
                    "label": ws.label,
                    "org": ws.org_name,
                    "tier": ws.tier,
                    "machines": usage.get("machines"),
                    "snapshots": usage.get("snapshots"),
                    "storedGiB": stored_gib,
                    "costUSD": usage.get("cost").and_then(|c| c.get("costUSD")),
                    "allowanceUSD": usage.get("cost").and_then(|c| c.get("allowanceUSD")),
                    "limits": usage.get("limits"),
                });
                items.push(compact);
            }
            text_result(&json!({ "workspaces": items }))
        }
        "files" => {
            let op = arg_str(args, "op").unwrap_or("list");
            let (ws, row) = match find_machine(state, args).await {
                Ok(value) => value,
                Err(e) => return error_result(e),
            };
            let key = match state.key_for(&ws).await {
                Ok(k) => k,
                Err(e) => return api_error(e),
            };
            let path = arg_str(args, "path").unwrap_or("/data/home");
            match op {
                "list" | "read" => match state.ib.list_files(&key, &row.id, path).await {
                    Ok(value) => text_result(&value),
                    Err(e) => api_error(e),
                },
                "write" => {
                    let content = match arg_str(args, "content") {
                        Some(content) => content.to_string(),
                        None => return error_result("content is required for op=write"),
                    };
                    let body = reqwest::Body::from(content);
                    match state
                        .ib
                        .upload_file_stream(
                            &key,
                            &row.id,
                            path,
                            body,
                            arg_str(args, "mode"),
                            args.get("parents").and_then(Value::as_bool).unwrap_or(false),
                        )
                        .await
                    {
                        Ok(value) => {
                            let _ = state
                                .store
                                .audit(
                                    Some(&ws.id),
                                    Some(&row.id),
                                    "machine.file.write",
                                    Some(path),
                                    true,
                                )
                                .await;
                            text_result(&value)
                        }
                        Err(e) => api_error(e),
                    }
                }
                other => error_result(format!("unknown files op: {other}")),
            }
        }
        "ssh_token" => match find_machine(state, args).await {
            Ok((ws, row)) => {
                let key = match state.key_for(&ws).await {
                    Ok(k) => k,
                    Err(e) => return api_error(e),
                };
                let ttl = args.get("ttl_seconds").and_then(Value::as_u64);
                match state
                    .ib
                    .ssh_token_create(&key, &row.id, arg_str(args, "name"), ttl)
                    .await
                {
                    Ok(value) => {
                        let _ = state
                            .store
                            .audit(
                                Some(&ws.id),
                                Some(&row.id),
                                "machine.ssh_token",
                                Some(&row.name),
                                true,
                            )
                            .await;
                        text_result(&value)
                    }
                    Err(e) => api_error(e),
                }
            }
            Err(e) => error_result(e),
        },
        "desktop" => {
            let op = arg_str(args, "op").unwrap_or("status");
            match find_machine(state, args).await {
                Ok((ws, row)) => {
                    let key = match state.key_for(&ws).await {
                        Ok(k) => k,
                        Err(e) => return api_error(e),
                    };
                    match op {
                        "status" => match state.ib.desktop(&key, &row.id, "status", None, None).await {
                            Ok(value) => text_result(&value),
                            Err(e) => api_error(e),
                        },
                        "install" => match state.ib.desktop(&key, &row.id, "install", None, None).await {
                            Ok(value) => text_result(&value),
                            Err(e) => api_error(e),
                        },
                        "start" => match state
                            .ib
                            .desktop(&key, &row.id, "start", Some(1280), Some(800))
                            .await
                        {
                            Ok(value) => text_result(&value),
                            Err(e) => api_error(e),
                        },
                        "link" => match state
                            .ib
                            .desktop_stream(
                                &key,
                                &row.id,
                                args.get("view_only").and_then(Value::as_bool).unwrap_or(true),
                                args.get("ttl_seconds").and_then(Value::as_u64),
                            )
                            .await
                        {
                            Ok(value) => text_result(&value),
                            Err(e) => api_error(e),
                        },
                        other => error_result(format!("unknown desktop op: {other}")),
                    }
                }
                Err(e) => error_result(e),
            }
        }
        "ports" => {
            let op = arg_str(args, "op").unwrap_or("list");
            match find_machine(state, args).await {
                Ok((ws, row)) => {
                    let key = match state.key_for(&ws).await {
                        Ok(k) => k,
                        Err(e) => return api_error(e),
                    };
                    match op {
                        "list" => match state.ib.ports(&key, &row.id).await {
                            Ok(value) => text_result(&value),
                            Err(e) => api_error(e),
                        },
                        "publish" => {
                            let Some(port) = args.get("port").and_then(Value::as_u64) else {
                                return error_result("port is required for op=publish");
                            };
                            let mut payload = serde_json::Map::new();
                            payload.insert("port".into(), json!(port));
                            if let Some(access) = arg_str(args, "access") {
                                payload.insert("access".into(), json!(access));
                            }
                            if let Some(protocol) = arg_str(args, "protocol") {
                                payload.insert("protocol".into(), json!(protocol));
                            }
                            if let Some(name) = arg_str(args, "name") {
                                payload.insert("name".into(), json!(name));
                            }
                            match state
                                .ib
                                .port_publish(&key, &row.id, Value::Object(payload))
                                .await
                            {
                                Ok(value) => text_result(&value),
                                Err(e) => api_error(e),
                            }
                        }
                        "unpublish" => {
                            let Some(port) = args.get("port").and_then(Value::as_u64) else {
                                return error_result("port is required for op=unpublish");
                            };
                            match state.ib.port_unpublish(&key, &row.id, port as u16).await {
                                Ok(_) => text_result(&json!({ "ok": true, "port": port })),
                                Err(e) => api_error(e),
                            }
                        }
                        other => error_result(format!("unknown ports op: {other}")),
                    }
                }
                Err(e) => error_result(e),
            }
        }
        "snapshots" => {
            let op = arg_str(args, "op").unwrap_or("list");
            match op {
                "list" => {
                    let ws = match find_workspace(state, args).await {
                        Ok(ws) => ws,
                        Err(e) => return error_result(e),
                    };
                    let key = match state.key_for(&ws).await {
                        Ok(k) => k,
                        Err(e) => return api_error(e),
                    };
                    match state.ib.snapshots(&key).await {
                        Ok(value) => text_result(&value),
                        Err(e) => api_error(e),
                    }
                }
                "create" => match find_machine(state, args).await {
                    Ok((ws, row)) => {
                        let key = match state.key_for(&ws).await {
                            Ok(k) => k,
                            Err(e) => return api_error(e),
                        };
                        let name = match arg_str(args, "name") {
                            Some(name) => name,
                            None => return error_result("name is required for op=create"),
                        };
                        match state
                            .ib
                            .snapshot_create(
                                &key,
                                &row.id,
                                name,
                                arg_str(args, "description"),
                                args.get("root_only").and_then(Value::as_bool).unwrap_or(false),
                                args.get("for_fork").and_then(Value::as_bool).unwrap_or(false),
                            )
                            .await
                        {
                            Ok(value) => text_result(&value),
                            Err(e) => api_error(e),
                        }
                    }
                    Err(e) => error_result(e),
                },
                "delete" => {
                    let ws = match find_workspace(state, args).await {
                        Ok(ws) => ws,
                        Err(e) => return error_result(e),
                    };
                    let key = match state.key_for(&ws).await {
                        Ok(k) => k,
                        Err(e) => return api_error(e),
                    };
                    let Some(snapshot) = arg_str(args, "snapshot") else {
                        return error_result("snapshot is required for op=delete");
                    };
                    match state.ib.snapshot_delete(&key, snapshot).await {
                        Ok(_) => text_result(&json!({ "ok": true, "snapshot": snapshot })),
                        Err(e) => api_error(e),
                    }
                }
                "restore" => match find_machine(state, args).await {
                    Ok((ws, row)) => {
                        let key = match state.key_for(&ws).await {
                            Ok(k) => k,
                            Err(e) => return api_error(e),
                        };
                        let Some(snapshot) = arg_str(args, "snapshot") else {
                            return error_result("snapshot is required for op=restore");
                        };
                        let desired = if args
                            .get("start_after_restore")
                            .and_then(Value::as_bool)
                            .unwrap_or(false)
                        {
                            Some("running")
                        } else {
                            None
                        };
                        match state.ib.restore(&key, &row.id, snapshot, desired).await {
                            Ok(op) => {
                                let st = state.clone();
                                crate::api::track_operation(&st, &ws.id, &op, "machine.restore");
                                text_result(&op)
                            }
                            Err(e) => api_error(e),
                        }
                    }
                    Err(e) => error_result(e),
                },
                other => error_result(format!("unknown snapshots op: {other}")),
            }
        }
        "fork_machine" => match find_machine(state, args).await {
            Ok((ws, row)) => {
                let key = match state.key_for(&ws).await {
                    Ok(k) => k,
                    Err(e) => return api_error(e),
                };
                let mut payload = serde_json::Map::new();
                if let Some(name) = arg_str(args, "name") {
                    payload.insert("name".into(), json!(name));
                }
                if let (Some(v), Some(m)) = (
                    args.get("vcpus").and_then(Value::as_i64),
                    args.get("mem_mib").and_then(Value::as_i64),
                ) {
                    payload.insert("vcpus".into(), json!(v));
                    payload.insert("memMiB".into(), json!(m));
                }
                if let Some(minutes) = args.get("idle_pause_minutes").and_then(Value::as_i64) {
                    payload.insert("autoSuspendAfterSeconds".into(), json!(minutes * 60));
                }
                match state.ib.fork(&key, &row.id, Value::Object(payload)).await {
                    Ok(op) => {
                        let st = state.clone();
                        crate::api::track_operation(&st, &ws.id, &op, "machine.fork");
                        text_result(&op)
                    }
                    Err(e) => api_error(e),
                }
            }
            Err(e) => error_result(e),
        },
        "resize_machine" => match find_machine(state, args).await {
            Ok((ws, row)) => {
                let key = match state.key_for(&ws).await {
                    Ok(k) => k,
                    Err(e) => return api_error(e),
                };
                let mut payload = serde_json::Map::new();
                if let Some(name) = arg_str(args, "name") {
                    payload.insert("name".into(), json!(name));
                }
                if let Some(v) = args.get("vcpus").and_then(Value::as_i64) {
                    payload.insert("vcpus".into(), json!(v));
                }
                if let Some(m) = args.get("mem_mib").and_then(Value::as_i64) {
                    payload.insert("memMiB".into(), json!(m));
                }
                if let Some(d) = args.get("disk_gib").and_then(Value::as_i64) {
                    payload.insert("persistentDiskGiB".into(), json!(d));
                }
                if let Some(minutes) = args.get("idle_pause_minutes").and_then(Value::as_i64) {
                    payload.insert("autoSuspendAfterSeconds".into(), json!(minutes * 60));
                }
                if let Some(max_run) = args.get("max_run_minutes").and_then(Value::as_i64) {
                    payload.insert("maxRunMinutes".into(), json!(max_run));
                }
                if let Some(metadata) = args.get("metadata").filter(|m| m.is_object()) {
                    payload.insert("metadata".into(), metadata.clone());
                }
                if payload.is_empty() {
                    return error_result("nothing to change");
                }
                match state
                    .ib
                    .patch_machine(&key, &row.id, Value::Object(payload))
                    .await
                {
                    Ok(value) => {
                        if value.get("type").is_some() && value.get("state").is_some() {
                            let st = state.clone();
                            crate::api::track_operation(&st, &ws.id, &value, "machine.patch");
                        }
                        text_result(&value)
                    }
                    Err(e) => api_error(e),
                }
            }
            Err(e) => error_result(e),
        },
        "metrics" => match find_machine(state, args).await {
            Ok((ws, row)) => {
                let key = match state.key_for(&ws).await {
                    Ok(k) => k,
                    Err(e) => return api_error(e),
                };
                match state
                    .ib
                    .metrics(&key, &row.id, arg_str(args, "since"))
                    .await
                {
                    Ok(value) => text_result(&value),
                    Err(e) => api_error(e),
                }
            }
            Err(e) => error_result(e),
        },
        "logs" => match find_machine(state, args).await {
            Ok((ws, row)) => {
                let key = match state.key_for(&ws).await {
                    Ok(k) => k,
                    Err(e) => return api_error(e),
                };
                let tail = args
                    .get("tail")
                    .and_then(Value::as_u64)
                    .map(|v| v as u32)
                    .or(Some(300));
                match state.ib.logs(&key, &row.id, tail).await {
                    Ok(value) => text_result(&value),
                    Err(e) => api_error(e),
                }
            }
            Err(e) => error_result(e),
        },
        "history" => match find_machine(state, args).await {
            Ok((ws, row)) => {
                let key = match state.key_for(&ws).await {
                    Ok(k) => k,
                    Err(e) => return api_error(e),
                };
                let limit = args
                    .get("limit")
                    .and_then(Value::as_u64)
                    .unwrap_or(30)
                    .clamp(1, 100) as u32;
                match state.ib.history(&key, &row.id, limit).await {
                    Ok(value) => text_result(&value),
                    Err(e) => api_error(e),
                }
            }
            Err(e) => error_result(e),
        },
        "secrets" => {
            let op = arg_str(args, "op").unwrap_or("list");
            match op {
                "list" | "set" | "delete" => {
                    let ws = match find_workspace(state, args).await {
                        Ok(ws) => ws,
                        Err(e) => return error_result(e),
                    };
                    let Some(org_id) = ws.org_id.clone() else {
                        return error_result("This workspace has no org id; sync it first.");
                    };
                    let key = match state.key_for(&ws).await {
                        Ok(k) => k,
                        Err(e) => return api_error(e),
                    };
                    match op {
                        "list" => match state.ib.org_secrets(&key, &org_id).await {
                            Ok(value) => text_result(&value),
                            Err(e) => api_error(e),
                        },
                        "set" => {
                            let (Some(name), Some(value), Some(delivery)) = (
                                arg_str(args, "name"),
                                arg_str(args, "value"),
                                arg_str(args, "delivery"),
                            ) else {
                                return error_result("name, value and delivery are required");
                            };
                            let hosts = args
                                .get("hosts")
                                .and_then(Value::as_array)
                                .map(|items| {
                                    items
                                        .iter()
                                        .filter_map(Value::as_str)
                                        .map(str::to_string)
                                        .collect::<Vec<_>>()
                                });
                            match state
                                .ib
                                .org_secret_put(&key, &org_id, name, value, delivery, hosts)
                                .await
                            {
                                Ok(value) => text_result(&value),
                                Err(e) => api_error(e),
                            }
                        }
                        "delete" => {
                            let Some(name) = arg_str(args, "name") else {
                                return error_result("name is required");
                            };
                            match state.ib.org_secret_delete(&key, &org_id, name).await {
                                Ok(_) => text_result(&json!({ "ok": true, "name": name })),
                                Err(e) => api_error(e),
                            }
                        }
                        _ => unreachable!(),
                    }
                }
                "machine" | "select" | "refresh" => match find_machine(state, args).await {
                    Ok((ws, row)) => {
                        let key = match state.key_for(&ws).await {
                            Ok(k) => k,
                            Err(e) => return api_error(e),
                        };
                        match op {
                            "machine" => match state.ib.machine_secrets(&key, &row.id).await {
                                Ok(value) => text_result(&value),
                                Err(e) => api_error(e),
                            },
                            "refresh" => match state.ib.machine_secrets_refresh(&key, &row.id).await {
                                Ok(value) => text_result(&value),
                                Err(e) => api_error(e),
                            },
                            "select" => {
                                let mut payload = serde_json::Map::new();
                                if let Some(secrets) = args.get("secrets") {
                                    payload.insert("secrets".into(), secrets.clone());
                                }
                                if let Some(env) = args.get("env_secrets").and_then(Value::as_array) {
                                    payload.insert("envSecrets".into(), Value::Array(env.clone()));
                                }
                                if payload.is_empty() {
                                    return error_result("secrets or env_secrets is required");
                                }
                                match state
                                    .ib
                                    .machine_secrets_patch(&key, &row.id, Value::Object(payload))
                                    .await
                                {
                                    Ok(value) => text_result(&value),
                                    Err(e) => api_error(e),
                                }
                            }
                            _ => unreachable!(),
                        }
                    }
                    Err(e) => error_result(e),
                },
                other => error_result(format!("unknown secrets op: {other}")),
            }
        }
        "webhooks" => {
            let op = arg_str(args, "op").unwrap_or("list");
            let ws = match find_workspace(state, args).await {
                Ok(ws) => ws,
                Err(e) => return error_result(e),
            };
            let Some(org_id) = ws.org_id.clone() else {
                return error_result("This workspace has no org id; sync it first.");
            };
            let key = match state.key_for(&ws).await {
                Ok(k) => k,
                Err(e) => return api_error(e),
            };
            let webhook_id = arg_str(args, "webhook");
            let result = match op {
                "list" => state.ib.webhooks(&key, &org_id).await,
                "create" => {
                    let (Some(url), Some(events)) = (
                        arg_str(args, "url"),
                        args.get("events").and_then(Value::as_array),
                    ) else {
                        return error_result("url and events are required");
                    };
                    let mut payload = serde_json::Map::new();
                    payload.insert("url".into(), json!(url));
                    payload.insert("events".into(), Value::Array(events.clone()));
                    if let Some(description) = arg_str(args, "description") {
                        payload.insert("description".into(), json!(description));
                    }
                    if let Some(enabled) = args.get("enabled").and_then(Value::as_bool) {
                        payload.insert("enabled".into(), json!(enabled));
                    }
                    state
                        .ib
                        .webhook_create(&key, &org_id, Value::Object(payload))
                        .await
                }
                "update" => {
                    let Some(webhook_id) = webhook_id else {
                        return error_result("webhook id is required");
                    };
                    let mut payload = serde_json::Map::new();
                    if let Some(url) = arg_str(args, "url") {
                        payload.insert("url".into(), json!(url));
                    }
                    if let Some(events) = args.get("events").and_then(Value::as_array) {
                        payload.insert("events".into(), Value::Array(events.clone()));
                    }
                    if let Some(description) = arg_str(args, "description") {
                        payload.insert("description".into(), json!(description));
                    }
                    if let Some(enabled) = args.get("enabled").and_then(Value::as_bool) {
                        payload.insert("enabled".into(), json!(enabled));
                    }
                    state
                        .ib
                        .webhook_update(&key, &org_id, webhook_id, Value::Object(payload))
                        .await
                }
                "delete" => {
                    let Some(webhook_id) = webhook_id else {
                        return error_result("webhook id is required");
                    };
                    match state.ib.webhook_delete(&key, &org_id, webhook_id).await {
                        Ok(_) => Ok(json!({ "ok": true, "webhook": webhook_id })),
                        Err(e) => Err(e),
                    }
                }
                "rotate" => {
                    let Some(webhook_id) = webhook_id else {
                        return error_result("webhook id is required");
                    };
                    state.ib.webhook_rotate(&key, &org_id, webhook_id).await
                }
                "test" => {
                    let Some(webhook_id) = webhook_id else {
                        return error_result("webhook id is required");
                    };
                    state.ib.webhook_test(&key, &org_id, webhook_id).await
                }
                "deliveries" => {
                    let Some(webhook_id) = webhook_id else {
                        return error_result("webhook id is required");
                    };
                    state
                        .ib
                        .webhook_deliveries(&key, &org_id, webhook_id, 50)
                        .await
                }
                other => return error_result(format!("unknown webhooks op: {other}")),
            };
            match result {
                Ok(value) => {
                    if matches!(op, "create" | "rotate") {
                        crate::extras::store_webhook_secret(state, &ws.id, &value).await;
                    }
                    text_result(&value)
                }
                Err(e) => api_error(e),
            }
        }
        "bulk_action" => {
            let action = arg_str(args, "action").unwrap_or("");
            let refs = match args.get("machines").and_then(Value::as_array) {
                Some(values) if !values.is_empty() && values.len() <= 50 => values,
                _ => return error_result("machines must contain 1-50 machine ids or names"),
            };

            let mut resolved: Vec<(Workspace, MachineRow)> = Vec::new();
            let mut unresolved: Vec<String> = Vec::new();
            for reference in refs {
                let Some(reference) = reference.as_str() else {
                    unresolved.push("(not a string)".into());
                    continue;
                };
                let mut query = json!({ "machine": reference });
                if let Some(workspace) = arg_str(args, "workspace") {
                    query["workspace"] = json!(workspace);
                }
                match find_machine(state, &query).await {
                    Ok(found) => resolved.push(found),
                    Err(err) => unresolved.push(format!("{reference}: {err}")),
                }
            }
            if !unresolved.is_empty() {
                return error_result(format!(
                    "Could not resolve every machine, nothing was run:\n{}",
                    unresolved.join("\n")
                ));
            }

            let mut seen = std::collections::HashSet::new();
            let mut items: Vec<BulkItem> = Vec::new();
            for (workspace, machine) in resolved {
                if seen.insert(format!("{}:{}", workspace.id, machine.id)) {
                    items.push(BulkItem {
                        workspace_id: workspace.id,
                        machine_id: machine.id,
                    });
                }
            }
            if items.is_empty() {
                return error_result("No machines to act on");
            }

            if action == "delete" {
                if arg_str(args, "confirm") != Some("delete") {
                    return error_result(
                        "Bulk delete requires confirm=\"delete\" and count equal to the resolved machine count",
                    );
                }
                let count = args.get("count").and_then(Value::as_u64);
                if count != Some(items.len() as u64) {
                    return error_result(format!(
                        "Bulk delete requires count={} (the number of resolved machines)",
                        items.len()
                    ));
                }
            }

            match execute_bulk(state, action, &items, arg_str(args, "confirm")).await {
                Ok(result) => text_result(&result),
                Err(err) => api_error(err),
            }
        }
        other => error_result(format!("Unknown tool: {other}")),
    }
}

pub async fn mcp_get() -> (axum::http::StatusCode, Json<Value>) {
    (
        axum::http::StatusCode::METHOD_NOT_ALLOWED,
        Json(json!({
            "jsonrpc": "2.0",
            "error": { "code": -32000, "message": "This MCP server is sessionless: POST JSON-RPC to /mcp." }
        })),
    )
}

pub async fn mcp_http(
    axum::extract::State(state): axum::extract::State<SharedState>,
    body: axum::body::Bytes,
) -> axum::response::Response {
    use axum::response::IntoResponse;

    let parsed: Result<Value, _> = serde_json::from_slice(&body);
    let request = match parsed {
        Ok(v) => v,
        Err(_) => {
            return (
                axum::http::StatusCode::BAD_REQUEST,
                Json(json!({
                    "jsonrpc": "2.0",
                    "id": null,
                    "error": { "code": -32700, "message": "Parse error" }
                })),
            )
                .into_response()
        }
    };

    match request {
        Value::Array(items) => {
            let mut responses = Vec::new();
            for item in items {
                if let Some(resp) = handle(&state, &item).await {
                    responses.push(resp);
                }
            }
            if responses.is_empty() {
                axum::http::StatusCode::ACCEPTED.into_response()
            } else {
                Json(Value::Array(responses)).into_response()
            }
        }
        single => match handle(&state, &single).await {
            Some(resp) => Json(resp).into_response(),
            None => axum::http::StatusCode::ACCEPTED.into_response(),
        },
    }
}

pub async fn run_stdio(state: SharedState) -> anyhow::Result<()> {
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

    let stdin = tokio::io::stdin();
    let mut lines = BufReader::new(stdin).lines();
    let mut stdout = tokio::io::stdout();

    while let Some(line) = lines.next_line().await? {
        if line.trim().is_empty() {
            continue;
        }
        let request: Value = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(e) => {
                let resp = json!({
                    "jsonrpc": "2.0",
                    "id": null,
                    "error": { "code": -32700, "message": format!("Parse error: {e}") }
                });
                stdout.write_all(format!("{resp}\n").as_bytes()).await?;
                stdout.flush().await?;
                continue;
            }
        };

        let responses: Vec<Value> = match request {
            Value::Array(items) => {
                let mut out = Vec::new();
                for item in items {
                    if let Some(r) = handle(&state, &item).await {
                        out.push(r);
                    }
                }
                out
            }
            single => handle(&state, &single).await.into_iter().collect(),
        };

        for resp in responses {
            stdout.write_all(format!("{resp}\n").as_bytes()).await?;
        }
        stdout.flush().await?;
    }
    Ok(())
}

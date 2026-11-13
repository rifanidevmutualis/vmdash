use std::convert::Infallible;
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::sse::{Event as SseEvent, KeepAlive, Sse};
use axum::response::{IntoResponse, Response};
use axum::Json;
use futures::StreamExt;
use serde::Deserialize;
use serde_json::{json, Value};
use tokio_stream::wrappers::BroadcastStream;

use crate::crypto;
use crate::instabox::{new_idempotency_key, ApiError};
use crate::state::SharedState;
use crate::store::{now, Workspace};
use crate::sync::{sync_all, sync_one};

pub struct ApiErr {
    status: StatusCode,
    code: String,
    message: String,
    extra: Value,
}

impl ApiErr {
    pub(crate) fn new(status: StatusCode, code: &str, message: impl Into<String>) -> Self {
        Self {
            status,
            code: code.into(),
            message: message.into(),
            extra: Value::Null,
        }
    }
}

impl IntoResponse for ApiErr {
    fn into_response(self) -> Response {
        let mut error = json!({
            "code": self.code,
            "message": self.message,
        });
        if let (Some(obj), Some(extra)) = (error.as_object_mut(), self.extra.as_object()) {
            for (k, v) in extra {
                obj.insert(k.clone(), v.clone());
            }
        }
        (self.status, Json(json!({ "error": error }))).into_response()
    }
}

impl From<ApiError> for ApiErr {
    fn from(err: ApiError) -> Self {
        let status = err
            .status
            .and_then(|s| StatusCode::from_u16(s).ok())
            .unwrap_or(StatusCode::BAD_GATEWAY);
        Self {
            status,
            code: err.code,
            message: err.message,
            extra: json!({
                "retryable": err.retryable,
                "retryAfterSeconds": err.retry_after_seconds,
                "requiredScopes": err.required_scopes,
            }),
        }
    }
}

impl From<anyhow::Error> for ApiErr {
    fn from(err: anyhow::Error) -> Self {
        Self::new(StatusCode::INTERNAL_SERVER_ERROR, "internal", err.to_string())
    }
}

impl std::fmt::Debug for ApiErr {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

fn workspace_view(ws: &Workspace) -> Value {
    let mut value = serde_json::to_value(ws).unwrap_or(Value::Null);
    if let Some(obj) = value.as_object_mut() {
        obj.insert(
            "usage".into(),
            ws.usage_json
                .as_deref()
                .and_then(|s| serde_json::from_str::<Value>(s).ok())
                .unwrap_or(Value::Null),
        );
    }
    value
}

pub async fn health() -> Json<Value> {
    Json(json!({
        "ok": true,
        "name": "vmdash",
        "version": env!("CARGO_PKG_VERSION"),
    }))
}

pub async fn list_workspaces(State(state): State<SharedState>) -> Result<Json<Value>, ApiErr> {
    let list = state.store.list_workspaces().await?;
    Ok(Json(json!({
        "workspaces": list.iter().map(workspace_view).collect::<Vec<_>>()
    })))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddWorkspaceBody {
    key: String,
    label: Option<String>,
}

pub async fn add_workspace(
    State(state): State<SharedState>,
    Json(body): Json<AddWorkspaceBody>,
) -> Result<Json<Value>, ApiErr> {
    let key = body.key.trim().to_string();
    if !key.starts_with("ibk_") || key.len() < 20 {
        return Err(ApiErr::new(
            StatusCode::BAD_REQUEST,
            "invalid_key",
            "That does not look like an InstaBox API key. It starts with ibk_.",
        ));
    }

    let fp = crypto::fingerprint(&key);
    if state.store.find_workspace_by_fingerprint(&fp).await?.is_some() {
        return Err(ApiErr::new(
            StatusCode::CONFLICT,
            "duplicate_key",
            "This API key is already in the dashboard.",
        ));
    }

    let me = state.ib.me(&key).await.map_err(|err| {
        ApiErr::new(
            StatusCode::BAD_REQUEST,
            "key_rejected",
            format!("InstaBox rejected this key: {}", err.message),
        )
    })?;

    let org = me.get("org");
    let org_name = org
        .and_then(|o| o.get("name"))
        .and_then(Value::as_str)
        .map(str::to_string);
    let org_id = org
        .and_then(|o| o.get("id"))
        .and_then(Value::as_str)
        .or_else(|| me.get("orgId").and_then(Value::as_str))
        .map(str::to_string);
    let tier = org
        .and_then(|o| o.get("tier"))
        .and_then(Value::as_str)
        .map(str::to_string);
    let login = me
        .get("name")
        .and_then(Value::as_str)
        .or_else(|| me.get("login").and_then(Value::as_str))
        .map(str::to_string);

    let label = body
        .label
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty())
        .or_else(|| org_name.clone())
        .or_else(|| login.clone())
        .unwrap_or_else(|| "workspace".into());

    let id = format!("ws_{}", uuid::Uuid::new_v4().simple());
    let cipher = state
        .vault
        .seal(&key)
        .map_err(|e| ApiErr::new(StatusCode::INTERNAL_SERVER_ERROR, "seal_failed", e.to_string()))?;

    state
        .store
        .insert_workspace(
            &id,
            &label,
            &crypto::hint(&key),
            &cipher,
            &fp,
            org_id.as_deref(),
            org_name.as_deref(),
            tier.as_deref(),
            login.as_deref(),
        )
        .await?;

    state
        .store
        .audit(Some(&id), None, "workspace.add", Some(&label), true)
        .await
        .ok();
    state.emit("workspaces", Some(&id), None);

    let ws = state
        .store
        .get_workspace(&id)
        .await?
        .ok_or_else(|| ApiErr::new(StatusCode::INTERNAL_SERVER_ERROR, "internal", "workspace vanished"))?;

    let st = state.clone();
    tokio::spawn(async move {
        let _ = sync_one(&st, &id).await;
    });

    Ok(Json(json!({ "workspace": workspace_view(&ws) })))
}

pub async fn delete_workspace(
    State(state): State<SharedState>,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiErr> {
    let ws = state.store.get_workspace(&id).await?;
    let Some(ws) = ws else {
        return Err(ApiErr::new(StatusCode::NOT_FOUND, "not_found", "No such workspace"));
    };
    state.store.delete_workspace(&id).await?;
    state
        .store
        .audit(Some(&id), None, "workspace.remove", Some(&ws.label), true)
        .await
        .ok();
    state.emit("workspaces", Some(&id), None);
    Ok(Json(json!({ "ok": true })))
}

pub async fn sync_workspace_now(
    State(state): State<SharedState>,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiErr> {
    let ws = state
        .store
        .get_workspace(&id)
        .await?
        .ok_or_else(|| ApiErr::new(StatusCode::NOT_FOUND, "not_found", "No such workspace"))?;
    let st = state.clone();
    let ws_id = ws.id.clone();
    tokio::spawn(async move {
        let _ = sync_one(&st, &ws_id).await;
    });
    Ok(Json(json!({ "started": true })))
}

pub async fn sync_everything(State(state): State<SharedState>) -> Json<Value> {
    let st = state.clone();
    tokio::spawn(async move {
        sync_all(&st).await;
    });
    Json(json!({ "started": true }))
}

#[derive(Deserialize, Default)]
pub struct FleetQuery {
    pub status: Option<String>,
    pub workspace: Option<String>,
    pub q: Option<String>,
}

pub async fn fleet(
    State(state): State<SharedState>,
    Query(query): Query<FleetQuery>,
) -> Result<Json<Value>, ApiErr> {
    let workspaces = state.store.list_workspaces().await?;
    let machines = state.store.list_machines().await?;

    let by_id: std::collections::HashMap<&str, &Workspace> =
        workspaces.iter().map(|w| (w.id.as_str(), w)).collect();

    let mut running = 0usize;
    let mut paused = 0usize;
    let mut stopped = 0usize;
    let mut errored = 0usize;
    let mut other = 0usize;

    let mut items: Vec<Value> = Vec::new();
    for machine in &machines {
        match machine.state.as_str() {
            "running" => running += 1,
            "suspended" => paused += 1,
            "stopped" => stopped += 1,
            "error" => errored += 1,
            _ => other += 1,
        }

        if let Some(status) = &query.status {
            if !status.is_empty() && status != "all" {
                let matches = match status.as_str() {
                    "paused" => machine.state == "suspended",
                    other => machine.state == other,
                };
                if !matches {
                    continue;
                }
            }
        }
        if let Some(workspace) = &query.workspace {
            if !workspace.is_empty() && workspace != "all" && &machine.workspace_id != workspace {
                continue;
            }
        }
        if let Some(q) = &query.q {
            let needle = q.to_lowercase();
            if !needle.is_empty()
                && !machine.name.to_lowercase().contains(&needle)
                && !machine.id.to_lowercase().contains(&needle)
            {
                continue;
            }
        }

        items.push(machine.to_json(by_id.get(machine.workspace_id.as_str()).copied()));
    }

    let mut spend = 0.0f64;
    let mut per_workspace = Vec::new();
    for ws in &workspaces {
        let usage: Option<Value> = ws
            .usage_json
            .as_deref()
            .and_then(|s| serde_json::from_str(s).ok());
        let cost = usage
            .as_ref()
            .and_then(|u| u.get("cost"))
            .and_then(|c| c.get("costUSD"))
            .and_then(Value::as_f64)
            .unwrap_or(0.0);
        spend += cost;
        per_workspace.push(json!({
            "workspaceId": ws.id,
            "label": ws.label,
            "costUSD": cost,
            "maxMachines": usage.as_ref().and_then(|u| u.get("limits")).and_then(|l| l.get("maxMachines")).cloned().unwrap_or(Value::Null),
            "machines": ws.machine_count,
        }));
    }

    let operations = state.store.list_operations(12).await?;
    let since = now();

    Ok(Json(json!({
        "machines": items,
        "workspaces": workspaces.iter().map(workspace_view).collect::<Vec<_>>(),
        "stats": {
            "total": machines.len(),
            "running": running,
            "paused": paused,
            "stopped": stopped,
            "error": errored,
            "other": other,
        },
        "spend": {
            "monthUSD": spend,
            "workspaces": per_workspace,
        },
        "operations": operations,
        "generatedAt": since,
    })))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActionBody {
    pub action: String,
    pub confirm: Option<String>,
}

pub async fn machine_action(
    State(state): State<SharedState>,
    Path((workspace_id, machine_id)): Path<(String, String)>,
    Json(body): Json<ActionBody>,
) -> Result<Json<Value>, ApiErr> {
    let ws = state
        .store
        .get_workspace(&workspace_id)
        .await?
        .ok_or_else(|| ApiErr::new(StatusCode::NOT_FOUND, "not_found", "No such workspace"))?;
    let machine = state
        .store
        .get_machine(&workspace_id, &machine_id)
        .await?
        .ok_or_else(|| ApiErr::new(StatusCode::NOT_FOUND, "not_found", "No such machine"))?;
    let key = state.key_for(&ws).await?;

    let action = body.action.as_str();
    if !["start", "stop", "suspend", "pause", "resume", "delete"].contains(&action) {
        return Err(ApiErr::new(
            StatusCode::BAD_REQUEST,
            "bad_request",
            "action must be start, stop, suspend, resume or delete",
        ));
    }

    if action == "delete" {
        let confirm = body.confirm.clone().unwrap_or_default();
        if confirm != machine.id && confirm != machine.name {
            return Err(ApiErr::new(
                StatusCode::BAD_REQUEST,
                "delete_confirmation_required",
                "Send the machine name or ID as confirm to delete it.",
            ));
        }
    }

    let result = state.ib.action(&key, &machine.id, action).await;
    match result {
        Ok(op) => {
            let op_id = op
                .get("id")
                .and_then(Value::as_str)
                .map(str::to_string)
                .unwrap_or_else(|| new_idempotency_key());
            state
                .store
                .upsert_operation(
                    &op_id,
                    &workspace_id,
                    Some(&machine.id),
                    &format!("machine.{action}"),
                    op.get("state").and_then(Value::as_str).unwrap_or("queued"),
                    None,
                )
                .await?;
            state
                .store
                .audit(
                    Some(&workspace_id),
                    Some(&machine.id),
                    &format!("machine.{action}"),
                    Some(&machine.name),
                    true,
                )
                .await
                .ok();
            state.emit("operation", Some(&workspace_id), Some(&machine.id));
            spawn_operation_watch(state.clone(), workspace_id.clone(), op_id);
            Ok(Json(json!({ "operation": op })))
        }
        Err(err) => {
            state
                .store
                .audit(
                    Some(&workspace_id),
                    Some(&machine.id),
                    &format!("machine.{action}"),
                    Some(&format!("{}: {}", err.code, err.message)),
                    false,
                )
                .await
                .ok();
            Err(err.into())
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateMachineBody {
    pub workspace_id: String,
    pub name: Option<String>,
    pub template_id: Option<String>,
    pub vcpus: Option<i64>,
    #[serde(rename = "memMiB")]
    pub mem_mib: Option<i64>,
    pub auto_suspend_after_seconds: Option<i64>,
    pub metadata: Option<Value>,
    pub env: Option<std::collections::HashMap<String, String>>,
}

pub async fn create_machine(
    State(state): State<SharedState>,
    Json(body): Json<CreateMachineBody>,
) -> Result<Json<Value>, ApiErr> {
    let ws = state
        .store
        .get_workspace(&body.workspace_id)
        .await?
        .ok_or_else(|| ApiErr::new(StatusCode::NOT_FOUND, "not_found", "No such workspace"))?;
    let key = state.key_for(&ws).await?;

    let mut payload = serde_json::Map::new();
    if let Some(name) = body.name.as_deref().map(str::trim).filter(|n| !n.is_empty()) {
        payload.insert("name".into(), Value::String(name.to_string()));
    }
    if let Some(template) = body.template_id.filter(|t| !t.is_empty()) {
        payload.insert("templateId".into(), Value::String(template));
    }
    if let (Some(vcpus), Some(mem)) = (body.vcpus, body.mem_mib) {
        payload.insert("vcpus".into(), json!(vcpus));
        payload.insert("memMiB".into(), json!(mem));
    }
    if let Some(auto) = body.auto_suspend_after_seconds {
        payload.insert("autoSuspendAfterSeconds".into(), json!(auto));
    }
    if let Some(metadata) = body.metadata {
        if metadata.is_object() && metadata.as_object().map(|m| !m.is_empty()).unwrap_or(false) {
            payload.insert("metadata".into(), metadata);
        }
    }
    if let Some(env) = body.env {
        if !env.is_empty() {
            payload.insert("env".into(), serde_json::to_value(env).unwrap_or(Value::Null));
        }
    }

    let idem = new_idempotency_key();
    let op = state
        .ib
        .create_machine(&key, Value::Object(payload), &idem)
        .await?;

    let op_id = op
        .get("id")
        .and_then(Value::as_str)
        .map(str::to_string)
        .unwrap_or(idem);
    let machine_id = op.get("machineId").and_then(Value::as_str).map(str::to_string);

    state
        .store
        .upsert_operation(
            &op_id,
            &body.workspace_id,
            machine_id.as_deref(),
            "machine.create",
            op.get("state").and_then(Value::as_str).unwrap_or("queued"),
            None,
        )
        .await?;
    state
        .store
        .audit(
            Some(&body.workspace_id),
            machine_id.as_deref(),
            "machine.create",
            body.name.as_deref(),
            true,
        )
        .await
        .ok();
    state.emit("operation", Some(&body.workspace_id), machine_id.as_deref());
    spawn_operation_watch(state.clone(), body.workspace_id.clone(), op_id);

    Ok(Json(json!({ "operation": op })))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecBody {
    pub cmd: String,
    #[serde(default)]
    pub timeout_seconds: Option<u64>,
}

pub async fn exec_command(
    State(state): State<SharedState>,
    Path((workspace_id, machine_id)): Path<(String, String)>,
    Json(body): Json<ExecBody>,
) -> Result<Json<Value>, ApiErr> {
    let ws = state
        .store
        .get_workspace(&workspace_id)
        .await?
        .ok_or_else(|| ApiErr::new(StatusCode::NOT_FOUND, "not_found", "No such workspace"))?;
    let machine = state
        .store
        .get_machine(&workspace_id, &machine_id)
        .await?
        .ok_or_else(|| ApiErr::new(StatusCode::NOT_FOUND, "not_found", "No such machine"))?;
    let key = state.key_for(&ws).await?;

    let cmd = body.cmd.trim().to_string();
    if cmd.is_empty() {
        return Err(ApiErr::new(StatusCode::BAD_REQUEST, "bad_request", "cmd is empty"));
    }
    let timeout = body.timeout_seconds.unwrap_or(60).clamp(1, 600);

    let result = state.ib.exec(&key, &machine.id, &cmd, timeout).await;
    let ok = result.is_ok();
    state
        .store
        .audit(
            Some(&workspace_id),
            Some(&machine.id),
            "machine.exec",
            Some(&cmd.chars().take(240).collect::<String>()),
            ok,
        )
        .await
        .ok();

    Ok(Json(json!({ "result": result? })))
}

pub async fn get_machine(
    State(state): State<SharedState>,
    Path((workspace_id, machine_id)): Path<(String, String)>,
) -> Result<Json<Value>, ApiErr> {
    let ws = state
        .store
        .get_workspace(&workspace_id)
        .await?
        .ok_or_else(|| ApiErr::new(StatusCode::NOT_FOUND, "not_found", "No such workspace"))?;
    let key = state.key_for(&ws).await?;
    let machine = state.ib.get_machine(&key, &machine_id).await?;
    Ok(Json(json!({ "machine": machine })))
}

#[derive(Deserialize)]
pub struct LimitQuery {
    #[serde(default = "default_limit")]
    pub limit: i64,
}

fn default_limit() -> i64 {
    50
}

pub async fn operations(
    State(state): State<SharedState>,
    Query(query): Query<LimitQuery>,
) -> Result<Json<Value>, ApiErr> {
    let rows = state.store.list_operations(query.limit.clamp(1, 200)).await?;
    Ok(Json(json!({ "operations": rows })))
}

pub async fn audit_log(
    State(state): State<SharedState>,
    Query(query): Query<LimitQuery>,
) -> Result<Json<Value>, ApiErr> {
    let rows = state.store.list_audit(query.limit.clamp(1, 500)).await?;
    Ok(Json(json!({ "audit": rows })))
}

pub async fn settings(State(state): State<SharedState>) -> Json<Value> {
    let token = state.mcp_token().await;
    Json(json!({
        "version": env!("CARGO_PKG_VERSION"),
        "dataDir": state.config.data_dir,
        "mcp": {
            "url": format!("http://{}:{}/mcp", state.config.bind, state.config.port),
            "token": token,
            "stdioCommand": "vmdash mcp-stdio",
        },
        "syncSeconds": state.config.sync_secs,
        "apiBase": state.config.api_base,
        "publicUrl": state.config.public_url,
    }))
}

pub async fn rotate_mcp_token(State(state): State<SharedState>) -> Result<Json<Value>, ApiErr> {
    let token = random_token();
    state.store.set_setting("mcp_token", &token).await?;
    *state.mcp_token.write().await = token.clone();
    Ok(Json(json!({ "token": token })))
}

pub fn random_token() -> String {
    use rand::RngCore;
    let mut bytes = [0u8; 24];
    rand::rngs::OsRng.fill_bytes(&mut bytes);
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

pub async fn events(
    State(state): State<SharedState>,
) -> Sse<impl futures::Stream<Item = Result<SseEvent, Infallible>>> {
    let rx = state.events.subscribe();
    let stream = BroadcastStream::new(rx).filter_map(|msg| async move {
        match msg {
            Ok(event) => {
                let ev = SseEvent::default()
                    .event("change")
                    .json_data(event)
                    .unwrap_or_else(|_| SseEvent::default().comment("encode error"));
                Some(Ok(ev))
            }
            Err(_) => None,
        }
    });

    Sse::new(stream).keep_alive(KeepAlive::default())
}

/// Follow a lifecycle operation until it is terminal, then refresh the cache.
pub fn spawn_operation_watch(state: SharedState, workspace_id: String, operation_id: String) {
    tokio::spawn(async move {
        for _ in 0..12 {
            let ws = match state.store.get_workspace(&workspace_id).await {
                Ok(Some(ws)) => ws,
                _ => break,
            };
            let key = match state.key_for(&ws).await {
                Ok(k) => k,
                Err(_) => break,
            };
            match state.ib.operation_wait(&key, &operation_id, 20).await {
                Ok(op) => {
                    let op_state = op
                        .get("state")
                        .and_then(Value::as_str)
                        .unwrap_or("unknown")
                        .to_string();
                    let machine_id = op.get("machineId").and_then(Value::as_str);
                    let error = op
                        .get("error")
                        .and_then(|e| e.get("message"))
                        .and_then(Value::as_str);
                    let _ = state
                        .store
                        .upsert_operation(
                            &operation_id,
                            &workspace_id,
                            machine_id,
                            op.get("type").and_then(Value::as_str).unwrap_or("operation"),
                            &op_state,
                            error,
                        )
                        .await;
                    state.emit("operation", Some(&workspace_id), machine_id);

                    if op_state == "succeeded" || op_state == "failed" {
                        let _ = sync_one(&state, &workspace_id).await;
                        break;
                    }
                }
                Err(err) => {
                    tracing::debug!(operation = %operation_id, error = %err, "operation poll stopped");
                    let _ = state
                        .store
                        .upsert_operation(
                            &operation_id,
                            &workspace_id,
                            None,
                            "operation",
                            "unknown",
                            Some(&err.message),
                        )
                        .await;
                    break;
                }
            }
        }
    });
}


pub fn router(state: SharedState) -> axum::Router {    use axum::routing::{get, post};

    axum::Router::new()
        .route("/api/health", get(health))
        .route("/api/fleet", get(fleet))
        .route("/api/workspaces", get(list_workspaces).post(add_workspace))
        .route("/api/workspaces/{id}", axum::routing::delete(delete_workspace))
        .route("/api/workspaces/{id}/sync", post(sync_workspace_now))
        .route("/api/sync", post(sync_everything))
        .route("/api/machines", post(create_machine))
        .route(
            "/api/machines/{workspace_id}/{machine_id}",
            get(get_machine),
        )
        .route(
            "/api/machines/{workspace_id}/{machine_id}/action",
            post(machine_action),
        )
        .route(
            "/api/machines/{workspace_id}/{machine_id}/exec",
            post(exec_command),
        )
        .route("/api/operations", get(operations))
        .route("/api/audit", get(audit_log))
        .route("/api/events", get(events))
        .route("/api/settings", get(settings))
        .route("/api/settings/mcp-token", post(rotate_mcp_token))
        .merge(crate::extras::routes())
        .merge(crate::schedules::routes())
        .merge(crate::health::routes())
        .with_state(state)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn create_body_accepts_camel_case() {
        let body: CreateMachineBody = serde_json::from_str(
            r#"{"workspaceId":"ws_1","templateId":"agent-browser","memMiB":8192,"autoSuspendAfterSeconds":1800}"#,
        )
        .unwrap();
        assert_eq!(body.workspace_id, "ws_1");
        assert_eq!(body.template_id.as_deref(), Some("agent-browser"));
        assert_eq!(body.mem_mib, Some(8192));
        assert_eq!(body.auto_suspend_after_seconds, Some(1800));
    }

    #[test]
    fn exec_body_accepts_camel_case_timeout() {
        let body: ExecBody =
            serde_json::from_str(r#"{"cmd":"uname -a","timeoutSeconds":120}"#).unwrap();
        assert_eq!(body.timeout_seconds, Some(120));
    }
}

/// Record an operation returned by the InstaBox API and follow it to completion.
pub fn track_operation(state: &SharedState, workspace_id: &str, op: &Value, kind: &str) {
    let Some(op_id) = op.get("id").and_then(Value::as_str).map(str::to_string) else {
        return;
    };
    let machine_id = op
        .get("machineId")
        .and_then(Value::as_str)
        .map(str::to_string);
    let op_state = op
        .get("state")
        .and_then(Value::as_str)
        .unwrap_or("queued")
        .to_string();
    let st = state.clone();
    let ws = workspace_id.to_string();
    let kind = kind.to_string();
    let watch_id = op_id.clone();
    tokio::spawn(async move {
        let _ = st
            .store
            .upsert_operation(&op_id, &ws, machine_id.as_deref(), &kind, &op_state, None)
            .await;
        spawn_operation_watch(st, ws, watch_id);
    });
}

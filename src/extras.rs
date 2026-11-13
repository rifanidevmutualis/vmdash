use axum::body::Body;
use axum::extract::ws::{Message as WsMessage, WebSocket, WebSocketUpgrade};
use axum::extract::{DefaultBodyLimit, Path, Query, State};
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, patch, post};
use axum::{Json, Router};
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use futures_util::{SinkExt, StreamExt};
use hmac::{Hmac, Mac};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::Sha256;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::Message as TgMessage;

use crate::api::ApiErr;
use crate::state::SharedState;
use crate::store::{MachineRow, Workspace};

type UpstreamSocket = tokio_tungstenite::WebSocketStream<
    tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
>;

async fn machine_ctx(
    state: &SharedState,
    workspace_id: &str,
    _machine_id: &str,
) -> Result<(Workspace, String), ApiErr> {
    let ws = state
        .store
        .get_workspace(workspace_id)
        .await?
        .ok_or_else(|| ApiErr::new(StatusCode::NOT_FOUND, "not_found", "No such workspace"))?;
    let key = state.key_for(&ws).await?;
    Ok((ws, key))
}

async fn workspace_ctx(state: &SharedState, workspace_id: &str) -> Result<(Workspace, String), ApiErr> {
    machine_ctx(state, workspace_id, "").await
}

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

// ── Files ──────────────────────────────────────────────────────────────

#[derive(Deserialize)]
pub struct FileQuery {
    pub path: Option<String>,
    pub mode: Option<String>,
    #[serde(default)]
    pub parents: bool,
}

pub async fn list_files(
    State(state): State<SharedState>,
    Path((workspace_id, machine_id)): Path<(String, String)>,
    Query(query): Query<FileQuery>,
) -> Result<Json<Value>, ApiErr> {
    let (_, key) = machine_ctx(&state, &workspace_id, &machine_id).await?;
    let path = query.path.unwrap_or_else(|| "/data/home".into());
    Ok(Json(
        state.ib.list_files(&key, &machine_id, &path).await?,
    ))
}

pub async fn download_file(
    State(state): State<SharedState>,
    Path((workspace_id, machine_id)): Path<(String, String)>,
    Query(query): Query<FileQuery>,
) -> Result<Response, ApiErr> {
    let (_, key) = machine_ctx(&state, &workspace_id, &machine_id).await?;
    let path = query
        .path
        .ok_or_else(|| ApiErr::new(StatusCode::BAD_REQUEST, "bad_request", "path is required"))?;
    let upstream = state.ib.download_file(&key, &machine_id, &path).await?;
    let status = StatusCode::from_u16(upstream.status().as_u16()).unwrap_or(StatusCode::OK);

    let mut builder = Response::builder().status(status);
    for name in [header::CONTENT_TYPE, header::CONTENT_LENGTH, header::ETAG] {
        if let Some(value) = upstream.headers().get(&name) {
            builder = builder.header(name, value);
        }
    }
    let filename = path.rsplit('/').next().unwrap_or("file");
    builder = builder.header(
        header::CONTENT_DISPOSITION,
        format!("attachment; filename=\"{}\"", filename.replace('"', "")),
    );

    let stream = upstream
        .bytes_stream()
        .map(|chunk| chunk.map_err(|err| std::io::Error::other(err.to_string())));
    let body = Body::from_stream(stream);
    builder
        .body(body)
        .map_err(|err| ApiErr::new(StatusCode::INTERNAL_SERVER_ERROR, "internal", err.to_string()))
}

pub async fn upload_file(
    State(state): State<SharedState>,
    Path((workspace_id, machine_id)): Path<(String, String)>,
    Query(query): Query<FileQuery>,
    body: Body,
) -> Result<Json<Value>, ApiErr> {
    let (_, key) = machine_ctx(&state, &workspace_id, &machine_id).await?;
    let path = query
        .path
        .ok_or_else(|| ApiErr::new(StatusCode::BAD_REQUEST, "bad_request", "path is required"))?;
    let stream = body
        .into_data_stream()
        .map(|chunk| chunk.map_err(|err| std::io::Error::other(err.to_string())));
    let req_body = reqwest::Body::wrap_stream(stream);
    Ok(Json(
        state
            .ib
            .upload_file_stream(
                &key,
                &machine_id,
                &path,
                req_body,
                query.mode.as_deref(),
                query.parents,
            )
            .await?,
    ))
}

#[derive(Deserialize)]
pub struct DeleteFileBody {
    pub path: String,
}

pub async fn delete_file(
    State(state): State<SharedState>,
    Path((workspace_id, machine_id)): Path<(String, String)>,
    Json(body): Json<DeleteFileBody>,
) -> Result<Json<Value>, ApiErr> {
    let (_, key) = machine_ctx(&state, &workspace_id, &machine_id).await?;
    let cmd = format!("rm -rf -- {}", shell_quote(&body.path));
    let result = state.ib.exec(&key, &machine_id, &cmd, 30).await?;
    let _ = state
        .store
        .audit(
            Some(&workspace_id),
            Some(&machine_id),
            "machine.file.delete",
            Some(&body.path),
            result.get("exitCode").and_then(Value::as_i64) == Some(0),
        )
        .await;
    Ok(Json(json!({ "result": result })))
}

// ── SSH tokens ─────────────────────────────────────────────────────────

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshTokenBody {
    pub name: Option<String>,
    pub ttl_seconds: Option<u64>,
    pub no_expiry: Option<bool>,
}

pub async fn ssh_tokens(
    State(state): State<SharedState>,
    Path((workspace_id, machine_id)): Path<(String, String)>,
) -> Result<Json<Value>, ApiErr> {
    let (_, key) = machine_ctx(&state, &workspace_id, &machine_id).await?;
    Ok(Json(
        state.ib.ssh_tokens(&key, &machine_id).await?,
    ))
}

pub async fn ssh_token_create(
    State(state): State<SharedState>,
    Path((workspace_id, machine_id)): Path<(String, String)>,
    Json(body): Json<SshTokenBody>,
) -> Result<Json<Value>, ApiErr> {
    let (_, key) = machine_ctx(&state, &workspace_id, &machine_id).await?;
    let result = if body.no_expiry.unwrap_or(false) {
        // No-expiry is a separate boolean upstream; name + ttl are enough for the
        // common case, so this falls back to a long TTL.
        state
            .ib
            .ssh_token_create(&key, &machine_id, body.name.as_deref(), Some(2_592_000))
            .await?
    } else {
        state
            .ib
            .ssh_token_create(&key, &machine_id, body.name.as_deref(), body.ttl_seconds)
            .await?
    };
    let _ = state
        .store
        .audit(
            Some(&workspace_id),
            Some(&machine_id),
            "machine.ssh_token",
            body.name.as_deref(),
            true,
        )
        .await;
    Ok(Json(result))
}

pub async fn ssh_token_revoke(
    State(state): State<SharedState>,
    Path((workspace_id, machine_id, token_id)): Path<(String, String, String)>,
) -> Result<Json<Value>, ApiErr> {
    let (_, key) = machine_ctx(&state, &workspace_id, &machine_id).await?;
    state
        .ib
        .ssh_token_revoke(&key, &machine_id, &token_id)
        .await?;
    Ok(Json(json!({ "ok": true })))
}

pub async fn ssh_tokens_revoke_all(
    State(state): State<SharedState>,
    Path((workspace_id, machine_id)): Path<(String, String)>,
) -> Result<Json<Value>, ApiErr> {
    let (_, key) = machine_ctx(&state, &workspace_id, &machine_id).await?;
    Ok(Json(
        state.ib.ssh_tokens_revoke_all(&key, &machine_id).await?,
    ))
}

// ── Desktop ────────────────────────────────────────────────────────────

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopBody {
    pub action: String,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub view_only: Option<bool>,
    pub ttl_seconds: Option<u64>,
}

pub async fn desktop_action(
    State(state): State<SharedState>,
    Path((workspace_id, machine_id)): Path<(String, String)>,
    Json(body): Json<DesktopBody>,
) -> Result<Json<Value>, ApiErr> {
    let (_, key) = machine_ctx(&state, &workspace_id, &machine_id).await?;
    Ok(Json(
        state
            .ib
            .desktop(&key, &machine_id, &body.action, body.width, body.height)
            .await?,
    ))
}

pub async fn desktop_stream(
    State(state): State<SharedState>,
    Path((workspace_id, machine_id)): Path<(String, String)>,
    Json(body): Json<DesktopBody>,
) -> Result<Json<Value>, ApiErr> {
    let (_, key) = machine_ctx(&state, &workspace_id, &machine_id).await?;
    Ok(Json(
        state
            .ib
            .desktop_stream(
                &key,
                &machine_id,
                body.view_only.unwrap_or(false),
                body.ttl_seconds,
            )
            .await?,
    ))
}

pub async fn desktop_stream_revoke(
    State(state): State<SharedState>,
    Path((workspace_id, machine_id)): Path<(String, String)>,
) -> Result<Json<Value>, ApiErr> {
    let (_, key) = machine_ctx(&state, &workspace_id, &machine_id).await?;
    state.ib.desktop_stream_revoke(&key, &machine_id).await?;
    Ok(Json(json!({ "ok": true })))
}

// ── Public ports ───────────────────────────────────────────────────────

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PortBody {
    pub port: u16,
    pub access: Option<String>,
    pub protocol: Option<String>,
    pub name: Option<String>,
    pub rotate_token: Option<bool>,
}

pub async fn ports(
    State(state): State<SharedState>,
    Path((workspace_id, machine_id)): Path<(String, String)>,
) -> Result<Json<Value>, ApiErr> {
    let (_, key) = machine_ctx(&state, &workspace_id, &machine_id).await?;
    Ok(Json(state.ib.ports(&key, &machine_id).await?))
}

pub async fn port_publish(
    State(state): State<SharedState>,
    Path((workspace_id, machine_id)): Path<(String, String)>,
    Json(body): Json<PortBody>,
) -> Result<Json<Value>, ApiErr> {
    let (_, key) = machine_ctx(&state, &workspace_id, &machine_id).await?;
    let mut payload = serde_json::Map::new();
    payload.insert("port".into(), json!(body.port));
    if let Some(access) = body.access {
        payload.insert("access".into(), json!(access));
    }
    if let Some(protocol) = body.protocol {
        payload.insert("protocol".into(), json!(protocol));
    }
    if let Some(name) = body.name.clone().filter(|n| !n.is_empty()) {
        payload.insert("name".into(), json!(name));
    }
    if let Some(rotate) = body.rotate_token {
        payload.insert("rotateToken".into(), json!(rotate));
    }
    let result = state
        .ib
        .port_publish(&key, &machine_id, Value::Object(payload))
        .await?;
    let _ = state
        .store
        .audit(
            Some(&workspace_id),
            Some(&machine_id),
            "machine.port.publish",
            result.get("url").and_then(Value::as_str),
            true,
        )
        .await;
    Ok(Json(result))
}

pub async fn port_unpublish(
    State(state): State<SharedState>,
    Path((workspace_id, machine_id, port)): Path<(String, String, u16)>,
) -> Result<Json<Value>, ApiErr> {
    let (_, key) = machine_ctx(&state, &workspace_id, &machine_id).await?;
    state.ib.port_unpublish(&key, &machine_id, port).await?;
    Ok(Json(json!({ "ok": true })))
}

// ── Snapshots, fork, restore ───────────────────────────────────────────

pub async fn workspace_snapshots(
    State(state): State<SharedState>,
    Path(workspace_id): Path<String>,
) -> Result<Json<Value>, ApiErr> {
    let (_, key) = workspace_ctx(&state, &workspace_id).await?;
    Ok(Json(state.ib.snapshots(&key).await?))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotBody {
    pub name: String,
    pub description: Option<String>,
    #[serde(default)]
    pub root_only: bool,
    #[serde(default)]
    pub for_fork: bool,
}

pub async fn snapshot_create(
    State(state): State<SharedState>,
    Path((workspace_id, machine_id)): Path<(String, String)>,
    Json(body): Json<SnapshotBody>,
) -> Result<Json<Value>, ApiErr> {
    let (_, key) = machine_ctx(&state, &workspace_id, &machine_id).await?;
    let result = state
        .ib
        .snapshot_create(
            &key,
            &machine_id,
            &body.name,
            body.description.as_deref(),
            body.root_only,
            body.for_fork,
        )
        .await?;
    let _ = state
        .store
        .audit(
            Some(&workspace_id),
            Some(&machine_id),
            "snapshot.create",
            Some(&body.name),
            true,
        )
        .await;
    Ok(Json(result))
}

pub async fn snapshot_delete(
    State(state): State<SharedState>,
    Path((workspace_id, snapshot_id)): Path<(String, String)>,
) -> Result<Json<Value>, ApiErr> {
    let (_, key) = workspace_ctx(&state, &workspace_id).await?;
    state.ib.snapshot_delete(&key, &snapshot_id).await?;
    let _ = state
        .store
        .audit(
            Some(&workspace_id),
            None,
            "snapshot.delete",
            Some(&snapshot_id),
            true,
        )
        .await;
    Ok(Json(json!({ "ok": true })))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreBody {
    pub snapshot_id: String,
    pub desired_state: Option<String>,
}

pub async fn restore(
    State(state): State<SharedState>,
    Path((workspace_id, machine_id)): Path<(String, String)>,
    Json(body): Json<RestoreBody>,
) -> Result<Json<Value>, ApiErr> {
    let (_, key) = machine_ctx(&state, &workspace_id, &machine_id).await?;
    let op = state
        .ib
        .restore(
            &key,
            &machine_id,
            &body.snapshot_id,
            body.desired_state.as_deref(),
        )
        .await?;
    crate::api::track_operation(&state, &workspace_id, &op, "machine.restore");
    let _ = state
        .store
        .audit(
            Some(&workspace_id),
            Some(&machine_id),
            "machine.restore",
            Some(&body.snapshot_id),
            true,
        )
        .await;
    Ok(Json(op))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ForkBody {
    pub name: Option<String>,
    pub vcpus: Option<i64>,
    #[serde(rename = "memMiB")]
    pub mem_mib: Option<i64>,
    pub auto_suspend_after_seconds: Option<i64>,
    pub metadata: Option<Value>,
}

pub async fn fork(
    State(state): State<SharedState>,
    Path((workspace_id, machine_id)): Path<(String, String)>,
    Json(body): Json<ForkBody>,
) -> Result<Json<Value>, ApiErr> {
    let (_, key) = machine_ctx(&state, &workspace_id, &machine_id).await?;
    let mut payload = serde_json::Map::new();
    if let Some(name) = body.name.clone().filter(|n| !n.is_empty()) {
        payload.insert("name".into(), json!(name));
    }
    if let Some(vcpus) = body.vcpus {
        payload.insert("vcpus".into(), json!(vcpus));
    }
    if let Some(mem) = body.mem_mib {
        payload.insert("memMiB".into(), json!(mem));
    }
    if let Some(auto) = body.auto_suspend_after_seconds {
        payload.insert("autoSuspendAfterSeconds".into(), json!(auto));
    }
    if let Some(metadata) = body.metadata.filter(|m| m.is_object()) {
        payload.insert("metadata".into(), metadata);
    }
    let op = state
        .ib
        .fork(&key, &machine_id, Value::Object(payload))
        .await?;
    crate::api::track_operation(&state, &workspace_id, &op, "machine.fork");
    let _ = state
        .store
        .audit(
            Some(&workspace_id),
            Some(&machine_id),
            "machine.fork",
            body.name.as_deref(),
            true,
        )
        .await;
    Ok(Json(op))
}

// ── Resize, rename, metadata ───────────────────────────────────────────

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PatchMachineBody {
    pub name: Option<String>,
    pub vcpus: Option<i64>,
    #[serde(rename = "memMiB")]
    pub mem_mib: Option<i64>,
    pub persistent_disk_gib: Option<i64>,
    pub auto_suspend_after_seconds: Option<i64>,
    pub max_run_minutes: Option<i64>,
    pub metadata: Option<Value>,
    pub apply: Option<String>,
}

pub async fn patch_machine(
    State(state): State<SharedState>,
    Path((workspace_id, machine_id)): Path<(String, String)>,
    Json(body): Json<PatchMachineBody>,
) -> Result<Json<Value>, ApiErr> {
    let (_, key) = machine_ctx(&state, &workspace_id, &machine_id).await?;
    let mut payload = serde_json::Map::new();
    if let Some(name) = body.name.clone().filter(|n| !n.is_empty()) {
        payload.insert("name".into(), json!(name));
    }
    if let Some(vcpus) = body.vcpus {
        payload.insert("vcpus".into(), json!(vcpus));
    }
    if let Some(mem) = body.mem_mib {
        payload.insert("memMiB".into(), json!(mem));
    }
    if let Some(disk) = body.persistent_disk_gib {
        payload.insert("persistentDiskGiB".into(), json!(disk));
    }
    if let Some(auto) = body.auto_suspend_after_seconds {
        payload.insert("autoSuspendAfterSeconds".into(), json!(auto));
    }
    if let Some(max_run) = body.max_run_minutes {
        payload.insert("maxRunMinutes".into(), json!(max_run));
    }
    if let Some(metadata) = body.metadata {
        payload.insert("metadata".into(), metadata);
    }
    if let Some(apply) = body.apply {
        payload.insert("apply".into(), json!(apply));
    }
    if payload.is_empty() {
        return Err(ApiErr::new(
            StatusCode::BAD_REQUEST,
            "bad_request",
            "Nothing to update",
        ));
    }
    let result = state
        .ib
        .patch_machine(&key, &machine_id, Value::Object(payload))
        .await?;
    if result.get("state").is_some() && result.get("type").is_some() {
        crate::api::track_operation(&state, &workspace_id, &result, "machine.patch");
    }
    let _ = state
        .store
        .audit(
            Some(&workspace_id),
            Some(&machine_id),
            "machine.patch",
            None,
            true,
        )
        .await;
    let st = state.clone();
    let wid = workspace_id.clone();
    tokio::spawn(async move {
        let _ = crate::sync::sync_one(&st, &wid).await;
    });
    Ok(Json(result))
}

// ── Metrics, logs, history ─────────────────────────────────────────────

#[derive(Deserialize)]
pub struct SinceQuery {
    pub since: Option<String>,
    pub tail: Option<u32>,
    pub limit: Option<u32>,
}

pub async fn metrics(
    State(state): State<SharedState>,
    Path((workspace_id, machine_id)): Path<(String, String)>,
    Query(query): Query<SinceQuery>,
) -> Result<Json<Value>, ApiErr> {
    let (_, key) = machine_ctx(&state, &workspace_id, &machine_id).await?;
    Ok(Json(
        state
            .ib
            .metrics(&key, &machine_id, query.since.as_deref())
            .await?,
    ))
}

pub async fn logs(
    State(state): State<SharedState>,
    Path((workspace_id, machine_id)): Path<(String, String)>,
    Query(query): Query<SinceQuery>,
) -> Result<Json<Value>, ApiErr> {
    let (_, key) = machine_ctx(&state, &workspace_id, &machine_id).await?;
    Ok(Json(
        state
            .ib
            .logs(&key, &machine_id, query.tail.or(Some(400)))
            .await?,
    ))
}

pub async fn history(
    State(state): State<SharedState>,
    Path((workspace_id, machine_id)): Path<(String, String)>,
    Query(query): Query<SinceQuery>,
) -> Result<Json<Value>, ApiErr> {
    let (_, key) = machine_ctx(&state, &workspace_id, &machine_id).await?;
    Ok(Json(
        state
            .ib
            .history(&key, &machine_id, query.limit.unwrap_or(30).clamp(1, 100))
            .await?,
    ))
}

// ── Org secrets ────────────────────────────────────────────────────────

pub async fn org_secrets(
    State(state): State<SharedState>,
    Path(workspace_id): Path<String>,
) -> Result<Json<Value>, ApiErr> {
    let (ws, key) = workspace_ctx(&state, &workspace_id).await?;
    let org_id = ws.org_id.as_deref().ok_or_else(|| {
        ApiErr::new(
            StatusCode::BAD_REQUEST,
            "missing_org",
            "This workspace has no org id; sync it first.",
        )
    })?;
    Ok(Json(state.ib.org_secrets(&key, org_id).await?))
}

#[derive(Deserialize)]
pub struct SecretBody {
    pub value: String,
    pub delivery: String,
    pub hosts: Option<Vec<String>>,
}

pub async fn secret_put(
    State(state): State<SharedState>,
    Path((workspace_id, name)): Path<(String, String)>,
    Json(body): Json<SecretBody>,
) -> Result<Json<Value>, ApiErr> {
    let (ws, key) = workspace_ctx(&state, &workspace_id).await?;
    let org_id = ws.org_id.as_deref().ok_or_else(|| {
        ApiErr::new(StatusCode::BAD_REQUEST, "missing_org", "This workspace has no org id")
    })?;
    let result = state
        .ib
        .org_secret_put(
            &key,
            org_id,
            &name,
            &body.value,
            &body.delivery,
            body.hosts,
        )
        .await?;
    let _ = state
        .store
        .audit(
            Some(&workspace_id),
            None,
            "secret.put",
            Some(&name),
            true,
        )
        .await;
    Ok(Json(result))
}

pub async fn secret_delete(
    State(state): State<SharedState>,
    Path((workspace_id, name)): Path<(String, String)>,
) -> Result<Json<Value>, ApiErr> {
    let (ws, key) = workspace_ctx(&state, &workspace_id).await?;
    let org_id = ws.org_id.as_deref().ok_or_else(|| {
        ApiErr::new(StatusCode::BAD_REQUEST, "missing_org", "This workspace has no org id")
    })?;
    state.ib.org_secret_delete(&key, org_id, &name).await?;
    let _ = state
        .store
        .audit(
            Some(&workspace_id),
            None,
            "secret.delete",
            Some(&name),
            true,
        )
        .await;
    Ok(Json(json!({ "ok": true })))
}

pub async fn machine_secrets(
    State(state): State<SharedState>,
    Path((workspace_id, machine_id)): Path<(String, String)>,
) -> Result<Json<Value>, ApiErr> {
    let (_, key) = machine_ctx(&state, &workspace_id, &machine_id).await?;
    Ok(Json(
        state.ib.machine_secrets(&key, &machine_id).await?,
    ))
}

pub async fn machine_secrets_patch(
    State(state): State<SharedState>,
    Path((workspace_id, machine_id)): Path<(String, String)>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiErr> {
    let (_, key) = machine_ctx(&state, &workspace_id, &machine_id).await?;
    Ok(Json(
        state
            .ib
            .machine_secrets_patch(&key, &machine_id, body)
            .await?,
    ))
}

pub async fn machine_secrets_refresh(
    State(state): State<SharedState>,
    Path((workspace_id, machine_id)): Path<(String, String)>,
) -> Result<Json<Value>, ApiErr> {
    let (_, key) = machine_ctx(&state, &workspace_id, &machine_id).await?;
    Ok(Json(
        state.ib.machine_secrets_refresh(&key, &machine_id).await?,
    ))
}

// ── Webhooks: management + receiver ────────────────────────────────────

pub async fn webhooks(
    State(state): State<SharedState>,
    Path(workspace_id): Path<String>,
) -> Result<Json<Value>, ApiErr> {
    let (ws, key) = workspace_ctx(&state, &workspace_id).await?;
    let org_id = ws.org_id.as_deref().ok_or_else(|| {
        ApiErr::new(StatusCode::BAD_REQUEST, "missing_org", "This workspace has no org id")
    })?;
    Ok(Json(state.ib.webhooks(&key, org_id).await?))
}

pub async fn webhook_create(
    State(state): State<SharedState>,
    Path(workspace_id): Path<String>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiErr> {
    let (ws, key) = workspace_ctx(&state, &workspace_id).await?;
    let org_id = ws.org_id.as_deref().ok_or_else(|| {
        ApiErr::new(StatusCode::BAD_REQUEST, "missing_org", "This workspace has no org id")
    })?;
    let result = state.ib.webhook_create(&key, org_id, body).await?;
    store_webhook_secret(&state, &workspace_id, &result).await;
    let _ = state
        .store
        .audit(
            Some(&workspace_id),
            None,
            "webhook.create",
            result.get("url").and_then(Value::as_str),
            true,
        )
        .await;
    Ok(Json(result))
}

pub async fn webhook_update(
    State(state): State<SharedState>,
    Path((workspace_id, webhook_id)): Path<(String, String)>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiErr> {
    let (ws, key) = workspace_ctx(&state, &workspace_id).await?;
    let org_id = ws.org_id.as_deref().ok_or_else(|| {
        ApiErr::new(StatusCode::BAD_REQUEST, "missing_org", "This workspace has no org id")
    })?;
    Ok(Json(
        state
            .ib
            .webhook_update(&key, org_id, &webhook_id, body)
            .await?,
    ))
}

pub async fn webhook_delete(
    State(state): State<SharedState>,
    Path((workspace_id, webhook_id)): Path<(String, String)>,
) -> Result<Json<Value>, ApiErr> {
    let (ws, key) = workspace_ctx(&state, &workspace_id).await?;
    let org_id = ws.org_id.as_deref().ok_or_else(|| {
        ApiErr::new(StatusCode::BAD_REQUEST, "missing_org", "This workspace has no org id")
    })?;
    state.ib.webhook_delete(&key, org_id, &webhook_id).await?;
    let _ = state.store.delete_webhook_secret(&webhook_id).await;
    let _ = state
        .store
        .audit(
            Some(&workspace_id),
            None,
            "webhook.delete",
            Some(&webhook_id),
            true,
        )
        .await;
    Ok(Json(json!({ "ok": true })))
}

pub async fn webhook_rotate(
    State(state): State<SharedState>,
    Path((workspace_id, webhook_id)): Path<(String, String)>,
) -> Result<Json<Value>, ApiErr> {
    let (ws, key) = workspace_ctx(&state, &workspace_id).await?;
    let org_id = ws.org_id.as_deref().ok_or_else(|| {
        ApiErr::new(StatusCode::BAD_REQUEST, "missing_org", "This workspace has no org id")
    })?;
    let result = state.ib.webhook_rotate(&key, org_id, &webhook_id).await?;
    store_webhook_secret(&state, &workspace_id, &result).await;
    Ok(Json(result))
}

pub async fn webhook_test(
    State(state): State<SharedState>,
    Path((workspace_id, webhook_id)): Path<(String, String)>,
) -> Result<Json<Value>, ApiErr> {
    let (ws, key) = workspace_ctx(&state, &workspace_id).await?;
    let org_id = ws.org_id.as_deref().ok_or_else(|| {
        ApiErr::new(StatusCode::BAD_REQUEST, "missing_org", "This workspace has no org id")
    })?;
    Ok(Json(
        state.ib.webhook_test(&key, org_id, &webhook_id).await?,
    ))
}

pub async fn webhook_deliveries(
    State(state): State<SharedState>,
    Path((workspace_id, webhook_id)): Path<(String, String)>,
) -> Result<Json<Value>, ApiErr> {
    let (ws, key) = workspace_ctx(&state, &workspace_id).await?;
    let org_id = ws.org_id.as_deref().ok_or_else(|| {
        ApiErr::new(StatusCode::BAD_REQUEST, "missing_org", "This workspace has no org id")
    })?;
    Ok(Json(
        state
            .ib
            .webhook_deliveries(&key, org_id, &webhook_id, 50)
            .await?,
    ))
}

pub(crate) async fn store_webhook_secret(state: &SharedState, workspace_id: &str, payload: &Value) {    let Some(secret) = payload.get("secret").and_then(Value::as_str) else {
        return;
    };
    let Some(webhook_id) = payload.get("id").and_then(Value::as_str) else {
        return;
    };
    if let Ok(cipher) = state.vault.seal(secret) {
        let _ = state
            .store
            .put_webhook_secret(webhook_id, workspace_id, &cipher)
            .await;
    }
}

pub async fn webhook_receive(
    State(state): State<SharedState>,
    Path(workspace_id): Path<String>,
    headers: HeaderMap,
    body: axum::body::Bytes,
) -> Response {
    let id = headers
        .get("webhook-id")
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default()
        .to_string();
    let timestamp = headers
        .get("webhook-timestamp")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<i64>().ok())
        .unwrap_or(0);
    let signatures = headers
        .get("webhook-signature")
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default()
        .to_string();

    if id.is_empty() || timestamp == 0 || signatures.is_empty() {
        return (StatusCode::BAD_REQUEST, "missing webhook headers").into_response();
    }
    if (chrono::Utc::now().timestamp() - timestamp).abs() > 300 {
        return (StatusCode::BAD_REQUEST, "stale webhook timestamp").into_response();
    }

    let secrets = match state.store.webhook_secrets(&workspace_id).await {
        Ok(secrets) => secrets,
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    };

    let mut valid = false;
    for cipher in secrets {
        let Ok(secret) = state.vault.open(&cipher) else {
            continue;
        };
        let Ok(key) = B64.decode(secret.trim_start_matches("whsec_")) else {
            continue;
        };
        let mut mac = <Hmac<Sha256> as Mac>::new_from_slice(&key).expect("hmac key");
        mac.update(format!("{id}.{timestamp}.").as_bytes());
        mac.update(&body);
        for signature in signatures.split(' ') {
            let Some(raw) = signature.strip_prefix("v1,") else {
                continue;
            };
            if let Ok(got) = B64.decode(raw) {
                if mac.clone().verify_slice(&got).is_ok() {
                    valid = true;
                    break;
                }
            }
        }
        if valid {
            break;
        }
    }

    if !valid {
        return (StatusCode::UNAUTHORIZED, "invalid webhook signature").into_response();
    }

    let event: Value = match serde_json::from_slice(&body) {
        Ok(event) => event,
        Err(_) => return (StatusCode::BAD_REQUEST, "invalid JSON").into_response(),
    };
    let event_type = event
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or("unknown");
    let event_id = event
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or(&id)
        .to_string();

    let _ = state
        .store
        .add_webhook_event(
            &event_id,
            &workspace_id,
            event_type,
            &serde_json::to_string(&event).unwrap_or_default(),
        )
        .await;
    let _ = state
        .store
        .audit(
            Some(&workspace_id),
            None,
            "webhook.received",
            Some(event_type),
            true,
        )
        .await;
    state.emit("webhook", Some(&workspace_id), None);

    StatusCode::NO_CONTENT.into_response()
}

pub async fn webhook_events(
    State(state): State<SharedState>,
    Query(query): Query<SinceQuery>,
) -> Result<Json<Value>, ApiErr> {
    let rows = state
        .store
        .list_webhook_events(query.limit.unwrap_or(50).clamp(1, 200) as i64)
        .await?;
    Ok(Json(json!({ "events": rows })))
}

// ── Terminal + VNC WebSocket proxy ─────────────────────────────────────

#[derive(Deserialize)]
pub struct WsQuery {
    pub token: Option<String>,
    pub cols: Option<u16>,
    pub rows: Option<u16>,
    pub session: Option<String>,
}

async fn authorize_ws(state: &SharedState, query: &WsQuery) -> Result<(), Response> {
    let expected = state.mcp_token().await;
    if query.token.as_deref() == Some(expected.as_str()) {
        Ok(())
    } else {
        Err((StatusCode::UNAUTHORIZED, "missing or invalid token").into_response())
    }
}

fn ws_path(
    base: &str,
    machine_id: &str,
    query: &WsQuery,
    terminal: bool,
) -> String {
    if !terminal {
        return format!("{base}/v1/machines/{machine_id}/vnc");
    }
    let cols = query.cols.unwrap_or(120);
    let rows = query.rows.unwrap_or(32);
    let session = query.session.as_deref().unwrap_or("vmdash");
    format!(
        "{base}/v1/machines/{machine_id}/terminal?cols={cols}&rows={rows}&session={}",
        urlencoding::encode(session)
    )
}

async fn connect_upstream(url: &str, key: &str) -> Result<UpstreamSocket, String> {
    let mut request = url
        .into_client_request()
        .map_err(|err| format!("invalid websocket URL: {err}"))?;
    request.headers_mut().insert(
        "X-API-Key",
        HeaderValue::from_str(key).map_err(|err| err.to_string())?,
    );
    let (socket, _) = tokio_tungstenite::connect_async(request)
        .await
        .map_err(|err| format!("cannot connect upstream: {err}"))?;
    Ok(socket)
}

async fn bridge(client: WebSocket, upstream: UpstreamSocket) {
    let (mut up_tx, mut up_rx) = upstream.split();
    let (mut cl_tx, mut cl_rx) = client.split();

    let client_to_upstream = async {
        while let Some(Ok(message)) = cl_rx.next().await {
            let outgoing = match message {
                WsMessage::Text(text) => TgMessage::Text(text.to_string().into()),
                WsMessage::Binary(bytes) => TgMessage::Binary(bytes.to_vec().into()),
                WsMessage::Ping(bytes) => TgMessage::Ping(bytes.to_vec().into()),
                WsMessage::Pong(bytes) => TgMessage::Pong(bytes.to_vec().into()),
                WsMessage::Close(_) => TgMessage::Close(None),
            };
            if up_tx.send(outgoing).await.is_err() {
                break;
            }
        }
        let _ = up_tx.close().await;
    };

    let upstream_to_client = async {
        while let Some(Ok(message)) = up_rx.next().await {
            let outgoing = match message {
                TgMessage::Text(text) => WsMessage::Text(text.to_string().into()),
                TgMessage::Binary(bytes) => WsMessage::Binary(bytes.to_vec().into()),
                TgMessage::Ping(bytes) => WsMessage::Ping(bytes.to_vec().into()),
                TgMessage::Pong(bytes) => WsMessage::Pong(bytes.to_vec().into()),
                TgMessage::Close(_) => WsMessage::Close(None),
                TgMessage::Frame(_) => continue,
            };
            if cl_tx.send(outgoing).await.is_err() {
                break;
            }
        }
        let _ = cl_tx.close().await;
    };

    tokio::select! {
        _ = client_to_upstream => {}
        _ = upstream_to_client => {}
    }
}

pub async fn ws_terminal(
    State(state): State<SharedState>,
    Path((workspace_id, machine_id)): Path<(String, String)>,
    Query(query): Query<WsQuery>,
    upgrade: WebSocketUpgrade,
) -> Response {
    if let Err(response) = authorize_ws(&state, &query).await {
        return response;
    }
    let Ok((_, key)) = machine_ctx(&state, &workspace_id, &machine_id).await else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let url = state
        .ib
        .ws_endpoint(&ws_path("", &machine_id, &query, true));
    upgrade.on_upgrade(move |socket| async move {
        match connect_upstream(&url, &key).await {
            Ok(upstream) => bridge(socket, upstream).await,
            Err(err) => tracing::warn!(error = %err, "terminal upstream failed"),
        }
    })
}

pub async fn ws_vnc(
    State(state): State<SharedState>,
    Path((workspace_id, machine_id)): Path<(String, String)>,
    Query(query): Query<WsQuery>,
    upgrade: WebSocketUpgrade,
) -> Response {
    if let Err(response) = authorize_ws(&state, &query).await {
        return response;
    }
    let Ok((_, key)) = machine_ctx(&state, &workspace_id, &machine_id).await else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let url = state
        .ib
        .ws_endpoint(&ws_path("", &machine_id, &query, false));
    upgrade.on_upgrade(move |socket| async move {
        match connect_upstream(&url, &key).await {
            Ok(upstream) => bridge(socket, upstream).await,
            Err(err) => tracing::warn!(error = %err, "vnc upstream failed"),
        }
    })
}

// ── Desktop wall ───────────────────────────────────────────────────────

#[derive(Deserialize, Default)]
pub struct DesktopQuery {
    #[serde(default)]
    pub fresh: bool,
}

/// All machines with their desktop status, for the card wall. Only running
/// machines are asked for `POST /desktop action=status`; the answer is cached
/// briefly because the status endpoint is a POST.
pub async fn desktops(
    State(state): State<SharedState>,
    Query(query): Query<DesktopQuery>,
) -> Result<Json<Value>, ApiErr> {
    if !query.fresh {
        let cache = state.desktop_cache.lock().await;
        if let Some((at, value)) = cache.as_ref() {
            if at.elapsed() < std::time::Duration::from_secs(20) {
                return Ok(Json(value.clone()));
            }
        }
    }

    let workspaces = state.store.list_workspaces().await?;
    let machines = state.store.list_machines().await?;

    let mut keys = std::collections::HashMap::new();
    for workspace in &workspaces {
        if let Ok(key) = state.key_for(workspace).await {
            keys.insert(workspace.id.clone(), key);
        }
    }
    let by_id: std::collections::HashMap<String, Workspace> = workspaces
        .into_iter()
        .map(|workspace| (workspace.id.clone(), workspace))
        .collect();

    let jobs: Vec<(Workspace, MachineRow)> = machines
        .into_iter()
        .filter_map(|row| {
            by_id
                .get(&row.workspace_id)
                .cloned()
                .map(|workspace| (workspace, row))
        })
        .collect();

    let mut results: Vec<Value> = futures_util::stream::iter(jobs)
        .map(|(workspace, row)| {
            let state = state.clone();
            let key = keys.get(&workspace.id).cloned();
            async move {
                let mut desktop = Value::Null;
                let mut error: Option<Value> = None;
                if row.state == "running" {
                    match key {
                        Some(key) => match state
                            .ib
                            .desktop(&key, &row.id, "status", None, None)
                            .await
                        {
                            Ok(value) => desktop = value,
                            Err(err) => {
                                error = Some(json!({
                                    "code": err.code,
                                    "message": err.message,
                                    "retryable": err.retryable,
                                }))
                            }
                        },
                        None => {
                            error = Some(json!({
                                "code": "key_unreadable",
                                "message": "Cannot decrypt the stored key for this workspace.",
                            }))
                        }
                    }
                }
                let vnc = row.state == "running"
                    && desktop
                        .get("running")
                        .and_then(Value::as_bool)
                        .unwrap_or(false);
                json!({
                    "workspaceId": workspace.id,
                    "workspaceLabel": workspace.label,
                    "workspaceOrg": workspace.org_name,
                    "workspaceTier": workspace.tier,
                    "machine": row.to_json(Some(&workspace)),
                    "desktop": desktop,
                    "error": error,
                    "vncAvailable": vnc,
                })
            }
        })
        .buffer_unordered(6)
        .collect()
        .await;

    results.sort_by(|a, b| {
        let a_vnc = a["vncAvailable"].as_bool().unwrap_or(false);
        let b_vnc = b["vncAvailable"].as_bool().unwrap_or(false);
        b_vnc.cmp(&a_vnc).then_with(|| {
            a["machine"]["name"]
                .as_str()
                .unwrap_or("")
                .cmp(b["machine"]["name"].as_str().unwrap_or(""))
        })
    });

    let payload = json!({
        "desktops": results,
        "generatedAt": crate::store::now(),
        "maxLive": 4,
    });
    *state.desktop_cache.lock().await = Some((std::time::Instant::now(), payload.clone()));
    Ok(Json(payload))
}

// ── Router ─────────────────────────────────────────────────────────────

pub fn routes() -> Router<SharedState> {
    Router::new()
        .route(
            "/api/machines/{workspace_id}/{machine_id}/files",
            get(list_files)
                .put(upload_file)
                .delete(delete_file)
                .layer(DefaultBodyLimit::disable()),
        )
        .route(
            "/api/machines/{workspace_id}/{machine_id}/files/content",
            get(download_file),
        )
        .route(
            "/api/machines/{workspace_id}/{machine_id}/ssh-tokens",
            get(ssh_tokens).post(ssh_token_create).delete(ssh_tokens_revoke_all),
        )
        .route(
            "/api/machines/{workspace_id}/{machine_id}/ssh-tokens/{token_id}",
            delete(ssh_token_revoke),
        )
        .route(
            "/api/machines/{workspace_id}/{machine_id}/desktop",
            post(desktop_action),
        )
        .route(
            "/api/machines/{workspace_id}/{machine_id}/desktop/stream",
            post(desktop_stream).delete(desktop_stream_revoke),
        )
        .route(
            "/api/machines/{workspace_id}/{machine_id}/ports",
            get(ports).post(port_publish),
        )
        .route(
            "/api/machines/{workspace_id}/{machine_id}/ports/{port}",
            delete(port_unpublish),
        )
        .route(
            "/api/machines/{workspace_id}/{machine_id}/snapshots",
            post(snapshot_create),
        )
        .route(
            "/api/machines/{workspace_id}/{machine_id}/restore",
            post(restore),
        )
        .route("/api/machines/{workspace_id}/{machine_id}/fork", post(fork))
        .route(
            "/api/machines/{workspace_id}/{machine_id}",
            patch(patch_machine),
        )
        .route(
            "/api/machines/{workspace_id}/{machine_id}/metrics",
            get(metrics),
        )
        .route("/api/machines/{workspace_id}/{machine_id}/logs", get(logs))
        .route(
            "/api/machines/{workspace_id}/{machine_id}/history",
            get(history),
        )
        .route(
            "/api/machines/{workspace_id}/{machine_id}/secrets",
            get(machine_secrets)
                .patch(machine_secrets_patch)
                .post(machine_secrets_refresh),
        )
        .route(
            "/api/workspaces/{workspace_id}/snapshots",
            get(workspace_snapshots),
        )
        .route("/api/snapshots/{workspace_id}/{snapshot_id}", delete(snapshot_delete))
        .route(
            "/api/workspaces/{workspace_id}/secrets",
            get(org_secrets),
        )
        .route(
            "/api/workspaces/{workspace_id}/secrets/{name}",
            axum::routing::put(secret_put).delete(secret_delete),
        )
        .route(
            "/api/workspaces/{workspace_id}/webhooks",
            get(webhooks).post(webhook_create),
        )
        .route(
            "/api/workspaces/{workspace_id}/webhooks/{webhook_id}",
            patch(webhook_update).delete(webhook_delete),
        )
        .route(
            "/api/workspaces/{workspace_id}/webhooks/{webhook_id}/rotate",
            post(webhook_rotate),
        )
        .route(
            "/api/workspaces/{workspace_id}/webhooks/{webhook_id}/test",
            post(webhook_test),
        )
        .route(
            "/api/workspaces/{workspace_id}/webhooks/{webhook_id}/deliveries",
            get(webhook_deliveries),
        )
        .route("/api/webhook-events", get(webhook_events))
        .route("/api/desktops", get(desktops))
        .route("/webhooks/instabox/{workspace_id}", post(webhook_receive))
        .route("/api/ws/terminal/{workspace_id}/{machine_id}", get(ws_terminal))
        .route("/api/ws/vnc/{workspace_id}/{machine_id}", get(ws_vnc))
}

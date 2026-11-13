use serde::Serialize;
use serde_json::Value;

use crate::instabox::ApiError;
use crate::state::SharedState;
use crate::store::Workspace;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncSummary {
    pub workspace_id: String,
    pub label: String,
    pub machines: usize,
    pub error: Option<String>,
}

fn internal(err: impl std::fmt::Display) -> ApiError {
    ApiError::local("store_error", err.to_string())
}

fn text<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(Value::as_str)
}

/// Pull one workspace's machines, identity and usage into the local cache.
/// The caller is responsible for holding the sync lock.
pub async fn sync_workspace(state: &SharedState, ws: &Workspace) -> Result<usize, ApiError> {
    let key = state.key_for(ws).await?;

    let (me, usage, machines) = tokio::join!(
        state.ib.me(&key),
        state.ib.usage(&key),
        state.ib.list_machines(&key),
    );

    let me = me?;
    let machines = machines?;
    let usage_json = match usage {
        Ok(u) => Some(serde_json::to_string(&u).unwrap_or_else(|_| "null".into())),
        Err(err) => {
            tracing::warn!(workspace = %ws.label, error = %err, "usage fetch failed");
            None
        }
    };

    let org = me.get("org");
    let org_id = org.and_then(|o| text(o, "id")).or_else(|| text(&me, "orgId"));
    let org_name = org.and_then(|o| text(o, "name"));
    let tier = org.and_then(|o| text(o, "tier"));
    let login = text(&me, "login").or_else(|| text(&me, "name"));

    state
        .store
        .update_workspace_meta(&ws.id, org_id, org_name, tier, login)
        .await
        .map_err(internal)?;

    state
        .store
        .replace_machines(&ws.id, &machines)
        .await
        .map_err(internal)?;

    state
        .store
        .mark_synced(&ws.id, usage_json.as_deref())
        .await
        .map_err(internal)?;

    let count = machines.len();
    state.emit("fleet", Some(&ws.id), None);
    tracing::debug!(workspace = %ws.label, machines = count, "synced");
    Ok(count)
}

pub async fn sync_one(state: &SharedState, workspace_id: &str) -> Result<usize, ApiError> {
    let _guard = state.sync_lock.lock().await;
    let ws = state
        .store
        .get_workspace(workspace_id)
        .await
        .map_err(internal)?
        .ok_or_else(|| ApiError::local("not_found", "workspace not found"))?;

    match sync_workspace(state, &ws).await {
        Ok(n) => Ok(n),
        Err(err) => {
            let _ = state.store.mark_sync_error(&ws.id, &err.to_string()).await;
            state.emit("error", Some(&ws.id), None);
            Err(err)
        }
    }
}

pub async fn sync_all(state: &SharedState) -> Vec<SyncSummary> {
    let _guard = state.sync_lock.lock().await;
    let workspaces = match state.store.list_workspaces().await {
        Ok(w) => w,
        Err(err) => {
            tracing::error!(error = %err, "cannot list workspaces");
            return Vec::new();
        }
    };

    let mut out = Vec::with_capacity(workspaces.len());
    for ws in workspaces {
        match sync_workspace(state, &ws).await {
            Ok(count) => out.push(SyncSummary {
                workspace_id: ws.id.clone(),
                label: ws.label.clone(),
                machines: count,
                error: None,
            }),
            Err(err) => {
                let _ = state.store.mark_sync_error(&ws.id, &err.to_string()).await;
                tracing::warn!(workspace = %ws.label, error = %err, "sync failed");
                out.push(SyncSummary {
                    workspace_id: ws.id.clone(),
                    label: ws.label.clone(),
                    machines: 0,
                    error: Some(err.to_string()),
                });
            }
        }
    }

    state.emit("fleet", None, None);
    out
}

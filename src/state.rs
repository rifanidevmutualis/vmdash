use std::sync::Arc;

use serde::Serialize;
use tokio::sync::{broadcast, RwLock};

use crate::config::Config;
use crate::crypto::Vault;
use crate::instabox::{ApiError, IbClient};
use crate::store::{Store, Workspace};

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Event {
    pub kind: String,
    pub workspace_id: Option<String>,
    pub machine_id: Option<String>,
    pub at: String,
}

pub struct AppState {
    pub config: Config,
    pub store: Store,
    pub vault: Vault,
    pub ib: IbClient,
    pub events: broadcast::Sender<Event>,
    pub sync_lock: tokio::sync::Mutex<()>,
    pub mcp_token: RwLock<String>,
}

impl AppState {
    pub async fn key_for(&self, ws: &Workspace) -> Result<String, ApiError> {
        self.vault.open(&ws.key_cipher).map_err(|e| {
            ApiError::local(
                "key_unreadable",
                format!("cannot decrypt the stored key: {e}"),
            )
        })
    }

    pub fn emit(&self, kind: &str, workspace_id: Option<&str>, machine_id: Option<&str>) {
        let _ = self.events.send(Event {
            kind: kind.to_string(),
            workspace_id: workspace_id.map(str::to_string),
            machine_id: machine_id.map(str::to_string),
            at: crate::store::now(),
        });
    }

    pub async fn mcp_token(&self) -> String {
        self.mcp_token.read().await.clone()
    }
}

pub type SharedState = Arc<AppState>;

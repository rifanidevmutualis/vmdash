mod api;
mod config;
mod crypto;
mod extras;
mod instabox;
mod mcp;
mod state;
mod store;
mod sync;

use std::sync::Arc;
use std::time::Duration;

use anyhow::Result;
use axum::extract::{Request, State};
use axum::http::{header, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use axum::{Json, Router};
use serde_json::json;
use tower_http::services::{ServeDir, ServeFile};
use tower_http::trace::TraceLayer;

use crate::config::Config;
use crate::crypto::Vault;
use crate::instabox::IbClient;
use crate::state::{AppState, SharedState};
use crate::store::Store;
use crate::sync::sync_all;

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "vmdash=info,tower_http=warn".into()),
        )
        .with_writer(std::io::stderr)
        .init();

    let config = Config::from_env()?;

    #[cfg(unix)]
    {
        // The database holds encrypted API keys. Keep the data directory and
        // every SQLite file (including WAL/SHM) private to this user.
        unsafe {
            libc::umask(0o077);
        }
        std::fs::create_dir_all(&config.data_dir)?;
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(
            &config.data_dir,
            std::fs::Permissions::from_mode(0o700),
        );
    }

    let store = Store::open(&config.db_path()).await?;
    let vault = Vault::load_or_create(&config.master_key_path())?;

    let token = match &config.mcp_token_env {
        Some(t) => t.clone(),
        None => match store.get_setting("mcp_token").await? {
            Some(t) => t,
            None => {
                let t = api::random_token();
                store.set_setting("mcp_token", &t).await?;
                t
            }
        },
    };

    let (events, _) = tokio::sync::broadcast::channel(256);
    let state: SharedState = Arc::new(AppState {
        ib: IbClient::new(config.api_base.clone()),
        config: config.clone(),
        store,
        vault,
        events,
        sync_lock: tokio::sync::Mutex::new(()),
        mcp_token: tokio::sync::RwLock::new(token.clone()),
    });

    let stdio_mode = std::env::args().any(|a| a == "mcp-stdio");

    start_poller(state.clone());
    resume_operations(state.clone()).await;

    if stdio_mode {
        tracing::info!("serving MCP over stdio");
        let _ = sync_all(&state).await;
        mcp::run_stdio(state.clone()).await?;
        return Ok(());
    }

    let addr = config.addr();
    let mcp_url = format!("http://{addr}/mcp");

    let api_router = api::router(state.clone()).layer(middleware::from_fn(host_guard));
    let mcp_router = Router::new()
        .route(
            "/mcp",
            post(mcp::mcp_http)
                .get(mcp::mcp_get)
                .delete(mcp::mcp_get),
        )
        .route_layer(middleware::from_fn_with_state(state.clone(), mcp_auth))
        .with_state(state.clone());

    let index = config.web_dir.as_ref().map(|dir| dir.join("index.html"));
    let app = Router::new().merge(api_router).merge(mcp_router);
    let app = match (&config.web_dir, &index) {
        (Some(dir), Some(index)) => app.fallback_service(
            ServeDir::new(dir).not_found_service(ServeFile::new(index)),
        ),
        _ => app.fallback(static_handler),
    };
    let app = app.layer(TraceLayer::new_for_http());

    let listener = tokio::net::TcpListener::bind(addr).await?;

    println!();
    println!("  vmdash {}  ·  local fleet control plane", env!("CARGO_PKG_VERSION"));
    println!("  dashboard   http://{addr}");
    println!("  MCP (HTTP)  {mcp_url}");
    println!("  MCP token   {token}");
    println!("  data        {}", config.data_dir.display());
    if !index.as_ref().map(|path| path.exists()).unwrap_or(true) {
        println!();
        println!("  ! web/dist is missing. Build the UI:  cd web && npm install && npm run build");
    }
    println!();

    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await?;
    Ok(())
}

fn start_poller(state: SharedState) {
    let secs = state.config.sync_secs;
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_secs(1)).await;
        loop {
            let _ = sync_all(&state).await;
            tokio::time::sleep(Duration::from_secs(secs)).await;
        }
    });
}

async fn resume_operations(state: SharedState) {
    if let Ok(ops) = state.store.pending_operations().await {
        for op in ops {
            api::spawn_operation_watch(state.clone(), op.workspace_id, op.id);
        }
    }
}

async fn mcp_auth(
    State(state): State<SharedState>,
    request: Request,
    next: Next,
) -> Response {
    let token = state.mcp_token().await;
    let headers = request.headers();

    let auth_ok = headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .map(|v| v == format!("Bearer {token}") || v == token)
        .unwrap_or(false)
        || headers
            .get("x-mcp-token")
            .and_then(|v| v.to_str().ok())
            .map(|v| v == token)
            .unwrap_or(false);

    let query_ok = request
        .uri()
        .query()
        .map(|q| {
            q.split('&')
                .any(|pair| pair == format!("token={token}"))
        })
        .unwrap_or(false);

    if auth_ok || query_ok {
        next.run(request).await
    } else {
        (
            StatusCode::UNAUTHORIZED,
            Json(json!({
                "error": "missing MCP token",
                "hint": "send Authorization: Bearer <token>, X-MCP-Token: <token>, or ?token=<token>. The dashboard shows the token under MCP."
            })),
        )
            .into_response()
    }
}

async fn shutdown_signal() {
    let _ = tokio::signal::ctrl_c().await;
    tracing::info!("shutting down");
}

#[derive(rust_embed::RustEmbed)]
#[folder = "web/dist/"]
struct Assets;

fn embedded_asset(path: &str) -> Option<Response> {
    let asset = Assets::get(path)?;
    let mime = mime_guess::from_path(path).first_or_octet_stream();
    let cache = if path.starts_with("assets/") {
        "public, max-age=31536000, immutable"
    } else {
        "no-cache"
    };
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, mime.as_ref())
        .header(header::CACHE_CONTROL, cache)
        .body(axum::body::Body::from(asset.data.into_owned()))
        .ok()
}

/// Serves the embedded SPA and falls back to index.html for client routes.
async fn static_handler(uri: axum::http::Uri) -> Response {
    let path = uri.path().trim_start_matches('/');
    let path = if path.is_empty() { "index.html" } else { path };

    if let Some(resp) = embedded_asset(path) {
        return resp;
    }
    if !path.contains('.') {
        if let Some(resp) = embedded_asset("index.html") {
            return resp;
        }
    }
    (StatusCode::NOT_FOUND, "not found").into_response()
}

/// Refuse cross-origin browser access via DNS rebinding. The dashboard holds
/// InstaBox API keys, so it only answers on loopback unless the operator opts
/// out for a tunnel.
async fn host_guard(request: Request, next: Next) -> Response {
    if std::env::var("VMDASH_ALLOW_ANY_HOST").ok().as_deref() == Some("1") {
        return next.run(request).await;
    }

    let host = request
        .headers()
        .get("host")
        .and_then(|value| value.to_str().ok())
        .unwrap_or("");
    let hostname = if let Some(rest) = host.strip_prefix('[') {
        rest.split(']').next().unwrap_or("")
    } else {
        host.split(':').next().unwrap_or("")
    };

    if matches!(hostname, "127.0.0.1" | "localhost" | "::1")
        || request.uri().path().starts_with("/webhooks/")
    {
        next.run(request).await
    } else {
        (
            StatusCode::FORBIDDEN,
            Json(json!({
                "error": {
                    "code": "forbidden_host",
                    "message": "This server only answers on localhost. Set VMDASH_ALLOW_ANY_HOST=1 to allow a tunnel."
                }
            })),
        )
            .into_response()
    }
}

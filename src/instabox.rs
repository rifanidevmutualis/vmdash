use std::time::Duration;

use reqwest::{Method, StatusCode};
use serde::Deserialize;
use serde_json::{json, Value};

#[derive(Debug, Clone)]
pub struct ApiError {
    pub status: Option<u16>,
    pub code: String,
    pub message: String,
    pub retryable: bool,
    pub retry_after_seconds: Option<u64>,
    pub required_scopes: Vec<String>,
}

impl ApiError {
    pub fn transport(message: impl Into<String>) -> Self {
        Self {
            status: None,
            code: "transport_error".into(),
            message: message.into(),
            retryable: true,
            retry_after_seconds: None,
            required_scopes: Vec::new(),
        }
    }

    pub fn local(code: &str, message: impl Into<String>) -> Self {
        Self {
            status: None,
            code: code.into(),
            message: message.into(),
            retryable: false,
            retry_after_seconds: None,
            required_scopes: Vec::new(),
        }
    }
}

impl std::fmt::Display for ApiError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "[{}] {}", self.code, self.message)
    }
}

impl std::error::Error for ApiError {}

impl From<ApiError> for serde_json::Value {
    fn from(err: ApiError) -> Self {
        json!({
            "code": err.code,
            "message": err.message,
            "retryable": err.retryable,
            "retryAfterSeconds": err.retry_after_seconds,
            "requiredScopes": err.required_scopes,
        })
    }
}

#[derive(Debug, Deserialize)]
struct ErrorEnvelope {
    error: ErrorPayload,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ErrorPayload {
    code: String,
    message: String,
    #[serde(default)]
    retryable: bool,
    #[serde(default)]
    retry_after_seconds: Option<u64>,
    #[serde(default)]
    required_scopes: Vec<String>,
}

#[derive(Clone)]
pub struct IbClient {
    http: reqwest::Client,
    base: String,
}

pub fn new_idempotency_key() -> String {
    uuid::Uuid::new_v4().to_string()
}

impl IbClient {
    pub fn new(base: impl Into<String>) -> Self {
        let http = reqwest::Client::builder()
            .user_agent(concat!("vmdash/", env!("CARGO_PKG_VERSION")))
            .connect_timeout(Duration::from_secs(10))
            .pool_max_idle_per_host(8)
            .build()
            .expect("building HTTP client");
        Self {
            http,
            base: base.into().trim_end_matches('/').to_string(),
        }
    }

    async fn call(
        &self,
        method: Method,
        path: &str,
        key: &str,
        body: Option<Value>,
        idem: Option<&str>,
        confirm_delete: Option<&str>,
        timeout: Duration,
    ) -> Result<Value, ApiError> {
        let url = format!("{}{}", self.base, path);
        let mut req = self
            .http
            .request(method, &url)
            .header("X-API-Key", key)
            .header("Accept", "application/json")
            .timeout(timeout);

        if let Some(body) = body {
            req = req.json(&body);
        }
        if let Some(idem) = idem {
            req = req.header("Idempotency-Key", idem);
        }
        if let Some(confirm) = confirm_delete {
            req = req.header("X-Confirm-Delete", confirm);
        }

        let resp = req
            .send()
            .await
            .map_err(|e| ApiError::transport(format!("{url}: {e}")))?;
        let status = resp.status();
        let text = resp
            .text()
            .await
            .map_err(|e| ApiError::transport(format!("reading response: {e}")))?;

        if status.is_success() {
            if text.trim().is_empty() {
                return Ok(Value::Null);
            }
            return serde_json::from_str(&text).map_err(|e| {
                ApiError::transport(format!("invalid JSON from InstaBox ({status}): {e}"))
            });
        }

        let parsed: Option<ErrorEnvelope> = serde_json::from_str(&text).ok();
        if let Some(env) = parsed {
            return Err(ApiError {
                status: Some(status.as_u16()),
                code: env.error.code,
                message: env.error.message,
                retryable: env.error.retryable,
                retry_after_seconds: env.error.retry_after_seconds,
                required_scopes: env.error.required_scopes,
            });
        }

        Err(ApiError {
            status: Some(status.as_u16()),
            code: status_name(status),
            message: text.chars().take(500).collect(),
            retryable: status == StatusCode::TOO_MANY_REQUESTS || status.is_server_error(),
            retry_after_seconds: None,
            required_scopes: Vec::new(),
        })
    }
    pub async fn me(&self, key: &str) -> Result<Value, ApiError> {
        self.call(Method::GET, "/v1/me", key, None, None, None, Duration::from_secs(20))
            .await
    }

    pub async fn usage(&self, key: &str) -> Result<Value, ApiError> {
        self.call(Method::GET, "/v1/usage", key, None, None, None, Duration::from_secs(30))
            .await
    }

    pub async fn list_machines(&self, key: &str) -> Result<Vec<Value>, ApiError> {
        let mut out = Vec::new();
        let mut cursor: Option<String> = None;

        for _ in 0..50 {
            let mut path = String::from("/v1/machines?limit=100");
            if let Some(c) = &cursor {
                path.push_str("&cursor=");
                path.push_str(&urlencoding::encode(c));
            }
            let page = self
                .call(Method::GET, &path, key, None, None, None, Duration::from_secs(30))
                .await?;
            if let Some(items) = page.get("machines").and_then(Value::as_array) {
                out.extend(items.iter().cloned());
            }
            cursor = page
                .get("nextCursor")
                .and_then(Value::as_str)
                .map(str::to_string);
            if cursor.is_none() {
                break;
            }
        }
        Ok(out)
    }

    pub async fn get_machine(&self, key: &str, id: &str) -> Result<Value, ApiError> {
        self.call(
            Method::GET,
            &format!("/v1/machines/{id}"),
            key,
            None,
            None,
            None,
            Duration::from_secs(20),
        )
        .await
    }

    pub async fn create_machine(
        &self,
        key: &str,
        body: Value,
        idem: &str,
    ) -> Result<Value, ApiError> {
        self.call(
            Method::POST,
            "/v1/machines",
            key,
            Some(body),
            Some(idem),
            None,
            Duration::from_secs(40),
        )
        .await
    }

    pub async fn action(&self, key: &str, id: &str, action: &str) -> Result<Value, ApiError> {
        let (method, path) = match action {
            "start" => (Method::POST, format!("/v1/machines/{id}/start")),
            "stop" => (Method::POST, format!("/v1/machines/{id}/stop")),
            "suspend" | "pause" => (Method::POST, format!("/v1/machines/{id}/suspend")),
            "resume" => (Method::POST, format!("/v1/machines/{id}/resume")),
            "delete" => (Method::DELETE, format!("/v1/machines/{id}")),
            other => {
                return Err(ApiError::local(
                    "bad_request",
                    format!("unknown action {other}"),
                ))
            }
        };

        let idem = new_idempotency_key();
        self.call(
            method,
            &path,
            key,
            None,
            Some(&idem),
            if action == "delete" { Some(id) } else { None },
            Duration::from_secs(30),
        )
        .await
    }

    pub async fn exec(
        &self,
        key: &str,
        id: &str,
        cmd: &str,
        timeout_seconds: u64,
    ) -> Result<Value, ApiError> {
        self.call(
            Method::POST,
            &format!("/v1/machines/{id}/exec"),
            key,
            Some(json!({ "cmd": cmd, "timeoutSeconds": timeout_seconds })),
            None,
            None,
            Duration::from_secs(timeout_seconds + 30),
        )
        .await
    }

    pub async fn operation_wait(&self, key: &str, id: &str, seconds: u64) -> Result<Value, ApiError> {
        self.call(
            Method::GET,
            &format!("/v1/operations/{id}?wait={seconds}s"),
            key,
            None,
            None,
            None,
            Duration::from_secs(seconds + 10),
        )
        .await
    }
}

fn status_name(status: StatusCode) -> String {
    if status == StatusCode::UNAUTHORIZED {
        "unauthenticated".into()
    } else if status == StatusCode::FORBIDDEN {
        "permission_denied".into()
    } else if status == StatusCode::NOT_FOUND {
        "not_found".into()
    } else if status == StatusCode::TOO_MANY_REQUESTS {
        "rate_limited".into()
    } else if status.is_server_error() {
        "internal".into()
    } else {
        "bad_request".into()
    }
}

// ── Extended surface: files, SSH, desktop, ports, snapshots, config, telemetry,
//    secrets and webhooks. Kept in its own impl block so the lifecycle client
//    above stays readable.

fn parse_api_error(status: StatusCode, text: &str) -> ApiError {
    if let Ok(env) = serde_json::from_str::<ErrorEnvelope>(text) {
        return ApiError {
            status: Some(status.as_u16()),
            code: env.error.code,
            message: env.error.message,
            retryable: env.error.retryable,
            retry_after_seconds: env.error.retry_after_seconds,
            required_scopes: env.error.required_scopes,
        };
    }
    ApiError {
        status: Some(status.as_u16()),
        code: status_name(status),
        message: text.chars().take(500).collect(),
        retryable: status == StatusCode::TOO_MANY_REQUESTS || status.is_server_error(),
        retry_after_seconds: None,
        required_scopes: Vec::new(),
    }
}

impl IbClient {
    pub fn ws_endpoint(&self, path: &str) -> String {
        let base = self.base.replacen("https://", "wss://", 1);
        let base = base.replacen("http://", "ws://", 1);
        format!("{base}{path}")
    }

    async fn get_json(&self, key: &str, path: &str, timeout: u64) -> Result<Value, ApiError> {
        self.call(
            Method::GET,
            path,
            key,
            None,
            None,
            None,
            Duration::from_secs(timeout),
        )
        .await
    }

    async fn post_json(&self, key: &str, path: &str, body: Option<Value>) -> Result<Value, ApiError> {
        let idem = new_idempotency_key();
        self.call(
            Method::POST,
            path,
            key,
            body,
            Some(&idem),
            None,
            Duration::from_secs(45),
        )
        .await
    }

    async fn patch_json(&self, key: &str, path: &str, body: Value) -> Result<Value, ApiError> {
        self.call(
            Method::PATCH,
            path,
            key,
            Some(body),
            None,
            None,
            Duration::from_secs(45),
        )
        .await
    }

    async fn delete_json(
        &self,
        key: &str,
        path: &str,
        confirm: Option<&str>,
    ) -> Result<Value, ApiError> {
        let idem = new_idempotency_key();
        self.call(
            Method::DELETE,
            path,
            key,
            None,
            Some(&idem),
            confirm,
            Duration::from_secs(45),
        )
        .await
    }

    pub async fn raw_get(
        &self,
        key: &str,
        path: &str,
        timeout: u64,
    ) -> Result<reqwest::Response, ApiError> {
        let url = format!("{}{}", self.base, path);
        let resp = self
            .http
            .get(&url)
            .header("X-API-Key", key)
            .timeout(Duration::from_secs(timeout))
            .send()
            .await
            .map_err(|e| ApiError::transport(format!("{url}: {e}")))?;
        if resp.status().is_success() {
            Ok(resp)
        } else {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            Err(parse_api_error(status, &text))
        }
    }

    pub async fn upload_file_stream(
        &self,
        key: &str,
        id: &str,
        path: &str,
        body: reqwest::Body,
        mode: Option<&str>,
        parents: bool,
    ) -> Result<Value, ApiError> {
        let mut url = format!(
            "{}/v1/machines/{}/files?path={}",
            self.base,
            id,
            urlencoding::encode(path)
        );
        if let Some(mode) = mode {
            url.push_str("&mode=");
            url.push_str(&urlencoding::encode(mode));
        }
        if parents {
            url.push_str("&parents=true");
        }
        let resp = self
            .http
            .put(&url)
            .header("X-API-Key", key)
            .header("Accept", "application/json")
            .timeout(Duration::from_secs(7200))
            .body(body)
            .send()
            .await
            .map_err(|e| ApiError::transport(format!("upload failed: {e}")))?;
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        if status.is_success() {
            Ok(serde_json::from_str(&text).unwrap_or(Value::Null))
        } else {
            Err(parse_api_error(status, &text))
        }
    }

    pub async fn list_files(&self, key: &str, id: &str, path: &str) -> Result<Value, ApiError> {
        self.get_json(
            key,
            &format!("/v1/machines/{id}/files?path={}", urlencoding::encode(path)),
            45,
        )
        .await
    }

    pub async fn download_file(
        &self,
        key: &str,
        id: &str,
        path: &str,
    ) -> Result<reqwest::Response, ApiError> {
        self.raw_get(
            key,
            &format!(
                "/v1/machines/{id}/files/content?path={}",
                urlencoding::encode(path)
            ),
            7200,
        )
        .await
    }

    // SSH tokens
    pub async fn ssh_tokens(&self, key: &str, id: &str) -> Result<Value, ApiError> {
        self.get_json(key, &format!("/v1/machines/{id}/ssh-tokens"), 30)
            .await
    }

    pub async fn ssh_token_create(
        &self,
        key: &str,
        id: &str,
        name: Option<&str>,
        ttl_seconds: Option<u64>,
    ) -> Result<Value, ApiError> {
        let mut body = serde_json::Map::new();
        if let Some(name) = name {
            body.insert("name".into(), json!(name));
        }
        if let Some(ttl) = ttl_seconds {
            body.insert("ttlSeconds".into(), json!(ttl));
        }
        self.post_json(
            key,
            &format!("/v1/machines/{id}/ssh-tokens"),
            Some(Value::Object(body)),
        )
        .await
    }

    pub async fn ssh_token_revoke(&self, key: &str, id: &str, token_id: &str) -> Result<(), ApiError> {
        self.delete_json(key, &format!("/v1/machines/{id}/ssh-tokens/{token_id}"), None)
            .await?;
        Ok(())
    }

    pub async fn ssh_tokens_revoke_all(&self, key: &str, id: &str) -> Result<Value, ApiError> {
        self.delete_json(key, &format!("/v1/machines/{id}/ssh-tokens"), None)
            .await
    }

    // Desktop
    pub async fn desktop(
        &self,
        key: &str,
        id: &str,
        action: &str,
        width: Option<u32>,
        height: Option<u32>,
    ) -> Result<Value, ApiError> {
        let mut body = serde_json::Map::new();
        body.insert("action".into(), json!(action));
        if let Some(width) = width {
            body.insert("width".into(), json!(width));
        }
        if let Some(height) = height {
            body.insert("height".into(), json!(height));
        }
        self.post_json(
            key,
            &format!("/v1/machines/{id}/desktop"),
            Some(Value::Object(body)),
        )
        .await
    }

    pub async fn desktop_stream(
        &self,
        key: &str,
        id: &str,
        view_only: bool,
        ttl_seconds: Option<u64>,
    ) -> Result<Value, ApiError> {
        let mut body = serde_json::Map::new();
        body.insert("viewOnly".into(), json!(view_only));
        if let Some(ttl) = ttl_seconds {
            body.insert("ttlSeconds".into(), json!(ttl));
        }
        self.post_json(
            key,
            &format!("/v1/machines/{id}/desktop/stream"),
            Some(Value::Object(body)),
        )
        .await
    }

    pub async fn desktop_stream_revoke(&self, key: &str, id: &str) -> Result<(), ApiError> {
        self.delete_json(key, &format!("/v1/machines/{id}/desktop/stream"), None)
            .await?;
        Ok(())
    }

    // Ports
    pub async fn ports(&self, key: &str, id: &str) -> Result<Value, ApiError> {
        self.get_json(key, &format!("/v1/machines/{id}/ports"), 30)
            .await
    }

    pub async fn port_publish(
        &self,
        key: &str,
        id: &str,
        body: Value,
    ) -> Result<Value, ApiError> {
        self.post_json(key, &format!("/v1/machines/{id}/ports"), Some(body))
            .await
    }

    pub async fn port_unpublish(&self, key: &str, id: &str, port: u16) -> Result<(), ApiError> {
        self.delete_json(key, &format!("/v1/machines/{id}/ports/{port}"), None)
            .await?;
        Ok(())
    }

    pub async fn machine_usage(&self, key: &str) -> Result<Value, ApiError> {
        self.get_json(
            key,
            "/v1/usage/machines?limit=100&sort=computeUSD&order=desc",
            45,
        )
        .await
    }

    pub async fn snapshots(&self, key: &str) -> Result<Value, ApiError> {
        self.get_json(key, "/v1/snapshots", 45).await
    }

    pub async fn snapshot_create(
        &self,
        key: &str,
        id: &str,
        name: &str,
        description: Option<&str>,
        root_only: bool,
        for_fork: bool,
    ) -> Result<Value, ApiError> {
        let mut body = serde_json::Map::new();
        body.insert("name".into(), json!(name));
        if let Some(description) = description.filter(|d| !d.is_empty()) {
            body.insert("description".into(), json!(description));
        }
        if root_only {
            body.insert("rootOnly".into(), json!(true));
        }
        if for_fork {
            body.insert("forFork".into(), json!(true));
        }
        self.post_json(
            key,
            &format!("/v1/machines/{id}/snapshots"),
            Some(Value::Object(body)),
        )
        .await
    }

    pub async fn snapshot_delete(&self, key: &str, snapshot_id: &str) -> Result<(), ApiError> {
        self.delete_json(
            key,
            &format!("/v1/snapshots/{snapshot_id}"),
            Some(snapshot_id),
        )
        .await?;
        Ok(())
    }

    pub async fn restore(
        &self,
        key: &str,
        id: &str,
        snapshot_id: &str,
        desired_state: Option<&str>,
    ) -> Result<Value, ApiError> {
        let mut body = serde_json::Map::new();
        body.insert("snapshotId".into(), json!(snapshot_id));
        if let Some(state) = desired_state {
            body.insert("desiredState".into(), json!(state));
        }
        self.post_json(
            key,
            &format!("/v1/machines/{id}/restore"),
            Some(Value::Object(body)),
        )
        .await
    }

    pub async fn fork(
        &self,
        key: &str,
        id: &str,
        body: Value,
    ) -> Result<Value, ApiError> {
        self.post_json(key, &format!("/v1/machines/{id}/fork"), Some(body))
            .await
    }

    // Machine config
    pub async fn patch_machine(&self, key: &str, id: &str, body: Value) -> Result<Value, ApiError> {
        self.patch_json(key, &format!("/v1/machines/{id}"), body)
            .await
    }

    // Telemetry
    pub async fn metrics(&self, key: &str, id: &str, since: Option<&str>) -> Result<Value, ApiError> {
        let path = match since {
            Some(since) => format!(
                "/v1/machines/{id}/metrics?since={}",
                urlencoding::encode(since)
            ),
            None => format!("/v1/machines/{id}/metrics"),
        };
        self.get_json(key, &path, 45).await
    }

    pub async fn logs(&self, key: &str, id: &str, tail: Option<u32>) -> Result<Value, ApiError> {
        let path = match tail {
            Some(tail) => format!("/v1/machines/{id}/logs?tail={tail}"),
            None => format!("/v1/machines/{id}/logs"),
        };
        self.get_json(key, &path, 45).await
    }

    pub async fn history(&self, key: &str, id: &str, limit: u32) -> Result<Value, ApiError> {
        self.get_json(
            key,
            &format!("/v1/machines/{id}/history?limit={limit}"),
            30,
        )
        .await
    }

    // Org secrets
    pub async fn org_secrets(&self, key: &str, org_id: &str) -> Result<Value, ApiError> {
        self.get_json(key, &format!("/v1/orgs/{org_id}/secrets"), 30)
            .await
    }

    pub async fn org_secret_put(
        &self,
        key: &str,
        org_id: &str,
        name: &str,
        value: &str,
        delivery: &str,
        hosts: Option<Vec<String>>,
    ) -> Result<Value, ApiError> {
        let mut body = serde_json::Map::new();
        body.insert("value".into(), json!(value));
        body.insert("delivery".into(), json!(delivery));
        if let Some(hosts) = hosts {
            body.insert("hosts".into(), json!(hosts));
        }
        self.call(
            Method::PUT,
            &format!("/v1/orgs/{org_id}/secrets/{name}"),
            key,
            Some(Value::Object(body)),
            None,
            None,
            Duration::from_secs(30),
        )
        .await
    }

    pub async fn org_secret_delete(&self, key: &str, org_id: &str, name: &str) -> Result<(), ApiError> {
        self.delete_json(key, &format!("/v1/orgs/{org_id}/secrets/{name}"), None)
            .await?;
        Ok(())
    }

    pub async fn machine_secrets(&self, key: &str, id: &str) -> Result<Value, ApiError> {
        self.get_json(key, &format!("/v1/machines/{id}/secrets"), 30)
            .await
    }

    pub async fn machine_secrets_patch(
        &self,
        key: &str,
        id: &str,
        body: Value,
    ) -> Result<Value, ApiError> {
        self.patch_json(key, &format!("/v1/machines/{id}/secrets"), body)
            .await
    }

    pub async fn machine_secrets_refresh(&self, key: &str, id: &str) -> Result<Value, ApiError> {
        self.post_json(key, &format!("/v1/machines/{id}/secrets"), None)
            .await
    }

    // Webhooks
    pub async fn webhooks(&self, key: &str, org_id: &str) -> Result<Value, ApiError> {
        self.get_json(key, &format!("/v1/orgs/{org_id}/webhooks"), 30)
            .await
    }

    pub async fn webhook_create(
        &self,
        key: &str,
        org_id: &str,
        body: Value,
    ) -> Result<Value, ApiError> {
        self.post_json(key, &format!("/v1/orgs/{org_id}/webhooks"), Some(body))
            .await
    }

    pub async fn webhook_update(
        &self,
        key: &str,
        org_id: &str,
        webhook_id: &str,
        body: Value,
    ) -> Result<Value, ApiError> {
        self.patch_json(
            key,
            &format!("/v1/orgs/{org_id}/webhooks/{webhook_id}"),
            body,
        )
        .await
    }

    pub async fn webhook_delete(
        &self,
        key: &str,
        org_id: &str,
        webhook_id: &str,
    ) -> Result<(), ApiError> {
        self.delete_json(
            key,
            &format!("/v1/orgs/{org_id}/webhooks/{webhook_id}"),
            None,
        )
        .await?;
        Ok(())
    }

    pub async fn webhook_rotate(
        &self,
        key: &str,
        org_id: &str,
        webhook_id: &str,
    ) -> Result<Value, ApiError> {
        self.post_json(
            key,
            &format!("/v1/orgs/{org_id}/webhooks/{webhook_id}/rotate"),
            None,
        )
        .await
    }

    pub async fn webhook_test(
        &self,
        key: &str,
        org_id: &str,
        webhook_id: &str,
    ) -> Result<Value, ApiError> {
        self.post_json(
            key,
            &format!("/v1/orgs/{org_id}/webhooks/{webhook_id}/test"),
            None,
        )
        .await
    }

    pub async fn webhook_deliveries(
        &self,
        key: &str,
        org_id: &str,
        webhook_id: &str,
        limit: u32,
    ) -> Result<Value, ApiError> {
        self.get_json(
            key,
            &format!("/v1/orgs/{org_id}/webhooks/{webhook_id}/deliveries?limit={limit}"),
            30,
        )
        .await
    }
}

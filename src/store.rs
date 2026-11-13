use std::path::Path;
use std::time::Duration;

use anyhow::{Context, Result};
use serde::Serialize;
use serde_json::Value;
use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions};
use sqlx::{FromRow, SqlitePool};

#[derive(Clone)]
pub struct Store {
    pool: SqlitePool,
}

#[derive(Clone, Debug, Serialize, FromRow)]
#[serde(rename_all = "camelCase")]
pub struct Workspace {
    pub id: String,
    pub label: String,
    #[serde(skip_serializing)]
    pub key_cipher: String,
    #[serde(skip_serializing)]
    #[allow(dead_code)]
    pub key_fingerprint: String,
    pub org_id: Option<String>,
    pub org_name: Option<String>,
    pub tier: Option<String>,
    pub login: Option<String>,
    pub created_at: String,
    pub last_synced_at: Option<String>,
    pub last_error: Option<String>,
    #[serde(skip_serializing)]
    pub usage_json: Option<String>,
    pub machine_count: i64,
}

#[derive(Clone, Debug, Serialize, FromRow)]
#[serde(rename_all = "camelCase")]
pub struct MachineRow {
    pub workspace_id: String,
    pub id: String,
    pub name: String,
    pub state: String,
    pub desired_state: Option<String>,
    pub template: Option<String>,
    pub vcpus: Option<i64>,
    pub mem_mib: Option<i64>,
    pub disk_gib: Option<i64>,
    pub auto_suspend_seconds: Option<i64>,
    pub created_at: Option<String>,
    pub updated_at: Option<String>,
    pub raw_json: String,
}

impl MachineRow {
    pub fn to_json(&self, workspace: Option<&Workspace>) -> Value {
        let mut value: Value = serde_json::from_str(&self.raw_json).unwrap_or(Value::Null);
        if let Some(obj) = value.as_object_mut() {
            obj.insert("workspaceId".into(), Value::String(self.workspace_id.clone()));
            if let Some(ws) = workspace {
                obj.insert("workspaceLabel".into(), Value::String(ws.label.clone()));
                obj.insert(
                    "workspaceOrg".into(),
                    ws.org_name.clone().map(Value::String).unwrap_or(Value::Null),
                );
                obj.insert(
                    "workspaceTier".into(),
                    ws.tier.clone().map(Value::String).unwrap_or(Value::Null),
                );
            }
            obj.insert("cachedState".into(), Value::String(self.state.clone()));
        }
        value
    }
}

#[derive(Clone, Debug, Serialize, FromRow)]
#[serde(rename_all = "camelCase")]
pub struct OperationRow {
    pub id: String,
    pub workspace_id: String,
    pub machine_id: Option<String>,
    pub kind: String,
    pub state: String,
    pub error: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Clone, Debug, Serialize, FromRow)]
#[serde(rename_all = "camelCase")]
pub struct AuditRow {
    pub id: i64,
    pub ts: String,
    pub workspace_id: Option<String>,
    pub machine_id: Option<String>,
    pub action: String,
    pub detail: Option<String>,
    pub ok: i64,
}

pub fn now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

impl Store {
    pub async fn open(path: &Path) -> Result<Self> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }

        let options = SqliteConnectOptions::new()
            .filename(path)
            .create_if_missing(true)
            .journal_mode(SqliteJournalMode::Wal)
            .busy_timeout(Duration::from_secs(5));

        let pool = SqlitePoolOptions::new()
            .max_connections(6)
            .connect_with(options)
            .await
            .with_context(|| format!("opening {}", path.display()))?;

        let store = Self { pool };
        store.migrate().await?;
        Ok(store)
    }

    async fn migrate(&self) -> Result<()> {
        let schema = r#"
        CREATE TABLE IF NOT EXISTS workspaces (
            id TEXT PRIMARY KEY,
            label TEXT NOT NULL,
            key_hint TEXT NOT NULL,
            key_cipher TEXT NOT NULL,
            key_fingerprint TEXT NOT NULL UNIQUE,
            org_id TEXT,
            org_name TEXT,
            tier TEXT,
            login TEXT,
            created_at TEXT NOT NULL,
            last_synced_at TEXT,
            last_error TEXT,
            usage_json TEXT
        );

        CREATE TABLE IF NOT EXISTS machines (
            workspace_id TEXT NOT NULL,
            id TEXT NOT NULL,
            name TEXT NOT NULL,
            state TEXT NOT NULL,
            desired_state TEXT,
            template TEXT,
            vcpus INTEGER,
            mem_mib INTEGER,
            disk_gib INTEGER,
            auto_suspend_seconds INTEGER,
            created_at TEXT,
            updated_at TEXT,
            raw_json TEXT NOT NULL,
            PRIMARY KEY (workspace_id, id)
        );
        CREATE INDEX IF NOT EXISTS machines_name ON machines(name);

        CREATE TABLE IF NOT EXISTS operations (
            id TEXT PRIMARY KEY,
            workspace_id TEXT NOT NULL,
            machine_id TEXT,
            kind TEXT NOT NULL,
            state TEXT NOT NULL,
            error TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS operations_created ON operations(created_at DESC);

        CREATE TABLE IF NOT EXISTS audit (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            ts TEXT NOT NULL,
            workspace_id TEXT,
            machine_id TEXT,
            action TEXT NOT NULL,
            detail TEXT,
            ok INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS audit_ts ON audit(ts DESC);

        CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS webhook_secrets (
            webhook_id TEXT PRIMARY KEY,
            workspace_id TEXT NOT NULL,
            secret_cipher TEXT NOT NULL,
            created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS webhook_events (
            id TEXT PRIMARY KEY,
            workspace_id TEXT NOT NULL,
            event_type TEXT NOT NULL,
            payload TEXT NOT NULL,
            received_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS webhook_events_received ON webhook_events(received_at DESC);

        CREATE TABLE IF NOT EXISTS schedules (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            action TEXT NOT NULL,
            scope TEXT NOT NULL,
            workspace_id TEXT,
            machine_ids TEXT,
            kind TEXT NOT NULL,
            time_of_day TEXT,
            minute INTEGER,
            run_at TEXT,
            enabled INTEGER NOT NULL DEFAULT 1,
            next_run_at TEXT,
            last_run_at TEXT,
            last_result TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS schedules_due ON schedules(enabled, next_run_at);
        "#;
        sqlx::raw_sql(schema).execute(&self.pool).await?;
        Ok(())
    }

    pub async fn list_workspaces(&self) -> Result<Vec<Workspace>> {
        let rows = sqlx::query_as::<_, Workspace>(
            r#"SELECT w.id, w.label, w.key_cipher, w.key_fingerprint,
                      w.org_id, w.org_name, w.tier, w.login, w.created_at,
                      w.last_synced_at, w.last_error, w.usage_json,
                      (SELECT COUNT(*) FROM machines m WHERE m.workspace_id = w.id) AS machine_count
               FROM workspaces w ORDER BY w.created_at ASC"#,
        )
        .fetch_all(&self.pool)
        .await?;
        Ok(rows)
    }

    pub async fn get_workspace(&self, id: &str) -> Result<Option<Workspace>> {
        let row = sqlx::query_as::<_, Workspace>(
            r#"SELECT w.id, w.label, w.key_cipher, w.key_fingerprint,
                      w.org_id, w.org_name, w.tier, w.login, w.created_at,
                      w.last_synced_at, w.last_error, w.usage_json,
                      (SELECT COUNT(*) FROM machines m WHERE m.workspace_id = w.id) AS machine_count
               FROM workspaces w WHERE w.id = ?"#,
        )
        .bind(id)
        .fetch_optional(&self.pool)
        .await?;
        Ok(row)
    }

    pub async fn find_workspace_by_fingerprint(&self, fp: &str) -> Result<Option<Workspace>> {
        let row = sqlx::query_as::<_, Workspace>(
            r#"SELECT w.id, w.label, w.key_cipher, w.key_fingerprint,
                      w.org_id, w.org_name, w.tier, w.login, w.created_at,
                      w.last_synced_at, w.last_error, w.usage_json,
                      (SELECT COUNT(*) FROM machines m WHERE m.workspace_id = w.id) AS machine_count
               FROM workspaces w WHERE w.key_fingerprint = ?"#,
        )
        .bind(fp)
        .fetch_optional(&self.pool)
        .await?;
        Ok(row)
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn insert_workspace(
        &self,
        id: &str,
        label: &str,
        key_hint: &str,
        key_cipher: &str,
        key_fingerprint: &str,
        org_id: Option<&str>,
        org_name: Option<&str>,
        tier: Option<&str>,
        login: Option<&str>,
    ) -> Result<()> {
        sqlx::query(
            r#"INSERT INTO workspaces
               (id, label, key_hint, key_cipher, key_fingerprint, org_id, org_name, tier, login, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"#,
        )
        .bind(id)
        .bind(label)
        .bind(key_hint)
        .bind(key_cipher)
        .bind(key_fingerprint)
        .bind(org_id)
        .bind(org_name)
        .bind(tier)
        .bind(login)
        .bind(now())
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn delete_workspace(&self, id: &str) -> Result<()> {
        let mut tx = self.pool.begin().await?;
        sqlx::query("DELETE FROM machines WHERE workspace_id = ?")
            .bind(id)
            .execute(&mut *tx)
            .await?;
        sqlx::query("DELETE FROM operations WHERE workspace_id = ?")
            .bind(id)
            .execute(&mut *tx)
            .await?;
        sqlx::query("DELETE FROM workspaces WHERE id = ?")
            .bind(id)
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
        Ok(())
    }

    pub async fn update_workspace_meta(
        &self,
        id: &str,
        org_id: Option<&str>,
        org_name: Option<&str>,
        tier: Option<&str>,
        login: Option<&str>,
    ) -> Result<()> {
        sqlx::query(
            "UPDATE workspaces SET org_id = ?, org_name = ?, tier = ?, login = ? WHERE id = ?",
        )
        .bind(org_id)
        .bind(org_name)
        .bind(tier)
        .bind(login)
        .bind(id)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn mark_synced(&self, id: &str, usage_json: Option<&str>) -> Result<()> {
        sqlx::query(
            "UPDATE workspaces SET last_synced_at = ?, last_error = NULL, usage_json = COALESCE(?, usage_json) WHERE id = ?",
        )
        .bind(now())
        .bind(usage_json)
        .bind(id)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn mark_sync_error(&self, id: &str, error: &str) -> Result<()> {
        sqlx::query("UPDATE workspaces SET last_error = ?, last_synced_at = ? WHERE id = ?")
            .bind(error)
            .bind(now())
            .bind(id)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    pub async fn replace_machines(&self, workspace_id: &str, machines: &[Value]) -> Result<()> {
        let mut tx = self.pool.begin().await?;
        sqlx::query("DELETE FROM machines WHERE workspace_id = ?")
            .bind(workspace_id)
            .execute(&mut *tx)
            .await?;

        for m in machines {
            let id = m.get("id").and_then(Value::as_str).unwrap_or_default();
            if id.is_empty() {
                continue;
            }
            let name = m.get("name").and_then(Value::as_str).unwrap_or(id);
            let state = m
                .get("state")
                .and_then(Value::as_str)
                .unwrap_or("unknown");
            let desired = m.get("desiredState").and_then(Value::as_str);
            let template = m
                .get("template")
                .and_then(|t| t.get("id"))
                .and_then(Value::as_str);
            let spec = m.get("spec");
            let vcpus = spec.and_then(|s| s.get("vcpus")).and_then(Value::as_i64);
            let mem = spec.and_then(|s| s.get("memMiB")).and_then(Value::as_i64);
            let disk = spec
                .and_then(|s| s.get("persistentDiskGiB"))
                .and_then(Value::as_i64);
            let auto = m
                .get("autoSuspendAfterSeconds")
                .and_then(Value::as_i64);
            let created = m.get("createdAt").and_then(Value::as_str);
            let updated = m.get("updatedAt").and_then(Value::as_str);

            sqlx::query(
                r#"INSERT INTO machines
                   (workspace_id, id, name, state, desired_state, template, vcpus, mem_mib,
                    disk_gib, auto_suspend_seconds, created_at, updated_at, raw_json)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"#,
            )
            .bind(workspace_id)
            .bind(id)
            .bind(name)
            .bind(state)
            .bind(desired)
            .bind(template)
            .bind(vcpus)
            .bind(mem)
            .bind(disk)
            .bind(auto)
            .bind(created)
            .bind(updated)
            .bind(serde_json::to_string(m)?)
            .execute(&mut *tx)
            .await?;
        }

        tx.commit().await?;
        Ok(())
    }

    pub async fn list_machines(&self) -> Result<Vec<MachineRow>> {
        let rows = sqlx::query_as::<_, MachineRow>(
            "SELECT * FROM machines ORDER BY name ASC",
        )
        .fetch_all(&self.pool)
        .await?;
        Ok(rows)
    }

    pub async fn get_machine(&self, workspace_id: &str, id: &str) -> Result<Option<MachineRow>> {
        let row = sqlx::query_as::<_, MachineRow>(
            "SELECT * FROM machines WHERE workspace_id = ? AND id = ?",
        )
        .bind(workspace_id)
        .bind(id)
        .fetch_optional(&self.pool)
        .await?;
        Ok(row)
    }

    pub async fn upsert_operation(
        &self,
        id: &str,
        workspace_id: &str,
        machine_id: Option<&str>,
        kind: &str,
        state: &str,
        error: Option<&str>,
    ) -> Result<()> {
        sqlx::query(
            r#"INSERT INTO operations (id, workspace_id, machine_id, kind, state, error, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(id) DO UPDATE SET
                 state = excluded.state,
                 error = excluded.error,
                 machine_id = COALESCE(excluded.machine_id, operations.machine_id),
                 updated_at = excluded.updated_at"#,
        )
        .bind(id)
        .bind(workspace_id)
        .bind(machine_id)
        .bind(kind)
        .bind(state)
        .bind(error)
        .bind(now())
        .bind(now())
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn pending_operations(&self) -> Result<Vec<OperationRow>> {
        let rows = sqlx::query_as::<_, OperationRow>(
            "SELECT * FROM operations WHERE state IN ('queued','running') ORDER BY created_at DESC LIMIT 50",
        )
        .fetch_all(&self.pool)
        .await?;
        Ok(rows)
    }

    pub async fn list_operations(&self, limit: i64) -> Result<Vec<OperationRow>> {
        let rows = sqlx::query_as::<_, OperationRow>(
            "SELECT * FROM operations ORDER BY created_at DESC LIMIT ?",
        )
        .bind(limit)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows)
    }

    pub async fn audit(
        &self,
        workspace_id: Option<&str>,
        machine_id: Option<&str>,
        action: &str,
        detail: Option<&str>,
        ok: bool,
    ) -> Result<()> {
        sqlx::query(
            "INSERT INTO audit (ts, workspace_id, machine_id, action, detail, ok) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .bind(now())
        .bind(workspace_id)
        .bind(machine_id)
        .bind(action)
        .bind(detail)
        .bind(if ok { 1 } else { 0 })
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn list_audit(&self, limit: i64) -> Result<Vec<AuditRow>> {
        let rows = sqlx::query_as::<_, AuditRow>(
            "SELECT * FROM audit ORDER BY id DESC LIMIT ?",
        )
        .bind(limit)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows)
    }

    pub async fn get_setting(&self, key: &str) -> Result<Option<String>> {
        let row: Option<(String,)> = sqlx::query_as("SELECT value FROM settings WHERE key = ?")
            .bind(key)
            .fetch_optional(&self.pool)
            .await?;
        Ok(row.map(|r| r.0))
    }

    pub async fn set_setting(&self, key: &str, value: &str) -> Result<()> {
        sqlx::query(
            "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        )
        .bind(key)
        .bind(value)
        .execute(&self.pool)
        .await?;
        Ok(())
    }
}

#[derive(Clone, Debug, Serialize, FromRow)]
#[serde(rename_all = "camelCase")]
pub struct WebhookEventRow {
    pub id: String,
    pub workspace_id: String,
    pub event_type: String,
    pub payload: String,
    pub received_at: String,
}

impl Store {
    pub async fn put_webhook_secret(
        &self,
        webhook_id: &str,
        workspace_id: &str,
        secret_cipher: &str,
    ) -> Result<()> {
        sqlx::query(
            r#"INSERT INTO webhook_secrets (webhook_id, workspace_id, secret_cipher, created_at)
               VALUES (?, ?, ?, ?)
               ON CONFLICT(webhook_id) DO UPDATE SET
                 workspace_id = excluded.workspace_id,
                 secret_cipher = excluded.secret_cipher,
                 created_at = excluded.created_at"#,
        )
        .bind(webhook_id)
        .bind(workspace_id)
        .bind(secret_cipher)
        .bind(now())
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn delete_webhook_secret(&self, webhook_id: &str) -> Result<()> {
        sqlx::query("DELETE FROM webhook_secrets WHERE webhook_id = ?")
            .bind(webhook_id)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    pub async fn webhook_secrets(&self, workspace_id: &str) -> Result<Vec<String>> {
        let rows: Vec<(String,)> = sqlx::query_as(
            "SELECT secret_cipher FROM webhook_secrets WHERE workspace_id = ?",
        )
        .bind(workspace_id)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows.into_iter().map(|row| row.0).collect())
    }

    pub async fn add_webhook_event(
        &self,
        id: &str,
        workspace_id: &str,
        event_type: &str,
        payload: &str,
    ) -> Result<()> {
        sqlx::query(
            "INSERT OR IGNORE INTO webhook_events (id, workspace_id, event_type, payload, received_at) VALUES (?, ?, ?, ?, ?)",
        )
        .bind(id)
        .bind(workspace_id)
        .bind(event_type)
        .bind(payload)
        .bind(now())
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn list_webhook_events(&self, limit: i64) -> Result<Vec<WebhookEventRow>> {
        let rows = sqlx::query_as::<_, WebhookEventRow>(
            "SELECT * FROM webhook_events ORDER BY received_at DESC LIMIT ?",
        )
        .bind(limit)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows)
    }
}

#[derive(Clone, Debug, Serialize, FromRow)]
#[serde(rename_all = "camelCase")]
pub struct Schedule {
    pub id: String,
    pub name: String,
    pub action: String,
    pub scope: String,
    pub workspace_id: Option<String>,
    pub machine_ids: Option<String>,
    pub kind: String,
    pub time_of_day: Option<String>,
    pub minute: Option<i64>,
    pub run_at: Option<String>,
    pub enabled: i64,
    pub next_run_at: Option<String>,
    pub last_run_at: Option<String>,
    pub last_result: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

impl Store {
    pub async fn list_schedules(&self) -> Result<Vec<Schedule>> {
        let rows = sqlx::query_as::<_, Schedule>(
            "SELECT * FROM schedules ORDER BY created_at DESC",
        )
        .fetch_all(&self.pool)
        .await?;
        Ok(rows)
    }

    pub async fn get_schedule(&self, id: &str) -> Result<Option<Schedule>> {
        let row = sqlx::query_as::<_, Schedule>("SELECT * FROM schedules WHERE id = ?")
            .bind(id)
            .fetch_optional(&self.pool)
            .await?;
        Ok(row)
    }

    pub async fn insert_schedule(&self, schedule: &Schedule) -> Result<()> {
        sqlx::query(
            r#"INSERT INTO schedules
               (id, name, action, scope, workspace_id, machine_ids, kind, time_of_day,
                minute, run_at, enabled, next_run_at, last_run_at, last_result,
                created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"#,
        )
        .bind(&schedule.id)
        .bind(&schedule.name)
        .bind(&schedule.action)
        .bind(&schedule.scope)
        .bind(&schedule.workspace_id)
        .bind(&schedule.machine_ids)
        .bind(&schedule.kind)
        .bind(&schedule.time_of_day)
        .bind(schedule.minute)
        .bind(&schedule.run_at)
        .bind(schedule.enabled)
        .bind(&schedule.next_run_at)
        .bind(&schedule.last_run_at)
        .bind(&schedule.last_result)
        .bind(&schedule.created_at)
        .bind(&schedule.updated_at)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn delete_schedule(&self, id: &str) -> Result<()> {
        sqlx::query("DELETE FROM schedules WHERE id = ?")
            .bind(id)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    pub async fn set_schedule_next(&self, id: &str, next: Option<&str>) -> Result<()> {
        sqlx::query("UPDATE schedules SET next_run_at = ?, updated_at = ? WHERE id = ?")
            .bind(next)
            .bind(now())
            .bind(id)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    pub async fn set_schedule_enabled(
        &self,
        id: &str,
        enabled: bool,
        next: Option<&str>,
    ) -> Result<()> {
        sqlx::query(
            "UPDATE schedules SET enabled = ?, next_run_at = ?, updated_at = ? WHERE id = ?",
        )
        .bind(if enabled { 1 } else { 0 })
        .bind(next)
        .bind(now())
        .bind(id)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn finish_schedule(
        &self,
        id: &str,
        last_run_at: &str,
        result: &str,
        next: Option<&str>,
        enabled: bool,
    ) -> Result<()> {
        sqlx::query(
            r#"UPDATE schedules SET last_run_at = ?, last_result = ?, next_run_at = ?,
               enabled = ?, updated_at = ? WHERE id = ?"#,
        )
        .bind(last_run_at)
        .bind(result)
        .bind(next)
        .bind(if enabled { 1 } else { 0 })
        .bind(now())
        .bind(id)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn due_schedules(&self, now: &str) -> Result<Vec<Schedule>> {
        let rows = sqlx::query_as::<_, Schedule>(
            "SELECT * FROM schedules WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ? ORDER BY next_run_at ASC LIMIT 20",
        )
        .bind(now)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows)
    }
}

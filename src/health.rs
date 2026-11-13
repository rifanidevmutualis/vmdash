use std::collections::HashMap;

use axum::extract::{Query, State};
use axum::http::StatusCode;
use axum::routing::{get, put};
use axum::{Json, Router};
use chrono::{DateTime, Utc};
use futures_util::{stream, StreamExt};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::api::ApiErr;
use crate::state::SharedState;
use crate::store::{now, Workspace};

#[derive(Deserialize, Default)]
pub struct HealthQuery {
    #[serde(default)]
    pub fresh: bool,
}

fn parse_time(value: &Value, key: &str) -> Option<DateTime<Utc>> {
    value
        .get(key)
        .and_then(Value::as_str)
        .and_then(|raw| DateTime::parse_from_rfc3339(raw).ok())
        .map(|value| value.with_timezone(&Utc))
}

fn projected_cost(usage: &Value) -> Option<f64> {
    let cost = usage.get("cost")?;
    let value = cost.get("costUSD")?.as_f64()?;
    let start = parse_time(cost, "periodStart")?;
    let end = parse_time(cost, "periodEnd")?;
    let total = (end - start).num_seconds().max(1) as f64;
    let elapsed = (Utc::now() - start).num_seconds().clamp(0, total as i64) as f64;
    if elapsed <= 0.0 {
        None
    } else {
        Some(value * total / elapsed)
    }
}

fn number(value: &Value, path: &[&str]) -> Option<f64> {
    let mut current = value;
    for key in path {
        current = current.get(key)?;
    }
    current.as_f64()
}

fn machine_index(machine_usage: &Value) -> HashMap<String, Value> {
    let mut map = HashMap::new();
    if let Some(items) = machine_usage.get("machines").and_then(Value::as_array) {
        for item in items {
            if let Some(id) = item.get("id").and_then(Value::as_str) {
                map.insert(id.to_string(), item.clone());
            }
        }
    }
    map
}

fn hourly_rate(cost: Option<&Value>, vcpus: i64, mem_mib: i64) -> f64 {
    if cost
        .and_then(|item| item.get("free"))
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        return 0.0;
    }
    (vcpus as f64 * 0.004) + (mem_mib as f64 / 1024.0 * 0.00225)
}

pub async fn overview(
    State(state): State<SharedState>,
    Query(query): Query<HealthQuery>,
) -> Result<Json<Value>, ApiErr> {
    if !query.fresh {
        let cache = state.health_cache.lock().await;
        if let Some((at, value)) = cache.as_ref() {
            if at.elapsed() < std::time::Duration::from_secs(30) {
                return Ok(Json(value.clone()));
            }
        }
    }

    let workspaces = state.store.list_workspaces().await?;
    let machines = state.store.list_machines().await?;

    let mut keys = HashMap::new();
    for workspace in &workspaces {
        if let Ok(key) = state.key_for(workspace).await {
            keys.insert(workspace.id.clone(), key);
        }
    }

    struct WorkspaceResult {
        workspace: Workspace,
        usage: Value,
        machine_usage: Value,
        projected: Option<f64>,
        error: Option<String>,
    }

    let results: Vec<WorkspaceResult> = stream::iter(workspaces.clone())
        .map(|workspace| {
            let state = state.clone();
            let key = keys.get(&workspace.id).cloned();
            async move {
                let Some(key) = key else {
                    return WorkspaceResult {
                        workspace,
                        usage: Value::Null,
                        machine_usage: Value::Null,
                        projected: None,
                        error: Some("Cannot decrypt workspace key".into()),
                    };
                };

                let (live_usage, live_machines) =
                    tokio::join!(state.ib.usage(&key), state.ib.machine_usage(&key));
                let usage = match live_usage {
                    Ok(value) => value,
                    Err(err) => {
                        tracing::warn!(error = %err, "health usage fetch failed");
                        workspace
                            .usage_json
                            .as_deref()
                            .and_then(|raw| serde_json::from_str(raw).ok())
                            .unwrap_or(Value::Null)
                    }
                };
                let (machine_usage, error) = match live_machines {
                    Ok(value) => (value, None),
                    Err(err) => (Value::Null, Some(err.message)),
                };
                let projected = projected_cost(&usage);
                WorkspaceResult {
                    workspace,
                    usage,
                    machine_usage,
                    projected,
                    error,
                }
            }
        })
        .buffer_unordered(4)
        .collect()
        .await;

    let mut cost_by_machine: HashMap<(String, String), Value> = HashMap::new();
    let mut workspace_views = Vec::new();
    let mut total_cost = 0.0;
    let mut total_projected = 0.0;
    let mut total_credits = 0.0;
    let mut total_allowance = 0.0;
    let mut ws_by_id: HashMap<String, Workspace> = HashMap::new();
    let mut running_by_workspace: HashMap<String, usize> = HashMap::new();
    for row in &machines {
        if row.state == "running" {
            *running_by_workspace
                .entry(row.workspace_id.clone())
                .or_insert(0) += 1;
        }
    }

    for result in &results {
        ws_by_id.insert(result.workspace.id.clone(), result.workspace.clone());
        let usage = &result.usage;
        let cost = number(usage, &["cost", "costUSD"]).unwrap_or(0.0);
        let credits = number(usage, &["cost", "creditsUSD"]).unwrap_or(0.0);
        let allowance = number(usage, &["cost", "allowanceUSD"]).unwrap_or(0.0);
        total_cost += cost;
        total_projected += result.projected.unwrap_or(cost);
        total_credits += credits;
        total_allowance += allowance;

        for (id, item) in machine_index(&result.machine_usage) {
            cost_by_machine.insert((result.workspace.id.clone(), id), item);
        }

        workspace_views.push(json!({
            "workspaceId": result.workspace.id,
            "label": result.workspace.label,
            "orgName": result.workspace.org_name,
            "tier": result.workspace.tier,
            "costUSD": cost,
            "projectedUSD": result.projected,
            "creditsUSD": credits,
            "allowanceUSD": allowance,
            "machines": usage.get("machines").cloned().unwrap_or(Value::Null),
            "running": running_by_workspace.get(&result.workspace.id).copied().unwrap_or(0),
            "snapshots": usage.get("snapshots").cloned().unwrap_or(Value::Null),
            "storedBytes": usage.get("storedBytes").cloned().unwrap_or(Value::Null),
            "limits": usage.get("limits").cloned().unwrap_or(Value::Null),
            "error": result.error,
        }));
    }

    let mut machine_views: Vec<Value> = Vec::new();
    let mut running_candidates: Vec<(crate::store::MachineRow, String)> = Vec::new();
    for row in &machines {
        let workspace = ws_by_id.get(&row.workspace_id);
        let cost = cost_by_machine
            .get(&(row.workspace_id.clone(), row.id.clone()))
            .cloned();
        let mut view = row.to_json(workspace);
        if let Some(cost) = &cost {
            if let Some(obj) = view.as_object_mut() {
                obj.insert("usage".into(), cost.clone());
                obj.insert(
                    "hourlyUSD".into(),
                    json!(hourly_rate(
                        Some(cost),
                        row.vcpus.unwrap_or(4),
                        row.mem_mib.unwrap_or(8192)
                    )),
                );
            }
        }
        if row.state == "running" {
            running_candidates.push((row.clone(), row.workspace_id.clone()));
        }
        machine_views.push(view);
    }

    running_candidates.sort_by(|a, b| {
        let a_cost = cost_by_machine
            .get(&(a.1.clone(), a.0.id.clone()))
            .and_then(|item| item.get("computeUSD"))
            .and_then(Value::as_f64)
            .unwrap_or(0.0);
        let b_cost = cost_by_machine
            .get(&(b.1.clone(), b.0.id.clone()))
            .and_then(|item| item.get("computeUSD"))
            .and_then(Value::as_f64)
            .unwrap_or(0.0);
        b_cost.total_cmp(&a_cost)
    });
    running_candidates.truncate(20);

    let diagnostics: HashMap<(String, String), Value> = stream::iter(running_candidates)
        .map(|(row, workspace_id)| {
            let state = state.clone();
            let key = keys.get(&workspace_id).cloned();
            let usage = cost_by_machine
                .get(&(workspace_id.clone(), row.id.clone()))
                .cloned();
            async move {
                let diag_key = (workspace_id.clone(), row.id.clone());
                let Some(key) = key else {
                    return (diag_key, Value::Null);
                };
                let (metrics, history, ports) = tokio::join!(
                    state.ib.metrics(&key, &row.id, None),
                    state.ib.history(&key, &row.id, 1),
                    state.ib.ports(&key, &row.id),
                );
                let metrics = metrics.ok();
                let history = history.ok();
                let ports = ports.ok();

                let latest = metrics
                    .as_ref()
                    .and_then(|value| value.get("metrics"))
                    .and_then(Value::as_array)
                    .and_then(|items| items.last())
                    .cloned()
                    .unwrap_or(Value::Null);

                let last_exec = history
                    .as_ref()
                    .and_then(|value| value.get("commands"))
                    .and_then(Value::as_array)
                    .and_then(|items| items.first())
                    .cloned()
                    .unwrap_or(Value::Null);

                let port_items: Vec<Value> = ports
                    .as_ref()
                    .and_then(|value| value.get("ports"))
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default()
                    .into_iter()
                    .filter_map(|port| {
                        Some(json!({
                            "port": port.get("port")?.clone(),
                            "access": port.get("access")?.clone(),
                            "url": port.get("url")?.clone(),
                        }))
                    })
                    .collect();

                let cpu = latest
                    .get("cpuUsedPct")
                    .and_then(Value::as_f64)
                    .unwrap_or(0.0);
                let last_exec_seconds = last_exec
                    .get("startedAt")
                    .and_then(Value::as_str)
                    .and_then(|raw| DateTime::parse_from_rfc3339(raw).ok())
                    .map(|value| (Utc::now() - value.with_timezone(&Utc)).num_seconds())
                    .unwrap_or(i64::MAX);
                let running_seconds = usage
                    .as_ref()
                    .and_then(|value| value.get("runningSeconds"))
                    .and_then(Value::as_i64)
                    .unwrap_or(0);
                let max_run_minutes = serde_json::from_str::<Value>(&row.raw_json)
                    .ok()
                    .and_then(|value| value.get("maxRunMinutes").and_then(Value::as_i64))
                    .unwrap_or(-1);

                let mut hints: Vec<String> = Vec::new();
                if cpu >= 20.0 {
                    hints.push("CPU is busy".into());
                } else if cpu < 5.0 {
                    hints.push("CPU is low".into());
                }
                if last_exec_seconds != i64::MAX && last_exec_seconds > 1800 {
                    hints.push(format!("No exec for {}m", last_exec_seconds / 60));
                }
                if !port_items.is_empty() {
                    hints.push("Public port is open; requests can keep it awake".into());
                }
                if row.auto_suspend_seconds.unwrap_or(1800) == 0 {
                    hints.push("Idle pause is off".into());
                }

                let possible_idle = cpu < 5.0
                    && port_items.is_empty()
                    && (last_exec_seconds == i64::MAX || last_exec_seconds > 1800)
                    && row.auto_suspend_seconds.unwrap_or(1800) > 0;

                (diag_key, json!({
                    "metricsAvailable": !latest.is_null(),
                    "cpuPct": cpu,
                    "memUsed": latest.get("memUsed").cloned().unwrap_or(Value::Null),
                    "memTotal": latest.get("memTotal").cloned().unwrap_or(Value::Null),
                    "diskUsed": latest.get("diskUsed").cloned().unwrap_or(Value::Null),
                    "diskTotal": latest.get("diskTotal").cloned().unwrap_or(Value::Null),
                    "netInBytesPerSec": latest.get("netInBytesPerSec").cloned().unwrap_or(Value::Null),
                    "netOutBytesPerSec": latest.get("netOutBytesPerSec").cloned().unwrap_or(Value::Null),
                    "runningSeconds": running_seconds,
                    "maxRunMinutes": max_run_minutes,
                    "lastExec": last_exec,
                    "ports": port_items,
                    "hints": hints,
                    "possibleIdle": possible_idle,
                }))
            }
        })
        .buffer_unordered(4)
        .collect::<Vec<_>>()
        .await
        .into_iter()
        .collect();

    for view in &mut machine_views {
        let Some(obj) = view.as_object_mut() else { continue };
        let workspace_id = obj.get("workspaceId").and_then(Value::as_str).unwrap_or("");
        let machine_id = obj.get("id").and_then(Value::as_str).unwrap_or("");
        if let Some(diag) = diagnostics.get(&(workspace_id.to_string(), machine_id.to_string())) {
            obj.insert("diagnostics".into(), diag.clone());
        }
    }

    let budget = state
        .store
        .get_setting("monthly_budget_usd")
        .await?
        .and_then(|value| value.parse::<f64>().ok());

    let payload = json!({
        "generatedAt": now(),
        "budgetUSD": budget,
        "totalCostUSD": total_cost,
        "projectedUSD": total_projected,
        "creditsUSD": total_credits,
        "allowanceUSD": total_allowance,
        "workspaces": workspace_views,
        "machines": machine_views,
        "pricing": {
            "vcpuHourUSD": 0.004,
            "memGiBHourUSD": 0.00225,
            "storageGiBMonthUSD": 0.08,
            "egressGiBUSD": 0.02,
        },
        "freeNote": "Free-plan machines are never billed; their computeUSD is 0.",
    });
    *state.health_cache.lock().await = Some((std::time::Instant::now(), payload.clone()));
    Ok(Json(payload))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BudgetBody {
    #[serde(rename = "monthlyUSD")]
    pub monthly_usd: Option<f64>,
}

pub async fn set_budget(
    State(state): State<SharedState>,
    Json(body): Json<BudgetBody>,
) -> Result<Json<Value>, ApiErr> {
    if let Some(value) = body.monthly_usd {
        if !value.is_finite() || value < 0.0 {
            return Err(ApiErr::new(
                StatusCode::BAD_REQUEST,
                "bad_request",
                "monthlyUSD must be a positive number",
            ));
        }
        state
            .store
            .set_setting("monthly_budget_usd", &value.to_string())
            .await?;
    } else {
        state
            .store
            .set_setting("monthly_budget_usd", "")
            .await?;
    }
    *state.health_cache.lock().await = None;
    let _ = state
        .store
        .audit(None, None, "health.budget", body.monthly_usd.map(|v| v.to_string()).as_deref(), true)
        .await;
    Ok(Json(json!({ "budgetUSD": body.monthly_usd })))
}

pub fn routes() -> Router<SharedState> {
    Router::new()
        .route("/api/health/overview", get(overview))
        .route("/api/health/budget", put(set_budget))
}

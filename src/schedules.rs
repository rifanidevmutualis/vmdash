use std::collections::HashSet;

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::routing::{delete, get, patch, post};
use axum::{Json, Router};
use chrono::{DateTime, Datelike, Duration as ChronoDuration, Local, NaiveTime, TimeZone, Timelike, Utc, Weekday};
use futures_util::{stream, StreamExt};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::api::ApiErr;
use crate::state::SharedState;
use crate::store::{now, Schedule};

fn local_dt(naive: chrono::NaiveDateTime) -> Option<DateTime<Local>> {
    Local.from_local_datetime(&naive).earliest()
}

fn parse_time(value: &str) -> Option<NaiveTime> {
    NaiveTime::parse_from_str(value, "%H:%M")
        .ok()
        .or_else(|| NaiveTime::parse_from_str(value, "%H:%M:%S").ok())
}

pub fn compute_next(schedule: &Schedule, from: DateTime<Local>) -> Option<String> {
    match schedule.kind.as_str() {
        "once" => {
            let run_at = schedule.run_at.as_deref()?;
            let when = DateTime::parse_from_rfc3339(run_at).ok()?.with_timezone(&Utc);
            if when > from.with_timezone(&Utc) {
                Some(when.to_rfc3339())
            } else {
                None
            }
        }
        "daily" => {
            let time = parse_time(schedule.time_of_day.as_deref()?)?;
            let mut date = from.date_naive();
            let mut candidate = local_dt(date.and_time(time))?;
            if candidate <= from {
                date = date + ChronoDuration::days(1);
                candidate = local_dt(date.and_time(time))?;
            }
            Some(candidate.with_timezone(&Utc).to_rfc3339())
        }
        "weekdays" => {
            let time = parse_time(schedule.time_of_day.as_deref()?)?;
            let mut date = from.date_naive();
            for _ in 0..8 {
                let candidate = local_dt(date.and_time(time))?;
                let weekend = matches!(date.weekday(), Weekday::Sat | Weekday::Sun);
                if candidate > from && !weekend {
                    return Some(candidate.with_timezone(&Utc).to_rfc3339());
                }
                date = date + ChronoDuration::days(1);
            }
            None
        }
        "hourly" => {
            let minute = schedule.minute.unwrap_or(0).clamp(0, 59) as u32;
            let mut candidate = from
                .with_minute(minute)?
                .with_second(0)?
                .with_nanosecond(0)?;
            if candidate <= from {
                candidate = candidate + ChronoDuration::hours(1);
            }
            Some(candidate.with_timezone(&Utc).to_rfc3339())
        }
        _ => None,
    }
}

fn schedule_view(schedule: &Schedule) -> Value {
    let machine_ids = schedule
        .machine_ids
        .as_deref()
        .and_then(|raw| serde_json::from_str::<Value>(raw).ok())
        .unwrap_or(Value::Null);
    let last_result = schedule
        .last_result
        .as_deref()
        .and_then(|raw| serde_json::from_str::<Value>(raw).ok())
        .unwrap_or(Value::Null);
    json!({
        "id": schedule.id,
        "name": schedule.name,
        "action": schedule.action,
        "scope": schedule.scope,
        "workspaceId": schedule.workspace_id,
        "machineIds": machine_ids,
        "kind": schedule.kind,
        "timeOfDay": schedule.time_of_day,
        "minute": schedule.minute,
        "runAt": schedule.run_at,
        "enabled": schedule.enabled == 1,
        "nextRunAt": schedule.next_run_at,
        "lastRunAt": schedule.last_run_at,
        "lastResult": last_result,
        "createdAt": schedule.created_at,
        "updatedAt": schedule.updated_at,
    })
}

fn applies(action: &str, state: &str) -> bool {
    match action {
        "start" => matches!(state, "stopped" | "error"),
        "resume" => state == "suspended",
        "suspend" | "stop" => state == "running",
        _ => false,
    }
}

async fn execute(state: &SharedState, schedule: &Schedule) -> Value {
    let machines = match state.store.list_machines().await {
        Ok(rows) => rows,
        Err(err) => {
            return json!({ "ok": 0, "failed": 0, "skipped": 0, "error": err.to_string() })
        }
    };
    let workspaces = match state.store.list_workspaces().await {
        Ok(rows) => rows,
        Err(err) => {
            return json!({ "ok": 0, "failed": 0, "skipped": 0, "error": err.to_string() })
        }
    };
    let Some(workspace_id) = schedule.workspace_id.as_deref() else {
        return json!({ "ok": 0, "failed": 0, "skipped": 0, "error": "Schedule has no workspace" });
    };
    let Some(workspace) = workspaces.iter().find(|workspace| workspace.id == workspace_id) else {
        return json!({ "ok": 0, "failed": 0, "skipped": 0, "error": "Workspace not found" });
    };
    let key = match state.key_for(workspace).await {
        Ok(key) => key,
        Err(err) => {
            return json!({ "ok": 0, "failed": 0, "skipped": 0, "error": err.message })
        }
    };

    let ids: Option<HashSet<String>> = if schedule.scope == "machines" {
        let Some(raw) = schedule.machine_ids.as_deref() else {
            return json!({ "ok": 0, "failed": 0, "skipped": 0, "error": "Schedule has no machines" });
        };
        let Ok(list) = serde_json::from_str::<Vec<String>>(raw) else {
            return json!({ "ok": 0, "failed": 0, "skipped": 0, "error": "Schedule machine list is invalid" });
        };
        if list.is_empty() {
            return json!({ "ok": 0, "failed": 0, "skipped": 0, "error": "Schedule has no machines" });
        }
        Some(list.into_iter().collect())
    } else {
        None
    };

    let targets: Vec<_> = machines
        .iter()
        .filter(|machine| machine.workspace_id == workspace_id)
        .filter(|machine| ids.as_ref().map(|ids| ids.contains(&machine.id)).unwrap_or(true))
        .cloned()
        .collect();
    let skipped = targets
        .iter()
        .filter(|machine| !applies(&schedule.action, &machine.state))
        .count();
    let actionable: Vec<_> = targets
        .into_iter()
        .filter(|machine| applies(&schedule.action, &machine.state))
        .collect();

    if actionable.is_empty() {
        return json!({
            "ok": 0,
            "failed": 0,
            "skipped": skipped,
            "message": "No machine needed this action",
        });
    }

    let action = schedule.action.clone();
    let name = schedule.name.clone();
    let results: Vec<Value> = stream::iter(actionable)
        .map(|machine| {
            let state = state.clone();
            let key = key.clone();
            let action = action.clone();
            let name = name.clone();
            async move {
                match state.ib.action(&key, &machine.id, &action).await {
                    Ok(operation) => {
                        crate::api::track_operation(
                            &state,
                            &machine.workspace_id,
                            &operation,
                            &format!("schedule.{action}"),
                        );
                        let _ = state
                            .store
                            .audit(
                                Some(&machine.workspace_id),
                                Some(&machine.id),
                                &format!("machine.{action}"),
                                Some(&format!("schedule:{name}")),
                                true,
                            )
                            .await;
                        json!({ "name": machine.name, "ok": true })
                    }
                    Err(err) => {
                        let _ = state
                            .store
                            .audit(
                                Some(&machine.workspace_id),
                                Some(&machine.id),
                                &format!("machine.{action}"),
                                Some(&format!("schedule:{name}")),
                                false,
                            )
                            .await;
                        json!({
                            "name": machine.name,
                            "ok": false,
                            "error": { "code": err.code, "message": err.message },
                        })
                    }
                }
            }
        })
        .buffer_unordered(4)
        .collect()
        .await;

    let ok = results.iter().filter(|item| item["ok"].as_bool().unwrap_or(false)).count();
    json!({
        "ok": ok,
        "failed": results.len() - ok,
        "skipped": skipped,
        "results": results,
    })
}

pub async fn tick(state: &SharedState) {
    let now_utc = Utc::now();
    let due = match state.store.due_schedules(&now_utc.to_rfc3339()).await {
        Ok(rows) => rows,
        Err(err) => {
            tracing::warn!(error = %err, "cannot load schedules");
            return;
        }
    };

    for schedule in due {
        let next_at = schedule
            .next_run_at
            .as_deref()
            .and_then(|value| DateTime::parse_from_rfc3339(value).ok())
            .map(|value| value.with_timezone(&Utc));

        if let Some(next_at) = next_at {
            if now_utc.signed_duration_since(next_at) > ChronoDuration::minutes(5) {
                let next = compute_next(&schedule, Local::now());
                let enabled = schedule.kind != "once";
                let result = json!({
                    "ok": 0,
                    "failed": 0,
                    "skipped": 0,
                    "missed": true,
                    "message": "Window missed while vmdash was offline",
                })
                .to_string();
                let _ = state
                    .store
                    .finish_schedule(
                        &schedule.id,
                        &now_utc.to_rfc3339(),
                        &result,
                        next.as_deref(),
                        enabled,
                    )
                    .await;
                continue;
            }
        }

        let next = compute_next(&schedule, Local::now());
        let keep_enabled = schedule.kind != "once";
        // Claim the slot before running so a slow run cannot be picked twice.
        if state
            .store
            .set_schedule_enabled(&schedule.id, keep_enabled, next.as_deref())
            .await
            .is_err()
        {
            continue;
        }

        let result = execute(state, &schedule).await;
        let result_text = serde_json::to_string(&result).unwrap_or_default();
        let _ = state
            .store
            .finish_schedule(
                &schedule.id,
                &now_utc.to_rfc3339(),
                &result_text,
                next.as_deref(),
                keep_enabled,
            )
            .await;
        state.emit("schedule", schedule.workspace_id.as_deref(), None);
    }
}

pub async fn ensure_next(state: &SharedState) {
    let schedules = state.store.list_schedules().await.unwrap_or_default();
    for schedule in schedules {
        if schedule.enabled != 1 || schedule.next_run_at.is_some() {
            continue;
        }
        let next = compute_next(&schedule, Local::now());
        if next.is_some() {
            let _ = state.store.set_schedule_next(&schedule.id, next.as_deref()).await;
        } else if schedule.kind == "once" {
            let result = json!({
                "ok": 0,
                "failed": 0,
                "skipped": 0,
                "missed": true,
                "message": "One-time schedule missed while vmdash was offline",
            })
            .to_string();
            let _ = state
                .store
                .finish_schedule(&schedule.id, &now(), &result, None, false)
                .await;
        }
    }
}

pub async fn list(State(state): State<SharedState>) -> Result<Json<Value>, ApiErr> {
    let schedules = state.store.list_schedules().await?;
    Ok(Json(json!({
        "schedules": schedules.iter().map(schedule_view).collect::<Vec<_>>(),
        "now": now(),
    })))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateBody {
    pub name: String,
    pub action: String,
    pub scope: String,
    pub workspace_id: String,
    pub machine_ids: Option<Vec<String>>,
    pub kind: String,
    pub time_of_day: Option<String>,
    pub minute: Option<i64>,
    pub run_at: Option<String>,
    pub enabled: Option<bool>,
}

pub async fn create(
    State(state): State<SharedState>,
    Json(body): Json<CreateBody>,
) -> Result<Json<Value>, ApiErr> {
    if !["start", "resume", "suspend", "stop"].contains(&body.action.as_str()) {
        return Err(ApiErr::new(
            StatusCode::BAD_REQUEST,
            "bad_request",
            "action must be start, resume, suspend or stop",
        ));
    }
    if !["workspace", "machines"].contains(&body.scope.as_str()) {
        return Err(ApiErr::new(
            StatusCode::BAD_REQUEST,
            "bad_request",
            "scope must be workspace or machines",
        ));
    }
    if !["daily", "weekdays", "hourly", "once"].contains(&body.kind.as_str()) {
        return Err(ApiErr::new(
            StatusCode::BAD_REQUEST,
            "bad_request",
            "kind must be daily, weekdays, hourly or once",
        ));
    }
    let workspace = state
        .store
        .get_workspace(&body.workspace_id)
        .await?
        .ok_or_else(|| ApiErr::new(StatusCode::NOT_FOUND, "not_found", "Workspace not found"))?;

    if body.scope == "machines" {
        if body.machine_ids.as_ref().map(|ids| ids.is_empty()).unwrap_or(true) {
            return Err(ApiErr::new(
                StatusCode::BAD_REQUEST,
                "bad_request",
                "Choose at least one machine",
            ));
        }
    }
    if matches!(body.kind.as_str(), "daily" | "weekdays") && parse_time(body.time_of_day.as_deref().unwrap_or("")).is_none() {
        return Err(ApiErr::new(
            StatusCode::BAD_REQUEST,
            "bad_request",
            "timeOfDay must be HH:MM",
        ));
    }
    if body.kind == "hourly" && body.minute.map(|m| !(0..=59).contains(&m)).unwrap_or(true) {
        return Err(ApiErr::new(
            StatusCode::BAD_REQUEST,
            "bad_request",
            "minute must be 0-59",
        ));
    }
    if body.kind == "once" {
        let Some(run_at) = body.run_at.as_deref() else {
            return Err(ApiErr::new(
                StatusCode::BAD_REQUEST,
                "bad_request",
                "runAt is required for a one-time schedule",
            ));
        };
        let when = DateTime::parse_from_rfc3339(run_at)
            .map_err(|_| ApiErr::new(StatusCode::BAD_REQUEST, "bad_request", "runAt must be RFC 3339"))?
            .with_timezone(&Utc);
        if when <= Utc::now() {
            return Err(ApiErr::new(
                StatusCode::BAD_REQUEST,
                "bad_request",
                "runAt must be in the future",
            ));
        }
    }

    let schedule = Schedule {
        id: format!("sc_{}", uuid::Uuid::new_v4().simple()),
        name: body.name.trim().to_string(),
        action: body.action,
        scope: body.scope,
        workspace_id: Some(workspace.id.clone()),
        machine_ids: body
            .machine_ids
            .as_ref()
            .map(|ids| serde_json::to_string(ids).unwrap_or_else(|_| "[]".into())),
        kind: body.kind,
        time_of_day: body.time_of_day,
        minute: body.minute,
        run_at: body.run_at,
        enabled: if body.enabled.unwrap_or(true) { 1 } else { 0 },
        next_run_at: None,
        last_run_at: None,
        last_result: None,
        created_at: now(),
        updated_at: now(),
    };
    if schedule.name.is_empty() {
        return Err(ApiErr::new(StatusCode::BAD_REQUEST, "bad_request", "name is required"));
    }

    let next = compute_next(&schedule, Local::now());
    if schedule.enabled == 1 && next.is_none() {
        return Err(ApiErr::new(
            StatusCode::BAD_REQUEST,
            "bad_request",
            "This schedule has no future run",
        ));
    }
    let mut schedule = schedule;
    schedule.next_run_at = if schedule.enabled == 1 { next } else { None };

    state.store.insert_schedule(&schedule).await?;
    let _ = state
        .store
        .audit(
            Some(&workspace.id),
            None,
            "schedule.create",
            Some(&schedule.name),
            true,
        )
        .await;
    state.emit("schedule", Some(&workspace.id), None);
    Ok(Json(json!({ "schedule": schedule_view(&schedule) })))
}

#[derive(Deserialize)]
pub struct ToggleBody {
    pub enabled: bool,
}

pub async fn toggle(
    State(state): State<SharedState>,
    Path(id): Path<String>,
    Json(body): Json<ToggleBody>,
) -> Result<Json<Value>, ApiErr> {
    let schedule = state
        .store
        .get_schedule(&id)
        .await?
        .ok_or_else(|| ApiErr::new(StatusCode::NOT_FOUND, "not_found", "Schedule not found"))?;
    let next = if body.enabled {
        compute_next(&schedule, Local::now())
    } else {
        None
    };
    if body.enabled && next.is_none() {
        return Err(ApiErr::new(
            StatusCode::BAD_REQUEST,
            "bad_request",
            "This schedule has no future run",
        ));
    }
    state
        .store
        .set_schedule_enabled(&id, body.enabled, next.as_deref())
        .await?;
    let updated = state.store.get_schedule(&id).await?;
    Ok(Json(json!({
        "schedule": updated.as_ref().map(schedule_view).unwrap_or(Value::Null)
    })))
}

pub async fn run_now(
    State(state): State<SharedState>,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiErr> {
    let schedule = state
        .store
        .get_schedule(&id)
        .await?
        .ok_or_else(|| ApiErr::new(StatusCode::NOT_FOUND, "not_found", "Schedule not found"))?;
    let result = execute(&state, &schedule).await;
    let result_text = serde_json::to_string(&result).unwrap_or_default();
    let next = if schedule.kind == "once" {
        None
    } else {
        compute_next(&schedule, Local::now())
    };
    let enabled = schedule.kind != "once";
    state
        .store
        .finish_schedule(&id, &now(), &result_text, next.as_deref(), enabled)
        .await?;
    state.emit("schedule", schedule.workspace_id.as_deref(), None);
    Ok(Json(json!({
        "result": result,
        "schedule": schedule_view(&state.store.get_schedule(&id).await?.unwrap_or(schedule)),
    })))
}

pub async fn remove(
    State(state): State<SharedState>,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiErr> {
    state.store.delete_schedule(&id).await?;
    let _ = state
        .store
        .audit(None, None, "schedule.delete", Some(&id), true)
        .await;
    Ok(Json(json!({ "ok": true })))
}

pub fn routes() -> Router<SharedState> {
    Router::new()
        .route("/api/schedules", get(list).post(create))
        .route("/api/schedules/{id}", delete(remove))
        .route("/api/schedules/{id}/toggle", patch(toggle))
        .route("/api/schedules/{id}/run", post(run_now))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(year: i32, month: u32, day: u32, hour: u32, minute: u32) -> DateTime<Local> {
        Local
            .with_ymd_and_hms(year, month, day, hour, minute, 0)
            .single()
            .expect("valid local time")
    }

    fn schedule(kind: &str, time: Option<&str>, minute: Option<i64>, run_at: Option<String>) -> Schedule {
        Schedule {
            id: "sc_test".into(),
            name: "test".into(),
            action: "suspend".into(),
            scope: "workspace".into(),
            workspace_id: Some("ws_test".into()),
            machine_ids: None,
            kind: kind.into(),
            time_of_day: time.map(str::to_string),
            minute,
            run_at,
            enabled: 1,
            next_run_at: None,
            last_run_at: None,
            last_result: None,
            created_at: now(),
            updated_at: now(),
        }
    }

    fn parsed(value: Option<String>) -> DateTime<Utc> {
        DateTime::parse_from_rfc3339(&value.expect("next run"))
            .expect("rfc3339")
            .with_timezone(&Utc)
    }

    #[test]
    fn daily_uses_today_or_tomorrow() {
        let from = at(2026, 11, 13, 10, 0);
        let next = parsed(compute_next(&schedule("daily", Some("23:00"), None, None), from));
        assert_eq!(next, at(2026, 11, 13, 23, 0).with_timezone(&Utc));

        let from = at(2026, 11, 13, 23, 30);
        let next = parsed(compute_next(&schedule("daily", Some("23:00"), None, None), from));
        assert_eq!(next, at(2026, 11, 14, 23, 0).with_timezone(&Utc));
    }

    #[test]
    fn weekdays_skip_the_weekend() {
        // 2026-11-13 is a Friday.
        let from = at(2026, 11, 13, 10, 0);
        let next = parsed(compute_next(&schedule("weekdays", Some("08:00"), None, None), from));
        assert_eq!(next, at(2026, 11, 16, 8, 0).with_timezone(&Utc));
    }

    #[test]
    fn hourly_uses_the_next_minute_slot() {
        let from = at(2026, 11, 13, 10, 30);
        let next = parsed(compute_next(&schedule("hourly", None, Some(15), None), from));
        assert_eq!(next, at(2026, 11, 13, 11, 15).with_timezone(&Utc));
    }

    #[test]
    fn once_requires_a_future_time() {
        let from = at(2026, 11, 13, 10, 0);
        let future = at(2026, 11, 13, 11, 0).to_rfc3339();
        let next = parsed(compute_next(&schedule("once", None, None, Some(future.clone())), from));
        assert_eq!(next, at(2026, 11, 13, 11, 0).with_timezone(&Utc));

        let past = at(2026, 11, 13, 9, 0).to_rfc3339();
        assert!(compute_next(&schedule("once", None, None, Some(past)), from).is_none());
    }
}

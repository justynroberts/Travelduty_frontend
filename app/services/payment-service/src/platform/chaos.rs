use std::time::Duration;

use axum::{
    extract::{Request, State},
    http::{HeaderMap, StatusCode},
    middleware::Next,
    response::{IntoResponse, Response},
    Json,
};
use serde::{Deserialize, Serialize};

use super::errors::{ApiError, ApiJson};
use crate::{AppState, SERVICE_NAME};

#[derive(Debug, Clone, Copy, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ChaosState {
    pub latency_ms: u64,
    pub jitter_ms: u64,
    pub error_rate: f64,
    pub error_status: u16,
}

impl Default for ChaosState {
    fn default() -> Self {
        Self { latency_ms: 0, jitter_ms: 0, error_rate: 0.0, error_status: 503 }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChaosPatch {
    latency_ms: Option<u64>,
    jitter_ms: Option<u64>,
    error_rate: Option<f64>,
    error_status: Option<u16>,
}

impl ChaosPatch {
    fn validate(&self) -> Result<(), ApiError> {
        for (name, v) in [("latencyMs", self.latency_ms), ("jitterMs", self.jitter_ms)] {
            if v.is_some_and(|v| v > 60_000) {
                return Err(ApiError::validation(format!("{name} must be between 0 and 60000")));
            }
        }
        if self.error_rate.is_some_and(|r| !(0.0..=1.0).contains(&r)) {
            return Err(ApiError::validation("errorRate must be between 0 and 1"));
        }
        if self.error_status.is_some_and(|s| !(400..=599).contains(&s)) {
            return Err(ApiError::validation("errorStatus must be between 400 and 599"));
        }
        Ok(())
    }
}

fn is_exempt(path: &str) -> bool {
    ["/health", "/ready", "/metrics", "/admin"]
        .iter()
        .any(|p| path == *p || path.strip_prefix(p).is_some_and(|rest| rest.starts_with('/') || rest.starts_with('?')))
}

/// Injects latency and failures into every non-operational request.
pub async fn middleware(State(state): State<AppState>, req: Request, next: Next) -> Response {
    if is_exempt(req.uri().path()) {
        return next.run(req).await;
    }
    let chaos = *state.chaos.read().expect("chaos lock poisoned");
    let jitter = if chaos.jitter_ms > 0 { rand::random::<f64>() * chaos.jitter_ms as f64 } else { 0.0 };
    let delay = chaos.latency_ms as f64 + jitter;
    if delay > 0.0 {
        tokio::time::sleep(Duration::from_secs_f64(delay / 1000.0)).await;
    }
    if chaos.error_rate > 0.0 && rand::random::<f64>() < chaos.error_rate {
        tracing::warn!(service = SERVICE_NAME, chaos = ?chaos, "chaos: injecting failure");
        let status = StatusCode::from_u16(chaos.error_status).unwrap_or(StatusCode::SERVICE_UNAVAILABLE);
        return ApiError::new(status, "CHAOS_INJECTED", format!("Injected failure in {SERVICE_NAME}")).into_response();
    }
    next.run(req).await
}

fn guard(state: &AppState, headers: &HeaderMap) -> Result<(), ApiError> {
    match &state.config.admin_token {
        Some(token) if headers.get("x-admin-token").and_then(|v| v.to_str().ok()) != Some(token.as_str()) => {
            Err(ApiError::new(StatusCode::UNAUTHORIZED, "UNAUTHORIZED", "A valid x-admin-token header is required"))
        }
        _ => Ok(()),
    }
}

pub async fn get(State(state): State<AppState>, headers: HeaderMap) -> Result<Json<ChaosState>, ApiError> {
    guard(&state, &headers)?;
    Ok(Json(*state.chaos.read().expect("chaos lock poisoned")))
}

pub async fn put(
    State(state): State<AppState>,
    headers: HeaderMap,
    ApiJson(patch): ApiJson<ChaosPatch>,
) -> Result<Json<ChaosState>, ApiError> {
    guard(&state, &headers)?;
    patch.validate()?;
    let mut chaos = state.chaos.write().expect("chaos lock poisoned");
    if let Some(v) = patch.latency_ms {
        chaos.latency_ms = v;
    }
    if let Some(v) = patch.jitter_ms {
        chaos.jitter_ms = v;
    }
    if let Some(v) = patch.error_rate {
        chaos.error_rate = v;
    }
    if let Some(v) = patch.error_status {
        chaos.error_status = v;
    }
    tracing::warn!(service = SERVICE_NAME, chaos = ?*chaos, "chaos: configuration changed");
    Ok(Json(*chaos))
}

pub async fn reset(State(state): State<AppState>, headers: HeaderMap) -> Result<Json<ChaosState>, ApiError> {
    guard(&state, &headers)?;
    let mut chaos = state.chaos.write().expect("chaos lock poisoned");
    *chaos = ChaosState::default();
    tracing::info!(service = SERVICE_NAME, "chaos: reset");
    Ok(Json(*chaos))
}

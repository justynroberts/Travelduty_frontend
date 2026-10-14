//! Cross-service platform conventions from docs/contract.md §1: error envelope, request ids,
//! Prometheus metrics, chaos injection and the operational endpoints.

pub mod chaos;
pub mod errors;
pub mod metrics;
pub mod request_id;

use axum::{extract::State, Json};
use serde_json::{json, Value};

use crate::{AppState, SERVICE_NAME};

pub async fn health(State(state): State<AppState>) -> Json<Value> {
    Json(json!({
        "status": "ok",
        "service": SERVICE_NAME,
        "version": state.config.version,
        "uptimeSeconds": state.started.elapsed().as_secs(),
    }))
}

/// The payment-service has no hard dependencies, so it is ready as soon as it is up.
pub async fn ready() -> Json<Value> {
    Json(json!({ "status": "ready", "checks": {} }))
}

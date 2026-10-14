//! TravelDuty payment-service — a simulated card processor. See docs/contract.md.

pub mod config;
pub mod payments;
pub mod platform;

use std::{
    sync::{Arc, Mutex, RwLock},
    time::Instant,
};

use axum::{
    middleware::{from_fn, from_fn_with_state},
    routing::{get, post},
    Router,
};

pub use config::Config;
use platform::{chaos, chaos::ChaosState, metrics, metrics::Metrics, request_id};

pub const SERVICE_NAME: &str = "payment-service";

#[derive(Clone)]
pub struct AppState {
    pub config: Arc<Config>,
    pub chaos: Arc<RwLock<ChaosState>>,
    pub metrics: Arc<Metrics>,
    pub store: Arc<Mutex<payments::Store>>,
    pub started: Instant,
}

pub fn build_app(config: Config) -> Router {
    let state = AppState {
        chaos: Arc::new(RwLock::new(config.chaos)),
        config: Arc::new(config),
        metrics: Arc::new(Metrics::new()),
        store: Arc::new(Mutex::new(payments::Store::default())),
        started: Instant::now(),
    };

    // Layers run outermost-last: request id → metrics → chaos → handler.
    Router::new()
        .route("/health", get(platform::health))
        .route("/ready", get(platform::ready))
        .route("/metrics", get(metrics::handler))
        .route("/admin/chaos", get(chaos::get).put(chaos::put).delete(chaos::reset))
        .route("/payments", post(payments::create))
        .route("/payments/:id", get(payments::get))
        .route("/payments/:id/refunds", post(payments::refund))
        .fallback(request_id::not_found)
        .layer(from_fn_with_state(state.clone(), chaos::middleware))
        .layer(from_fn_with_state(state.clone(), metrics::middleware))
        .layer(from_fn(request_id::middleware))
        .with_state(state)
}

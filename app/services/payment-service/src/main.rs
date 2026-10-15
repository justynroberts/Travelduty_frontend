use std::time::Duration;

use payment_service::{build_state, payments, router, Config, SERVICE_NAME};
use tracing_subscriber::EnvFilter;

#[tokio::main]
async fn main() {
    let level = std::env::var("LOG_LEVEL").unwrap_or_else(|_| "info".into());
    tracing_subscriber::fmt()
        .json()
        .flatten_event(true)
        .with_current_span(false)
        .with_span_list(false)
        .with_env_filter(EnvFilter::try_new(&level).unwrap_or_else(|_| EnvFilter::new("info")))
        .init();

    let config = match Config::from_env() {
        Ok(c) => c,
        Err(e) => {
            tracing::error!(service = SERVICE_NAME, error = %e, "invalid configuration");
            std::process::exit(1);
        }
    };
    let port = config.port;
    let host = std::env::var("HOST").unwrap_or_else(|_| "0.0.0.0".into());
    let state = build_state(config);
    payments::spawn_clear_down(
        state.clone(),
        Duration::from_secs(state.config.cleardown_retention_minutes * 60),
        Duration::from_secs(state.config.cleardown_interval_seconds),
    );
    let app = router(state);

    let listener = match tokio::net::TcpListener::bind((host.as_str(), port)).await {
        Ok(l) => l,
        Err(e) => {
            tracing::error!(service = SERVICE_NAME, error = %e, port, "failed to bind");
            std::process::exit(1);
        }
    };
    tracing::info!(service = SERVICE_NAME, port, "listening");

    if let Err(e) = axum::serve(listener, app).with_graceful_shutdown(shutdown_signal()).await {
        tracing::error!(service = SERVICE_NAME, error = %e, "server error");
        std::process::exit(1);
    }
    tracing::info!(service = SERVICE_NAME, "shut down");
}

async fn shutdown_signal() {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };
    #[cfg(unix)]
    let terminate = async {
        if let Ok(mut s) = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            s.recv().await;
        }
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        _ = ctrl_c => tracing::info!(service = SERVICE_NAME, signal = "SIGINT", "shutting down"),
        _ = terminate => tracing::info!(service = SERVICE_NAME, signal = "SIGTERM", "shutting down"),
    }
}

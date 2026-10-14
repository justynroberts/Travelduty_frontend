use std::time::Instant;

use axum::{
    body::Body,
    extract::Request,
    http::{header, HeaderValue, StatusCode},
    middleware::Next,
    response::{IntoResponse, Response},
};
use tracing::Instrument;

use super::errors::ApiError;
use crate::SERVICE_NAME;

/// The id of the current request, available to handlers as `Extension<RequestId>`.
#[derive(Debug, Clone)]
pub struct RequestId(pub String);

const HEADER: &str = "x-request-id";

/// Accepts an incoming `x-request-id` (≤128 chars) or generates one, echoes it on the
/// response, attaches it to the tracing span and writes one access-log line per request.
/// Also gives axum's bare 405 responses the standard error envelope.
pub async fn middleware(mut req: Request, next: Next) -> Response {
    let id = req
        .headers()
        .get(HEADER)
        .and_then(|v| v.to_str().ok())
        .filter(|v| !v.is_empty() && v.len() <= 128)
        .map(str::to_owned)
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    req.extensions_mut().insert(RequestId(id.clone()));

    let method = req.method().clone();
    let path = req.uri().path().to_owned();
    let span = tracing::info_span!("request", service = SERVICE_NAME, requestId = %id, %method, %path);
    let started = Instant::now();

    let mut response = next.run(req).instrument(span).await;

    if response.status() == StatusCode::METHOD_NOT_ALLOWED && !response.headers().contains_key(header::CONTENT_TYPE) {
        let mut replaced = ApiError::new(
            StatusCode::METHOD_NOT_ALLOWED,
            "METHOD_NOT_ALLOWED",
            format!("Method {method} not allowed on {path}"),
        )
        .into_response();
        if let Some(allow) = response.headers().get(header::ALLOW) {
            replaced.headers_mut().insert(header::ALLOW, allow.clone());
        }
        response = replaced;
    }

    if let Ok(value) = HeaderValue::from_str(&id) {
        response.headers_mut().insert(HEADER, value);
    }

    let status = response.status().as_u16();
    let duration_ms = started.elapsed().as_secs_f64() * 1000.0;
    if matches!(path.as_str(), "/health" | "/ready" | "/metrics") {
        tracing::debug!(service = SERVICE_NAME, requestId = %id, %method, %path, status, duration_ms, "request completed");
    } else {
        tracing::info!(service = SERVICE_NAME, requestId = %id, %method, %path, status, duration_ms, "request completed");
    }
    response
}

/// Fallback for unknown routes.
pub async fn not_found(req: Request<Body>) -> ApiError {
    ApiError::not_found(format!("Route {} {} not found", req.method(), req.uri().path()))
}

use std::{collections::HashMap, time::Instant};

use axum::{
    extract::{MatchedPath, Request, State},
    http::header,
    middleware::Next,
    response::{IntoResponse, Response},
};
use prometheus::{Encoder, HistogramOpts, HistogramVec, IntCounterVec, Opts, Registry, TextEncoder};

use crate::{AppState, SERVICE_NAME};

pub struct Metrics {
    registry: Registry,
    requests: IntCounterVec,
    duration: HistogramVec,
}

impl Default for Metrics {
    fn default() -> Self {
        Self::new()
    }
}

impl Metrics {
    pub fn new() -> Self {
        let labels = HashMap::from([("service".to_string(), SERVICE_NAME.to_string())]);
        let registry = Registry::new_custom(None, Some(labels)).expect("valid registry");
        let requests = IntCounterVec::new(
            Opts::new("http_requests_total", "HTTP requests handled"),
            &["method", "route", "status"],
        )
        .expect("valid counter");
        let duration = HistogramVec::new(
            HistogramOpts::new("http_request_duration_seconds", "HTTP request latency")
                .buckets(vec![0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0]),
            &["method", "route"],
        )
        .expect("valid histogram");
        registry.register(Box::new(requests.clone())).expect("register counter");
        registry.register(Box::new(duration.clone())).expect("register histogram");
        Self { registry, requests, duration }
    }

    pub fn render(&self) -> String {
        let mut buf = Vec::new();
        TextEncoder::new().encode(&self.registry.gather(), &mut buf).expect("encode metrics");
        String::from_utf8(buf).expect("metrics are utf-8")
    }
}

/// Converts axum's `/payments/:id` into the contract's `/payments/{id}` route template.
fn route_template(path: &str) -> String {
    path.split('/')
        .map(|seg| match seg.strip_prefix(':') {
            Some(name) => format!("{{{name}}}"),
            None => seg.to_string(),
        })
        .collect::<Vec<_>>()
        .join("/")
}

pub async fn middleware(State(state): State<AppState>, req: Request, next: Next) -> Response {
    let route = req
        .extensions()
        .get::<MatchedPath>()
        .map(|p| route_template(p.as_str()))
        .unwrap_or_else(|| "unmatched".to_string());
    let method = req.method().to_string();
    let started = Instant::now();
    let response = next.run(req).await;
    if route != "/metrics" {
        let status = response.status().as_u16().to_string();
        state.metrics.requests.with_label_values(&[&method, &route, &status]).inc();
        state.metrics.duration.with_label_values(&[&method, &route]).observe(started.elapsed().as_secs_f64());
    }
    response
}

pub async fn handler(State(state): State<AppState>) -> impl IntoResponse {
    ([(header::CONTENT_TYPE, "text/plain; version=0.0.4; charset=utf-8")], state.metrics.render())
}

#[cfg(test)]
mod tests {
    use super::route_template;

    #[test]
    fn converts_axum_params_to_contract_templates() {
        assert_eq!(route_template("/payments/:id/refunds"), "/payments/{id}/refunds");
        assert_eq!(route_template("/health"), "/health");
    }
}

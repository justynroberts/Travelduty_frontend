use axum::{
    body::Body,
    http::{Request, StatusCode},
    Router,
};
use http_body_util::BodyExt;
use payment_service::{build_app, Config};
use serde_json::{json, Value};
use tower::ServiceExt;

fn app() -> Router {
    build_app(Config { payment_latency_ms: 0, ..Config::default() })
}

struct Res {
    status: StatusCode,
    headers: axum::http::HeaderMap,
    text: String,
}

impl Res {
    fn json(&self) -> Value {
        serde_json::from_str(&self.text).unwrap_or(Value::Null)
    }
}

async fn call(app: &Router, method: &str, uri: &str, body: Option<Value>, headers: &[(&str, &str)]) -> Res {
    let mut req = Request::builder().method(method).uri(uri);
    for (k, v) in headers {
        req = req.header(*k, *v);
    }
    let req = match body {
        Some(b) => req.header("content-type", "application/json").body(Body::from(b.to_string())),
        None => req.body(Body::empty()),
    }
    .unwrap();
    let res = app.clone().oneshot(req).await.unwrap();
    let status = res.status();
    let headers = res.headers().clone();
    let bytes = res.into_body().collect().await.unwrap().to_bytes();
    Res { status, headers, text: String::from_utf8_lossy(&bytes).into_owned() }
}

fn payment(number: &str) -> Value {
    json!({
        "amount": 789.2,
        "currency": "gbp",
        "reference": "TD-7KQ2MX",
        "card": { "number": number, "expMonth": 12, "expYear": 2035, "cvc": "123", "holderName": "Ada Lovelace" }
    })
}

#[tokio::test]
async fn captures_a_valid_payment_without_exposing_the_pan() {
    let app = app();
    let res = call(&app, "POST", "/payments", Some(payment("4242 4242 4242 4242")), &[]).await;
    assert_eq!(res.status, StatusCode::CREATED);
    let body = res.json();
    assert_eq!(body["status"], "captured");
    assert_eq!(body["amount"], 789.2);
    assert_eq!(body["currency"], "GBP");
    assert_eq!(body["card"], json!({ "brand": "visa", "last4": "4242" }));
    assert_eq!(body["refundedAmount"], 0.0);
    assert!(body["id"].as_str().unwrap().starts_with("pay_"));
    assert!(!res.text.contains("4242424242424242"));

    let id = body["id"].as_str().unwrap();
    let fetched = call(&app, "GET", &format!("/payments/{id}"), None, &[]).await;
    assert_eq!(fetched.status, StatusCode::OK);
    assert_eq!(fetched.json()["id"], id);
}

#[tokio::test]
async fn mastercard_test_card_is_captured() {
    let res = call(&app(), "POST", "/payments", Some(payment("5555555555554444")), &[]).await;
    assert_eq!(res.status, StatusCode::CREATED);
    assert_eq!(res.json()["card"]["brand"], "mastercard");
}

#[tokio::test]
async fn decline_cards_return_402_with_decline_code() {
    let app = app();
    for (card, code) in [
        ("4000000000000002", "generic_decline"),
        ("4000000000009995", "insufficient_funds"),
        ("4000000000000069", "expired_card"),
    ] {
        let res = call(&app, "POST", "/payments", Some(payment(card)), &[]).await;
        assert_eq!(res.status, StatusCode::PAYMENT_REQUIRED, "{card}");
        let body = res.json();
        assert_eq!(body["error"]["code"], "CARD_DECLINED");
        assert_eq!(body["error"]["details"]["declineCode"], code);
    }
}

#[tokio::test]
async fn processor_outage_card_returns_502() {
    let res = call(&app(), "POST", "/payments", Some(payment("4000000000000119")), &[]).await;
    assert_eq!(res.status, StatusCode::BAD_GATEWAY);
    assert_eq!(res.json()["error"]["code"], "PROCESSOR_UNAVAILABLE");
}

#[tokio::test]
async fn validation_errors_use_the_envelope() {
    let app = app();
    let res = call(&app, "POST", "/payments", Some(payment("4242424242424241")), &[]).await;
    assert_eq!(res.status, StatusCode::BAD_REQUEST);
    assert_eq!(res.json()["error"]["code"], "VALIDATION_ERROR");

    let mut expired = payment("4242424242424242");
    expired["card"]["expYear"] = json!(2020);
    let res = call(&app, "POST", "/payments", Some(expired), &[]).await;
    assert_eq!(res.status, StatusCode::BAD_REQUEST);
    assert!(res.json()["error"]["message"].as_str().unwrap().contains("expired"));

    let mut zero = payment("4242424242424242");
    zero["amount"] = json!(0);
    assert_eq!(call(&app, "POST", "/payments", Some(zero), &[]).await.status, StatusCode::BAD_REQUEST);

    let mut cvc = payment("4242424242424242");
    cvc["card"]["cvc"] = json!("12");
    assert_eq!(call(&app, "POST", "/payments", Some(cvc), &[]).await.status, StatusCode::BAD_REQUEST);

    // Missing fields and malformed JSON are rejected by the extractor, still with the envelope.
    let res = call(&app, "POST", "/payments", Some(json!({ "amount": 10 })), &[]).await;
    assert_eq!(res.status, StatusCode::BAD_REQUEST);
    assert_eq!(res.json()["error"]["code"], "VALIDATION_ERROR");

    let req = Request::post("/payments").header("content-type", "application/json").body(Body::from("{nope")).unwrap();
    let res = app.clone().oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn idempotency_key_replays_the_original_response() {
    let app = app();
    let key = [("idempotency-key", "booking-TD-7KQ2MX")];
    let first = call(&app, "POST", "/payments", Some(payment("4242424242424242")), &key).await;
    let second = call(&app, "POST", "/payments", Some(payment("4242424242424242")), &key).await;
    assert_eq!(first.status, StatusCode::CREATED);
    assert_eq!(second.status, StatusCode::CREATED);
    assert_eq!(first.json(), second.json());

    let declined_key = [("idempotency-key", "decline-1")];
    let d1 = call(&app, "POST", "/payments", Some(payment("4000000000000002")), &declined_key).await;
    // Same key, different card: the original decline is replayed.
    let d2 = call(&app, "POST", "/payments", Some(payment("4242424242424242")), &declined_key).await;
    assert_eq!(d1.status, StatusCode::PAYMENT_REQUIRED);
    assert_eq!(d2.status, StatusCode::PAYMENT_REQUIRED);
    assert_eq!(d1.json(), d2.json());

    let other =
        call(&app, "POST", "/payments", Some(payment("4242424242424242")), &[("idempotency-key", "other")]).await;
    assert_ne!(other.json()["id"], first.json()["id"]);
}

#[tokio::test]
async fn refunds_partial_full_and_exceeding() {
    let app = app();
    let mut body = payment("4242424242424242");
    body["amount"] = json!(100);
    let created = call(&app, "POST", "/payments", Some(body), &[]).await;
    let id = created.json()["id"].as_str().unwrap().to_string();
    let path = format!("/payments/{id}/refunds");

    let partial = call(&app, "POST", &path, Some(json!({ "amount": 30.255 })), &[]).await;
    assert_eq!(partial.status, StatusCode::OK);
    assert_eq!(partial.json()["status"], "partially_refunded");
    assert_eq!(partial.json()["refundedAmount"], 30.26);

    let too_much = call(&app, "POST", &path, Some(json!({ "amount": 70 })), &[]).await;
    assert_eq!(too_much.status, StatusCode::CONFLICT);
    assert_eq!(too_much.json()["error"]["code"], "REFUND_EXCEEDS_CAPTURE");
    assert_eq!(too_much.json()["error"]["details"]["remaining"], 69.74);

    // No body → refund whatever remains.
    let rest = call(&app, "POST", &path, None, &[]).await;
    assert_eq!(rest.status, StatusCode::OK);
    assert_eq!(rest.json()["status"], "refunded");
    assert_eq!(rest.json()["refundedAmount"], 100.0);
    assert_eq!(rest.json()["refunds"].as_array().unwrap().len(), 2);

    let again = call(&app, "POST", &path, None, &[]).await;
    assert_eq!(again.status, StatusCode::CONFLICT);

    let missing = call(&app, "POST", "/payments/pay_nope/refunds", None, &[]).await;
    assert_eq!(missing.status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn unknown_routes_and_methods_use_the_envelope() {
    let app = app();
    let res = call(&app, "GET", "/nope", None, &[]).await;
    assert_eq!(res.status, StatusCode::NOT_FOUND);
    assert_eq!(res.json()["error"]["code"], "NOT_FOUND");

    let res = call(&app, "GET", "/payments/pay_missing", None, &[]).await;
    assert_eq!(res.status, StatusCode::NOT_FOUND);
    assert_eq!(res.json()["error"]["code"], "NOT_FOUND");

    let res = call(&app, "DELETE", "/payments", None, &[]).await;
    assert_eq!(res.status, StatusCode::METHOD_NOT_ALLOWED);
    assert_eq!(res.json()["error"]["code"], "METHOD_NOT_ALLOWED");
}

#[tokio::test]
async fn request_id_is_echoed_or_generated() {
    let app = app();
    let res = call(&app, "GET", "/health", None, &[("x-request-id", "trace-123")]).await;
    assert_eq!(res.headers["x-request-id"], "trace-123");
    let res = call(&app, "GET", "/nope", None, &[]).await;
    assert_eq!(res.headers["x-request-id"].to_str().unwrap().len(), 36);
}

#[tokio::test]
async fn health_and_ready() {
    let app = app();
    let health = call(&app, "GET", "/health", None, &[]).await.json();
    assert_eq!(health["status"], "ok");
    assert_eq!(health["service"], "payment-service");
    assert_eq!(health["version"], "dev");
    assert!(health["uptimeSeconds"].is_u64());
    let ready = call(&app, "GET", "/ready", None, &[]).await.json();
    assert_eq!(ready, json!({ "status": "ready", "checks": {} }));
}

#[tokio::test]
async fn chaos_injects_failures_but_exempts_operational_endpoints() {
    let app = app();
    let res = call(&app, "PUT", "/admin/chaos", Some(json!({ "errorRate": 1, "errorStatus": 500 })), &[]).await;
    assert_eq!(res.status, StatusCode::OK);
    assert_eq!(res.json(), json!({ "latencyMs": 0, "jitterMs": 0, "errorRate": 1.0, "errorStatus": 500 }));

    let res = call(&app, "POST", "/payments", Some(payment("4242424242424242")), &[]).await;
    assert_eq!(res.status, StatusCode::INTERNAL_SERVER_ERROR);
    assert_eq!(res.json()["error"]["code"], "CHAOS_INJECTED");
    assert_eq!(res.json()["error"]["message"], "Injected failure in payment-service");

    assert_eq!(call(&app, "GET", "/health", None, &[]).await.status, StatusCode::OK);
    assert_eq!(call(&app, "GET", "/metrics", None, &[]).await.status, StatusCode::OK);

    let reset = call(&app, "DELETE", "/admin/chaos", None, &[]).await;
    assert_eq!(reset.json()["errorRate"], 0.0);
    assert_eq!(reset.json()["errorStatus"], 503);
    let res = call(&app, "POST", "/payments", Some(payment("4242424242424242")), &[]).await;
    assert_eq!(res.status, StatusCode::CREATED);
}

#[tokio::test]
async fn chaos_validation() {
    let app = app();
    for bad in [
        json!({ "errorRate": 1.5 }),
        json!({ "errorStatus": 200 }),
        json!({ "latencyMs": 60001 }),
        json!({ "latencyMs": -1 }),
    ] {
        let res = call(&app, "PUT", "/admin/chaos", Some(bad.clone()), &[]).await;
        assert_eq!(res.status, StatusCode::BAD_REQUEST, "{bad}");
        assert_eq!(res.json()["error"]["code"], "VALIDATION_ERROR");
    }
}

#[tokio::test]
async fn chaos_latency_is_applied() {
    let app = app();
    call(&app, "PUT", "/admin/chaos", Some(json!({ "latencyMs": 120 })), &[]).await;
    let started = std::time::Instant::now();
    call(&app, "GET", "/payments/pay_x", None, &[]).await;
    assert!(started.elapsed().as_millis() >= 120);
}

#[tokio::test]
async fn admin_token_guards_chaos_endpoints() {
    let app = build_app(Config { payment_latency_ms: 0, admin_token: Some("s3cret".into()), ..Config::default() });
    let res = call(&app, "GET", "/admin/chaos", None, &[]).await;
    assert_eq!(res.status, StatusCode::UNAUTHORIZED);
    assert_eq!(res.json()["error"]["code"], "UNAUTHORIZED");
    let res = call(&app, "PUT", "/admin/chaos", Some(json!({ "errorRate": 1 })), &[("x-admin-token", "wrong")]).await;
    assert_eq!(res.status, StatusCode::UNAUTHORIZED);
    let res = call(&app, "GET", "/admin/chaos", None, &[("x-admin-token", "s3cret")]).await;
    assert_eq!(res.status, StatusCode::OK);
}

#[tokio::test]
async fn chaos_initial_state_comes_from_config() {
    let mut config = Config { payment_latency_ms: 0, ..Config::default() };
    config.chaos.error_rate = 1.0;
    let app = build_app(config);
    let res = call(&app, "GET", "/payments/pay_x", None, &[]).await;
    assert_eq!(res.status, StatusCode::SERVICE_UNAVAILABLE);
}

#[tokio::test]
async fn metrics_expose_request_counters_with_route_templates() {
    let app = app();
    call(&app, "POST", "/payments", Some(payment("4242424242424242")), &[]).await;
    call(&app, "GET", "/payments/pay_missing", None, &[]).await;
    let res = call(&app, "GET", "/metrics", None, &[]).await;
    assert!(res.headers["content-type"].to_str().unwrap().starts_with("text/plain"));
    let text = res.text;
    assert!(text.contains("http_requests_total"), "{text}");
    assert!(text.contains(r#"route="/payments/{id}""#), "{text}");
    assert!(text.contains(r#"method="POST",route="/payments",status="201",service="payment-service""#), "{text}");
    assert!(text.contains("http_request_duration_seconds_bucket"), "{text}");
}

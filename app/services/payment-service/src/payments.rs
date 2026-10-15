//! Simulated card processor: authorise-and-capture, idempotent replays and refunds.
//! Full card numbers are only ever held in the request; records keep brand + last4.

use std::{
    collections::HashMap,
    time::{Duration, Instant},
};

use axum::{
    body::Bytes,
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Extension, Json,
};
use chrono::{Datelike, SecondsFormat, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::{
    platform::{
        errors::{ApiError, ApiJson},
        request_id::RequestId,
    },
    AppState, SERVICE_NAME,
};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreatePayment {
    amount: f64,
    currency: String,
    reference: String,
    card: Card,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Card {
    number: String,
    exp_month: u32,
    exp_year: i32,
    cvc: String,
    #[serde(default)]
    holder_name: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CardSummary {
    brand: &'static str,
    last4: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Refund {
    id: String,
    amount: f64,
    created_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Payment {
    id: String,
    status: &'static str,
    amount: f64,
    currency: String,
    reference: String,
    card: CardSummary,
    holder_name: String,
    refunded_amount: f64,
    refunds: Vec<Refund>,
    created_at: String,
    /// When the payment was fully refunded; the clear-down deletes it once this is old enough.
    #[serde(skip)]
    settled_at: Option<Instant>,
}

#[derive(Default)]
pub struct Store {
    payments: HashMap<String, Payment>,
    /// Idempotency-Key → the original (status, body) and when it was recorded.
    idempotency: HashMap<String, (StatusCode, Value, Instant)>,
}

impl Store {
    /// Hands-off clear-down: deletes payments fully refunded before `cutoff` and idempotency
    /// records older than it, returning (payments, idempotency keys) removed. Synthetic users
    /// book and cancel around the clock, so without this the store grows for as long as the
    /// process lives. Captured payments that still hold money are never touched.
    pub fn prune(&mut self, cutoff: Instant) -> (usize, usize) {
        let (payments, keys) = (self.payments.len(), self.idempotency.len());
        self.payments.retain(|_, p| p.settled_at.map_or(true, |t| t >= cutoff));
        self.idempotency.retain(|_, (_, _, at)| *at >= cutoff);
        (payments - self.payments.len(), keys - self.idempotency.len())
    }
}

/// Runs [`Store::prune`] every `interval` for the life of the process.
pub fn spawn_clear_down(state: AppState, retention: Duration, interval: Duration) {
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(interval);
        tick.tick().await;
        loop {
            tick.tick().await;
            let Some(cutoff) = Instant::now().checked_sub(retention) else { continue };
            let (payments, keys) = state.store.lock().expect("store lock poisoned").prune(cutoff);
            state.metrics.cleared_down("payments", payments);
            state.metrics.cleared_down("idempotency_keys", keys);
            if payments + keys > 0 {
                tracing::info!(service = SERVICE_NAME, payments, idempotency_keys = keys, "cleared down");
            }
        }
    });
}

enum Outcome {
    Captured,
    Declined(&'static str),
    ProcessorUnavailable,
}

/// Test-card behaviour, see docs/contract.md §2.
fn outcome_for(number: &str) -> Outcome {
    match number {
        "4000000000000002" => Outcome::Declined("generic_decline"),
        "4000000000009995" => Outcome::Declined("insufficient_funds"),
        "4000000000000069" => Outcome::Declined("expired_card"),
        "4000000000000119" => Outcome::ProcessorUnavailable,
        _ => Outcome::Captured,
    }
}

pub fn round2(n: f64) -> f64 {
    (n * 100.0).round() / 100.0
}

pub fn luhn_valid(digits: &str) -> bool {
    let mut sum = 0;
    for (i, c) in digits.chars().rev().enumerate() {
        let Some(mut d) = c.to_digit(10) else { return false };
        if i % 2 == 1 {
            d *= 2;
            if d > 9 {
                d -= 9;
            }
        }
        sum += d;
    }
    sum % 10 == 0
}

pub fn brand(digits: &str) -> &'static str {
    let prefix = |n: usize| digits.get(..n).and_then(|p| p.parse::<u32>().ok()).unwrap_or(0);
    if digits.starts_with('4') {
        "visa"
    } else if (51..=55).contains(&prefix(2)) || (2221..=2720).contains(&prefix(4)) {
        "mastercard"
    } else if matches!(prefix(2), 34 | 37) {
        "amex"
    } else if digits.starts_with("6011") || digits.starts_with("65") {
        "discover"
    } else {
        "unknown"
    }
}

fn now_iso() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn new_id(prefix: &str) -> String {
    format!("{prefix}_{}", &uuid::Uuid::new_v4().simple().to_string()[..24])
}

struct Validated {
    amount: f64,
    currency: String,
    number: String,
}

fn validate(req: &CreatePayment) -> Result<Validated, ApiError> {
    if !req.amount.is_finite() || req.amount <= 0.0 {
        return Err(ApiError::validation("amount must be greater than 0"));
    }
    let amount = round2(req.amount);
    if amount <= 0.0 {
        return Err(ApiError::validation("amount must be at least 0.01"));
    }
    let currency = req.currency.trim().to_ascii_uppercase();
    if currency.len() != 3 || !currency.chars().all(|c| c.is_ascii_alphabetic()) {
        return Err(ApiError::validation("currency must be a 3-letter ISO code"));
    }
    if req.reference.trim().is_empty() || req.reference.len() > 64 {
        return Err(ApiError::validation("reference must be 1-64 characters"));
    }
    let number: String = req.card.number.chars().filter(|c| !matches!(c, ' ' | '-')).collect();
    if !(12..=19).contains(&number.len()) || !number.chars().all(|c| c.is_ascii_digit()) || !luhn_valid(&number) {
        return Err(ApiError::validation("card.number is not a valid card number"));
    }
    if !(1..=12).contains(&req.card.exp_month) {
        return Err(ApiError::validation("card.expMonth must be 1-12"));
    }
    let exp_year = if req.card.exp_year < 100 { 2000 + req.card.exp_year } else { req.card.exp_year };
    let today = Utc::now();
    if (exp_year, req.card.exp_month) < (today.year(), today.month()) {
        return Err(ApiError::validation("card has expired"));
    }
    if !(3..=4).contains(&req.card.cvc.len()) || !req.card.cvc.chars().all(|c| c.is_ascii_digit()) {
        return Err(ApiError::validation("card.cvc must be 3 or 4 digits"));
    }
    Ok(Validated { amount, currency, number })
}

fn idempotency_key(headers: &HeaderMap) -> Option<String> {
    headers
        .get("idempotency-key")
        .and_then(|v| v.to_str().ok())
        .map(str::trim)
        .filter(|k| !k.is_empty() && k.len() <= 255)
        .map(str::to_owned)
}

pub async fn create(
    State(state): State<AppState>,
    Extension(RequestId(request_id)): Extension<RequestId>,
    headers: HeaderMap,
    ApiJson(req): ApiJson<CreatePayment>,
) -> Result<Response, ApiError> {
    let key = idempotency_key(&headers);
    if let Some(key) = &key {
        if let Some((status, body, _)) = state.store.lock().expect("store lock poisoned").idempotency.get(key).cloned()
        {
            tracing::info!(service = SERVICE_NAME, requestId = %request_id, idempotency_key = %key, "idempotent replay");
            return Ok((status, Json(body)).into_response());
        }
    }

    let v = validate(&req)?;
    let card = CardSummary { brand: brand(&v.number), last4: v.number[v.number.len() - 4..].to_string() };

    if state.config.payment_latency_ms > 0 {
        tokio::time::sleep(Duration::from_millis(state.config.payment_latency_ms)).await;
    }

    let (status, body) = match outcome_for(&v.number) {
        Outcome::ProcessorUnavailable => {
            tracing::error!(service = SERVICE_NAME, requestId = %request_id, reference = %req.reference, "card processor unavailable");
            // Transient: not recorded against the idempotency key, so the caller may retry.
            return Err(ApiError::new(
                StatusCode::BAD_GATEWAY,
                "PROCESSOR_UNAVAILABLE",
                "Card processor is unavailable",
            ));
        }
        Outcome::Declined(decline_code) => {
            tracing::warn!(
                service = SERVICE_NAME, requestId = %request_id, reference = %req.reference,
                brand = card.brand, last4 = %card.last4, decline_code, "payment declined"
            );
            let err =
                ApiError::new(StatusCode::PAYMENT_REQUIRED, "CARD_DECLINED", format!("Card declined: {decline_code}"))
                    .with_details(json!({ "declineCode": decline_code }));
            (err.status, err.body())
        }
        Outcome::Captured => {
            let payment = Payment {
                id: new_id("pay"),
                status: "captured",
                amount: v.amount,
                currency: v.currency,
                reference: req.reference.trim().to_string(),
                card,
                holder_name: req.card.holder_name.trim().to_string(),
                refunded_amount: 0.0,
                refunds: vec![],
                created_at: now_iso(),
                settled_at: None,
            };
            tracing::info!(
                service = SERVICE_NAME, requestId = %request_id, payment_id = %payment.id, reference = %payment.reference,
                amount = payment.amount, currency = %payment.currency, brand = payment.card.brand,
                last4 = %payment.card.last4, "payment captured"
            );
            let body = serde_json::to_value(&payment).expect("payment serialises");
            state.store.lock().expect("store lock poisoned").payments.insert(payment.id.clone(), payment);
            (StatusCode::CREATED, body)
        }
    };

    if let Some(key) = key {
        state
            .store
            .lock()
            .expect("store lock poisoned")
            .idempotency
            .insert(key, (status, body.clone(), Instant::now()));
    }
    Ok((status, Json(body)).into_response())
}

pub async fn get(State(state): State<AppState>, Path(id): Path<String>) -> Result<Json<Payment>, ApiError> {
    state
        .store
        .lock()
        .expect("store lock poisoned")
        .payments
        .get(&id)
        .cloned()
        .map(Json)
        .ok_or_else(|| ApiError::not_found(format!("Payment {id} not found")))
}

#[derive(Debug, Default, Deserialize)]
struct RefundRequest {
    amount: Option<f64>,
}

/// The body is optional (omit it for a full refund), so it is parsed by hand.
pub async fn refund(
    State(state): State<AppState>,
    Extension(RequestId(request_id)): Extension<RequestId>,
    Path(id): Path<String>,
    body: Bytes,
) -> Result<Json<Payment>, ApiError> {
    let req: RefundRequest = if body.iter().all(u8::is_ascii_whitespace) {
        RefundRequest::default()
    } else {
        serde_json::from_slice(&body).map_err(|e| ApiError::validation(format!("Invalid JSON body: {e}")))?
    };

    let mut store = state.store.lock().expect("store lock poisoned");
    let payment = store.payments.get_mut(&id).ok_or_else(|| ApiError::not_found(format!("Payment {id} not found")))?;
    let remaining = round2(payment.amount - payment.refunded_amount);
    let amount = match req.amount {
        Some(a) if !a.is_finite() || round2(a) <= 0.0 => {
            return Err(ApiError::validation("amount must be greater than 0"));
        }
        Some(a) => round2(a),
        None => remaining,
    };
    if amount > remaining || remaining <= 0.0 {
        return Err(ApiError::new(
            StatusCode::CONFLICT,
            "REFUND_EXCEEDS_CAPTURE",
            format!("Cannot refund {amount:.2}; only {remaining:.2} remains"),
        )
        .with_details(json!({ "remaining": remaining })));
    }

    payment.refunded_amount = round2(payment.refunded_amount + amount);
    payment.status = if payment.refunded_amount >= payment.amount { "refunded" } else { "partially_refunded" };
    if payment.status == "refunded" {
        payment.settled_at = Some(Instant::now());
    }
    payment.refunds.push(Refund { id: new_id("re"), amount, created_at: now_iso() });
    tracing::info!(
        service = SERVICE_NAME, requestId = %request_id, payment_id = %payment.id, amount,
        refunded_amount = payment.refunded_amount, status = payment.status, "refund issued"
    );
    Ok(Json(payment.clone()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn luhn() {
        assert!(luhn_valid("4242424242424242"));
        assert!(luhn_valid("4000000000000119"));
        assert!(!luhn_valid("4242424242424241"));
    }

    #[test]
    fn brands() {
        assert_eq!(brand("4242424242424242"), "visa");
        assert_eq!(brand("5555555555554444"), "mastercard");
        assert_eq!(brand("2223003122003222"), "mastercard");
        assert_eq!(brand("378282246310005"), "amex");
        assert_eq!(brand("6011111111111117"), "discover");
    }

    fn payment(id: &str, settled_at: Option<Instant>) -> Payment {
        Payment {
            id: id.into(),
            status: if settled_at.is_some() { "refunded" } else { "captured" },
            amount: 10.0,
            currency: "EUR".into(),
            reference: "TD-TEST01".into(),
            card: CardSummary { brand: "visa", last4: "4242".into() },
            holder_name: "Synthetic User".into(),
            refunded_amount: 0.0,
            refunds: vec![],
            created_at: now_iso(),
            settled_at,
        }
    }

    #[test]
    fn prune_removes_only_old_refunded_payments_and_keys() {
        let now = Instant::now();
        let old = now - Duration::from_secs(7200);
        let mut store = Store::default();
        store.payments.insert("old".into(), payment("old", Some(old)));
        store.payments.insert("fresh".into(), payment("fresh", Some(now)));
        store.payments.insert("captured".into(), payment("captured", None));
        store.idempotency.insert("k-old".into(), (StatusCode::CREATED, json!({}), old));
        store.idempotency.insert("k-new".into(), (StatusCode::CREATED, json!({}), now));

        assert_eq!(store.prune(now - Duration::from_secs(3600)), (1, 1));
        let mut left: Vec<_> = store.payments.keys().cloned().collect();
        left.sort();
        assert_eq!(left, ["captured", "fresh"]);
        assert!(store.idempotency.contains_key("k-new"));
    }

    #[test]
    fn rounding() {
        assert_eq!(round2(10.005), 10.01);
        assert_eq!(round2(789.2), 789.2);
    }
}

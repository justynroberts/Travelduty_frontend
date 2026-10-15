use crate::platform::chaos::ChaosState;

/// Runtime configuration, read from the environment (see docs/contract.md §1).
#[derive(Debug, Clone)]
pub struct Config {
    pub port: u16,
    pub version: String,
    pub admin_token: Option<String>,
    pub chaos: ChaosState,
    /// Simulated card-processor round trip.
    pub payment_latency_ms: u64,
    /// Finished records older than this are deleted by the clear-down.
    pub cleardown_retention_minutes: u64,
    pub cleardown_interval_seconds: u64,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            port: 8086,
            version: "dev".into(),
            admin_token: None,
            chaos: ChaosState::default(),
            payment_latency_ms: 150,
            cleardown_retention_minutes: 60,
            cleardown_interval_seconds: 60,
        }
    }
}

impl Config {
    pub fn from_env() -> Result<Self, String> {
        let d = Self::default();
        let defaults = ChaosState::default();
        Ok(Self {
            port: parse("PORT", d.port)?,
            version: var("APP_VERSION").unwrap_or(d.version),
            admin_token: var("ADMIN_TOKEN"),
            chaos: ChaosState {
                latency_ms: parse("CHAOS_LATENCY_MS", defaults.latency_ms)?,
                jitter_ms: parse("CHAOS_JITTER_MS", defaults.jitter_ms)?,
                error_rate: parse("CHAOS_ERROR_RATE", defaults.error_rate)?,
                error_status: parse("CHAOS_ERROR_STATUS", defaults.error_status)?,
            },
            payment_latency_ms: parse("PAYMENT_LATENCY_MS", d.payment_latency_ms)?,
            cleardown_retention_minutes: parse("CLEARDOWN_RETENTION_MINUTES", d.cleardown_retention_minutes)?,
            cleardown_interval_seconds: parse("CLEARDOWN_INTERVAL_SECONDS", d.cleardown_interval_seconds)?,
        })
    }
}

fn var(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|v| !v.is_empty())
}

fn parse<T: std::str::FromStr>(name: &str, fallback: T) -> Result<T, String> {
    match var(name) {
        None => Ok(fallback),
        Some(raw) => raw.parse().map_err(|_| format!("environment variable {name} has invalid value {raw:?}")),
    }
}

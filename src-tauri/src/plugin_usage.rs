//! Plugin-facing commands behind `ctx.usage` / `ctx.limits` (SDK 0.3.25).
//!
//! The data itself lives in `usage_stats` (read-only statistics built from
//! each CLI's own session logs) and `usage_limits` (read-only Claude / Codex
//! rate-limit lookup). These commands only add the second permission gate:
//! the JS runtime already refuses undeclared calls, and here every call is
//! re-checked against the installed manifest and the plugin's enabled state,
//! so a disabled or tampered plugin cannot reach the data through raw IPC.
//!
//! Background scanning starts on the first granted `usage.read` call, not at
//! app startup: without the usage plugin installed nobody reads the numbers,
//! so CC GUI never walks the CLIs' logs on its own.

use std::sync::Mutex;
use std::time::{Duration, Instant};

use crate::plugin_host::require_grant;
use crate::usage_limits::LimitsResponse;
use crate::usage_stats::{PriceInfo, QueryRequest, QueryResponse, ScanSummary, SourceStatus};

const USAGE_READ: &str = "usage.read";
const LIMITS_READ: &str = "limits.read";

/// `updatePrices` downloads a public file; repeated calls inside the window
/// return the current table instead of hitting the network again.
const PRICE_UPDATE_COOLDOWN: Duration = Duration::from_secs(10 * 60);
/// A full rescan re-reads every log; it is a user action, not a poll.
const RESCAN_COOLDOWN: Duration = Duration::from_secs(60);

static LAST_PRICE_UPDATE: Mutex<Option<Instant>> = Mutex::new(None);
static LAST_RESCAN: Mutex<Option<Instant>> = Mutex::new(None);

/// Claim a cooldown slot: `Ok` when the window has passed (and starts a new
/// one), `Err(remaining)` while it is still running.
fn claim(slot: &Mutex<Option<Instant>>, every: Duration, now: Instant) -> Result<(), Duration> {
    let mut last = slot.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some(at) = *last {
        let elapsed = now.saturating_duration_since(at);
        if elapsed < every {
            return Err(every - elapsed);
        }
    }
    *last = Some(now);
    Ok(())
}

fn grant_usage(app: &tauri::AppHandle, plugin_id: &str) -> Result<(), String> {
    require_grant(plugin_id, USAGE_READ)?;
    crate::usage_stats::start_background(app.clone());
    Ok(())
}

#[tauri::command]
pub async fn plugin_usage_query(
    app: tauri::AppHandle,
    plugin_id: String,
    query: QueryRequest,
) -> Result<QueryResponse, String> {
    grant_usage(&app, &plugin_id)?;
    crate::usage_stats::query(query).await
}

#[tauri::command]
pub async fn plugin_usage_sources(
    app: tauri::AppHandle,
    plugin_id: String,
) -> Result<Vec<SourceStatus>, String> {
    grant_usage(&app, &plugin_id)?;
    crate::usage_stats::sources().await
}

#[tauri::command]
pub async fn plugin_usage_refresh(
    app: tauri::AppHandle,
    plugin_id: String,
) -> Result<ScanSummary, String> {
    grant_usage(&app, &plugin_id)?;
    crate::usage_stats::refresh(app).await
}

#[tauri::command]
pub async fn plugin_usage_rescan(
    app: tauri::AppHandle,
    plugin_id: String,
) -> Result<ScanSummary, String> {
    grant_usage(&app, &plugin_id)?;
    if let Err(remaining) = claim(&LAST_RESCAN, RESCAN_COOLDOWN, Instant::now()) {
        return Err(format!(
            "a full rescan ran moments ago; try again in {}s",
            remaining.as_secs().max(1)
        ));
    }
    crate::usage_stats::rescan(app).await
}

#[tauri::command]
pub async fn plugin_usage_prices(
    app: tauri::AppHandle,
    plugin_id: String,
) -> Result<PriceInfo, String> {
    grant_usage(&app, &plugin_id)?;
    crate::usage_stats::prices().await
}

#[tauri::command]
pub async fn plugin_usage_update_prices(
    app: tauri::AppHandle,
    plugin_id: String,
) -> Result<PriceInfo, String> {
    grant_usage(&app, &plugin_id)?;
    if claim(&LAST_PRICE_UPDATE, PRICE_UPDATE_COOLDOWN, Instant::now()).is_err() {
        return crate::usage_stats::prices().await;
    }
    crate::usage_stats::update_prices().await
}

#[tauri::command]
pub async fn plugin_limits_get(
    plugin_id: String,
    providers: Option<Vec<String>>,
    refresh: Option<bool>,
) -> Result<LimitsResponse, String> {
    require_grant(&plugin_id, LIMITS_READ)?;
    crate::usage_limits::get(providers, refresh.unwrap_or(false)).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cooldown_allows_one_claim_per_window() {
        let slot = Mutex::new(None);
        let t0 = Instant::now();
        let every = Duration::from_secs(60);
        assert!(claim(&slot, every, t0).is_ok());
        let remaining = claim(&slot, every, t0 + Duration::from_secs(20)).unwrap_err();
        assert_eq!(remaining, Duration::from_secs(40));
        assert!(claim(&slot, every, t0 + every).is_ok(), "window passed");
        assert!(claim(&slot, every, t0 + every + Duration::from_secs(1)).is_err());
    }
}

//! Codex (ChatGPT login) windows from `GET /backend-api/wham/usage`, the
//! endpoint the Codex CLI's `/status` reads.

use serde_json::Value;

use super::credentials::{CodexAuth, Secret};
use super::transport::HttpRequest;
use super::{
    clamp_percent, title_case, LimitWindow, KIND_OTHER, KIND_SESSION, KIND_WEEKLY,
    SESSION_WINDOW_SECONDS, WEEKLY_WINDOW_SECONDS,
};

pub(crate) const HOST: &str = "chatgpt.com";
pub(crate) const USAGE_URL: &str = "https://chatgpt.com/backend-api/wham/usage";

pub(crate) fn token_expired(auth: &CodexAuth, now_ms: i64) -> bool {
    auth.expires_at_ms.is_some_and(|expires| expires <= now_ms)
}

// Mirrors TokenTracker (MIT): send `ChatGPT-Account-Id` when known — wham
// rejects some plan tiers / multi-account logins without it.
pub(crate) fn request(token: &Secret, account_id: Option<&Secret>) -> HttpRequest {
    let mut headers = vec![
        ("Authorization", format!("Bearer {}", token.expose())),
        ("Accept", "application/json".to_string()),
    ];
    if let Some(account) = account_id {
        headers.push(("ChatGPT-Account-Id", account.expose().to_string()));
    }
    HttpRequest {
        url: USAGE_URL,
        headers,
    }
}

/// `plus` → "Plus", `free` → "Free" (the limits page notes free plans only
/// carry a weekly window, so the label is kept rather than hidden).
pub(crate) fn plan_label(plan_type: Option<&str>) -> Option<String> {
    title_case(plan_type?)
}

pub(crate) struct CodexUsage {
    pub plan_type: Option<String>,
    pub windows: Vec<LimitWindow>,
}

/// Map a wham usage body. `None` when the body is not a JSON object.
pub(crate) fn parse_usage(body: &str, now_ms: i64) -> Option<CodexUsage> {
    let root: Value = serde_json::from_str(body).ok()?;
    if !root.is_object() {
        return None;
    }
    let plan_type = root
        .get("plan_type")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|p| !p.is_empty())
        .map(str::to_string);
    let rate_limit = root.get("rate_limit");
    let slots = ["primary_window", "secondary_window"]
        .into_iter()
        .filter_map(|slot| Some((slot, rate_limit?.get(slot)?)));
    let mut windows: Vec<LimitWindow> = Vec::new();
    for (slot, value) in slots {
        let Some(window) = window(slot, value, now_ms) else {
            continue;
        };
        // Mirrors TokenTracker (MIT): first window of a class wins.
        if windows.iter().any(|w| w.id == window.id) {
            continue;
        }
        windows.push(window);
    }
    windows.sort_by_key(|w| kind_rank(&w.kind));
    Some(CodexUsage { plan_type, windows })
}

// Mirrors TokenTracker (MIT): classify by `limit_window_seconds`
// (18000 = 5 h session, 604800 = weekly), never by slot — free plans get
// their only (weekly) window in `primary_window`. Unknown durations are kept
// as `other` instead of being guessed.
fn window(slot: &str, value: &Value, now_ms: i64) -> Option<LimitWindow> {
    let used_percent = clamp_percent(value.get("used_percent")?)?;
    let seconds = value
        .get("limit_window_seconds")
        .and_then(Value::as_f64)
        .filter(|s| s.is_finite() && *s > 0.0)
        .map(|s| s as i64);
    let (id, kind) = match seconds {
        Some(SESSION_WINDOW_SECONDS) => ("session".to_string(), KIND_SESSION),
        Some(WEEKLY_WINDOW_SECONDS) => ("weekly".to_string(), KIND_WEEKLY),
        Some(other) => (format!("other:{other}"), KIND_OTHER),
        None => (
            format!("other:{}", slot.trim_end_matches("_window")),
            KIND_OTHER,
        ),
    };
    Some(LimitWindow {
        id,
        kind: kind.to_string(),
        label: None,
        used_percent,
        window_seconds: seconds,
        resets_at: reset_ms(value, now_ms),
    })
}

/// `reset_at` is epoch seconds; fall back to `reset_after_seconds`.
fn reset_ms(value: &Value, now_ms: i64) -> Option<i64> {
    if let Some(at) = value
        .get("reset_at")
        .and_then(super::credentials::timestamp_ms)
    {
        return Some(at);
    }
    let after = value
        .get("reset_after_seconds")
        .and_then(Value::as_f64)
        .filter(|s| s.is_finite() && *s >= 0.0)?;
    // Cap absurd server values (a year) and never overflow the clock.
    Some(now_ms.saturating_add((after.min(31_536_000.0) * 1000.0) as i64))
}

fn kind_rank(kind: &str) -> u8 {
    match kind {
        KIND_SESSION => 0,
        KIND_WEEKLY => 1,
        _ => 2,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const NOW: i64 = 1_790_000_000_000;

    #[test]
    fn classifies_session_and_weekly_by_duration_not_slot() {
        let body = json!({
            "plan_type": "pro",
            "rate_limit": {
                "primary_window": { "used_percent": 71, "limit_window_seconds": 604800,
                                    "reset_after_seconds": 183600, "reset_at": 1_790_183_600 },
                "secondary_window": { "used_percent": 8.5, "limit_window_seconds": 18000,
                                      "reset_after_seconds": 14520, "reset_at": 1_790_014_520 }
            }
        })
        .to_string();
        let usage = parse_usage(&body, NOW).expect("parses");
        assert_eq!(usage.plan_type.as_deref(), Some("pro"));
        let session = &usage.windows[0];
        assert_eq!(
            (session.id.as_str(), session.kind.as_str()),
            ("session", "session")
        );
        assert_eq!(session.used_percent, 8.5);
        assert_eq!(session.window_seconds, Some(18_000));
        assert_eq!(session.resets_at, Some(1_790_014_520_000));
        let weekly = &usage.windows[1];
        assert_eq!(
            (weekly.id.as_str(), weekly.kind.as_str()),
            ("weekly", "weekly")
        );
        assert_eq!(weekly.used_percent, 71.0);
        assert_eq!(usage.windows.len(), 2);
    }

    #[test]
    fn weekly_only_in_primary_slot_is_weekly() {
        let body = json!({
            "plan_type": "free",
            "rate_limit": {
                "primary_window": { "used_percent": 46, "limit_window_seconds": 604800,
                                    "reset_after_seconds": 280800 },
                "secondary_window": null
            }
        })
        .to_string();
        let usage = parse_usage(&body, NOW).expect("parses");
        assert_eq!(usage.windows.len(), 1);
        assert_eq!(usage.windows[0].id, "weekly");
        assert_eq!(usage.windows[0].resets_at, Some(NOW + 280_800_000));
        assert_eq!(
            plan_label(usage.plan_type.as_deref()).as_deref(),
            Some("Free")
        );
    }

    #[test]
    fn unknown_durations_and_missing_limits() {
        let body = json!({
            "rate_limit": {
                "primary_window": { "used_percent": 5, "limit_window_seconds": 86400 },
                "secondary_window": { "used_percent": 6 }
            }
        })
        .to_string();
        let usage = parse_usage(&body, NOW).expect("parses");
        let ids: Vec<&str> = usage.windows.iter().map(|w| w.id.as_str()).collect();
        assert_eq!(ids, ["other:86400", "other:secondary"]);
        assert!(usage.windows.iter().all(|w| w.kind == "other"));

        let empty = parse_usage(r#"{"plan_type":"plus","rate_limit":null}"#, NOW).expect("parses");
        assert!(empty.windows.is_empty());
        assert!(parse_usage("null", NOW).is_none());
    }

    #[test]
    fn request_carries_account_header_only_when_known() {
        let token = Secret::new("tok");
        let with = request(&token, Some(&Secret::new("acct")));
        assert!(with
            .headers
            .iter()
            .any(|(n, v)| *n == "ChatGPT-Account-Id" && v == "acct"));
        let without = request(&token, None);
        assert!(without
            .headers
            .iter()
            .all(|(n, _)| *n != "ChatGPT-Account-Id"));
    }
}

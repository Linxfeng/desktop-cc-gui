//! Claude subscription windows from `GET /api/oauth/usage` (the endpoint
//! Claude Code's own `/usage` reads), authenticated with the Claude Code
//! OAuth login.

use serde_json::Value;

use super::credentials::{ClaudeOauth, Secret};
use super::transport::HttpRequest;
use super::{
    clamp_percent, title_case, ExtraUsage, LimitWindow, KIND_SESSION, KIND_WEEKLY,
    SESSION_WINDOW_SECONDS, WEEKLY_WINDOW_SECONDS,
};

pub(crate) const HOST: &str = "api.anthropic.com";
pub(crate) const USAGE_URL: &str = "https://api.anthropic.com/api/oauth/usage";
const OAUTH_BETA: &str = "oauth-2025-04-20";
/// Treat a token this close to expiry as already expired: the API answers a
/// just-expired token with 401/429, and spending a request on it only feeds
/// the rate limiter.
// Mirrors TokenTracker (MIT): 60 s expiry skew for the Claude Code token.
pub(crate) const EXPIRY_SKEW_MS: i64 = 60_000;

/// Legacy top-level window fields: (field, kind, window seconds, label).
const LEGACY_WINDOWS: [(&str, &str, i64, Option<&str>); 4] = [
    ("five_hour", KIND_SESSION, SESSION_WINDOW_SECONDS, None),
    ("seven_day", KIND_WEEKLY, WEEKLY_WINDOW_SECONDS, None),
    (
        "seven_day_opus",
        KIND_WEEKLY,
        WEEKLY_WINDOW_SECONDS,
        Some("Opus"),
    ),
    (
        "seven_day_sonnet",
        KIND_WEEKLY,
        WEEKLY_WINDOW_SECONDS,
        Some("Sonnet"),
    ),
];

pub(crate) fn token_expired(oauth: &ClaudeOauth, now_ms: i64) -> bool {
    oauth
        .expires_at_ms
        .is_some_and(|expires| expires <= now_ms + EXPIRY_SKEW_MS)
}

pub(crate) fn request(token: &Secret) -> HttpRequest {
    HttpRequest {
        url: USAGE_URL,
        headers: vec![
            ("Authorization", format!("Bearer {}", token.expose())),
            ("anthropic-beta", OAUTH_BETA.to_string()),
            ("Accept", "application/json".to_string()),
        ],
    }
}

/// Plan label from Claude Code's `subscriptionType` / `rateLimitTier`, e.g.
/// `max` + `default_claude_max_20x` → "Max 20x".
pub(crate) fn plan_label(subscription: Option<&str>, tier: Option<&str>) -> Option<String> {
    let subscription = subscription.map(|s| s.trim().to_ascii_lowercase());
    let tier = tier
        .map(|t| t.trim().to_ascii_lowercase())
        .unwrap_or_default();
    let multiplier = tier
        .split(['_', '-', ' '])
        .find(|part| {
            part.len() > 1
                && part.ends_with('x')
                && part[..part.len() - 1].chars().all(|c| c.is_ascii_digit())
        })
        .map(str::to_string);
    let is_max = match subscription.as_deref() {
        Some("max") => true,
        None | Some("") => tier.split(['_', '-']).any(|part| part == "max"),
        Some(_) => false,
    };
    if is_max {
        return Some(match multiplier {
            Some(m) => format!("Max {m}"),
            None => "Max".to_string(),
        });
    }
    subscription.as_deref().and_then(title_case)
}

pub(crate) struct ClaudeUsage {
    pub windows: Vec<LimitWindow>,
    pub extra: Option<ExtraUsage>,
}

/// Map an `/api/oauth/usage` body. `None` when the body is not a JSON
/// object (the caller reports "unexpected response").
pub(crate) fn parse_usage(body: &str) -> Option<ClaudeUsage> {
    let root: Value = serde_json::from_str(body).ok()?;
    if !root.is_object() {
        return None;
    }
    let mut windows: Vec<LimitWindow> = LEGACY_WINDOWS
        .iter()
        .filter_map(|(field, kind, seconds, label)| {
            legacy_window(root.get(*field)?, field, kind, *seconds, *label)
        })
        .collect();
    let scoped = scoped_windows(&root, &windows);
    windows.extend(scoped);
    Some(ClaudeUsage {
        windows,
        extra: root.get("extra_usage").and_then(extra_usage),
    })
}

fn legacy_window(
    value: &Value,
    id: &str,
    kind: &str,
    seconds: i64,
    label: Option<&str>,
) -> Option<LimitWindow> {
    let used_percent = clamp_percent(value.get("utilization")?)?;
    Some(LimitWindow {
        id: id.to_string(),
        kind: kind.to_string(),
        label: label.map(str::to_string),
        used_percent,
        window_seconds: Some(seconds),
        resets_at: value.get("resets_at").and_then(reset_ms),
    })
}

/// Model-scoped weekly windows (e.g. Fable) that only appear in the newer
/// `limits[]` array.
// Mirrors TokenTracker (MIT): take `kind == "weekly_scoped"` entries labelled
// by `scope.model.display_name` (else model id), read `percent`, and drop an
// entry that duplicates a populated legacy model field so the same window
// never renders twice. Generalized here from Opus to Opus and Sonnet.
fn scoped_windows(root: &Value, legacy: &[LimitWindow]) -> Vec<LimitWindow> {
    let Some(entries) = root.get("limits").and_then(Value::as_array) else {
        return Vec::new();
    };
    let legacy_families: Vec<String> = legacy
        .iter()
        .filter_map(|w| w.label.as_deref().map(model_family))
        .collect();
    let mut out: Vec<LimitWindow> = Vec::new();
    for entry in entries {
        if entry.get("kind").and_then(Value::as_str) != Some("weekly_scoped") {
            continue;
        }
        let model = entry.get("scope").and_then(|s| s.get("model"));
        let model_id = model.and_then(|m| trimmed(m.get("id")));
        let Some(label) = model
            .and_then(|m| trimmed(m.get("display_name")))
            .or(model_id.clone())
        else {
            continue;
        };
        if legacy_families.contains(&model_family(&label)) {
            continue;
        }
        let percent = entry.get("percent").or_else(|| entry.get("utilization"));
        let Some(used_percent) = percent.and_then(clamp_percent) else {
            continue;
        };
        let id = format!("scoped:{}", model_id.unwrap_or_else(|| slug(&label)));
        if out.iter().any(|w| w.id == id) {
            continue;
        }
        out.push(LimitWindow {
            id,
            kind: KIND_WEEKLY.to_string(),
            label: Some(label),
            used_percent,
            window_seconds: Some(WEEKLY_WINDOW_SECONDS),
            resets_at: entry.get("resets_at").and_then(reset_ms),
        });
    }
    out
}

/// "Claude Opus 4.5" / "opus" → "opus": the family a legacy field covers.
fn model_family(label: &str) -> String {
    let lower = label.trim().to_ascii_lowercase();
    let without_brand = lower.strip_prefix("claude ").unwrap_or(&lower);
    without_brand
        .split_whitespace()
        .next()
        .unwrap_or_default()
        .to_string()
}

fn slug(label: &str) -> String {
    label
        .trim()
        .to_ascii_lowercase()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join("-")
}

fn trimmed(value: Option<&Value>) -> Option<String> {
    let text = value?.as_str()?.trim();
    (!text.is_empty()).then(|| text.to_string())
}

fn reset_ms(value: &Value) -> Option<i64> {
    super::credentials::timestamp_ms(value)
}

/// `extra_usage` amounts are integer minor units (cents): TokenTracker
/// models `monthly_limit` / `used_credits` as integers and passes them
/// through unconverted; Claude Code shows them as dollars. Only USD (or an
/// unspecified currency) is reported, since the contract is `*_usd`; a
/// missing or zero monthly cap yields `None` (nothing to draw a bar
/// against).
fn extra_usage(value: &Value) -> Option<ExtraUsage> {
    if value.get("is_enabled").and_then(Value::as_bool) != Some(true) {
        return None;
    }
    let currency = value.get("currency").and_then(Value::as_str).map(str::trim);
    if currency.is_some_and(|c| !c.is_empty() && !c.eq_ignore_ascii_case("USD")) {
        return None;
    }
    let limit_cents = value
        .get("monthly_limit")
        .and_then(Value::as_f64)
        .filter(|v| v.is_finite() && *v > 0.0)?;
    let used_cents = value
        .get("used_credits")
        .and_then(Value::as_f64)
        .filter(|v| v.is_finite() && *v >= 0.0)
        .unwrap_or(0.0);
    Some(ExtraUsage {
        used_usd: used_cents / 100.0,
        limit_usd: limit_cents / 100.0,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn maps_legacy_fields() {
        let body = json!({
            "five_hour": { "utilization": 52.0, "resets_at": "2026-10-28T12:00:00.123456+00:00" },
            "seven_day": { "utilization": 137, "resets_at": "2026-11-01T00:00:00Z" },
            "seven_day_opus": { "utilization": 9.5, "resets_at": null },
            "seven_day_sonnet": null,
            "seven_day_oauth_apps": { "utilization": 1 },
            "extra_usage": null
        })
        .to_string();
        let usage = parse_usage(&body).expect("parses");
        let ids: Vec<&str> = usage.windows.iter().map(|w| w.id.as_str()).collect();
        assert_eq!(ids, ["five_hour", "seven_day", "seven_day_opus"]);
        let five = &usage.windows[0];
        assert_eq!(five.kind, "session");
        assert_eq!(five.used_percent, 52.0);
        assert_eq!(five.window_seconds, Some(18_000));
        assert_eq!(five.resets_at, Some(1_793_188_800_000));
        assert_eq!(usage.windows[1].used_percent, 100.0, "clamped to 0..100");
        assert_eq!(usage.windows[1].kind, "weekly");
        assert_eq!(usage.windows[2].label.as_deref(), Some("Opus"));
        assert_eq!(usage.windows[2].resets_at, None);
        assert_eq!(usage.extra, None);
    }

    #[test]
    fn maps_scoped_windows_and_drops_duplicates() {
        let body = json!({
            "five_hour": { "utilization": 10, "resets_at": null },
            "seven_day_opus": { "utilization": 30, "resets_at": null },
            "limits": [
                { "kind": "weekly_scoped", "percent": 2,
                  "resets_at": "2026-11-01T00:00:00Z",
                  "scope": { "model": { "id": "claude-fable-5-1", "display_name": "Fable" } } },
                { "kind": "weekly_scoped", "percent": 31,
                  "scope": { "model": { "display_name": "Claude Opus 5.5" } } },
                { "kind": "weekly_scoped", "percent": 3,
                  "scope": { "model": { "id": "claude-fable-5-1", "display_name": "Fable" } } },
                { "kind": "weekly_scoped", "percent": 7,
                  "scope": { "model": { "display_name": "Haiku Next" } } },
                { "kind": "weekly_scoped", "percent": null,
                  "scope": { "model": { "display_name": "Sonnet" } } },
                { "kind": "five_hour", "percent": 50 }
            ]
        })
        .to_string();
        let usage = parse_usage(&body).expect("parses");
        let ids: Vec<&str> = usage.windows.iter().map(|w| w.id.as_str()).collect();
        assert_eq!(
            ids,
            [
                "five_hour",
                "seven_day_opus",
                "scoped:claude-fable-5-1",
                "scoped:haiku-next"
            ]
        );
        let fable = &usage.windows[2];
        assert_eq!(fable.label.as_deref(), Some("Fable"));
        assert_eq!(fable.kind, "weekly");
        assert_eq!(fable.used_percent, 2.0);
        assert_eq!(fable.window_seconds, Some(604_800));
        assert_eq!(fable.resets_at, Some(1_793_491_200_000));
    }

    #[test]
    fn extra_usage_converts_cents_to_usd() {
        let body = json!({
            "extra_usage": { "is_enabled": true, "monthly_limit": 5000, "used_credits": 1240.0,
                             "utilization": 24.8, "currency": "USD" }
        })
        .to_string();
        let extra = parse_usage(&body).and_then(|u| u.extra).expect("extra");
        assert_eq!(
            extra,
            ExtraUsage {
                used_usd: 12.4,
                limit_usd: 50.0
            }
        );

        for disabled in [
            json!({ "is_enabled": false, "monthly_limit": 5000, "used_credits": 1 }),
            json!({ "is_enabled": true, "monthly_limit": null, "used_credits": 1 }),
            json!({ "is_enabled": true, "monthly_limit": 5000, "used_credits": 1, "currency": "EUR" }),
        ] {
            let body = json!({ "extra_usage": disabled }).to_string();
            assert_eq!(parse_usage(&body).and_then(|u| u.extra), None);
        }
    }

    #[test]
    fn rejects_non_object_bodies() {
        assert!(parse_usage("[]").is_none());
        assert!(parse_usage("<html>").is_none());
        assert!(parse_usage("").is_none());
    }

    #[test]
    fn plan_labels() {
        assert_eq!(
            plan_label(Some("max"), Some("default_claude_max_20x")).as_deref(),
            Some("Max 20x")
        );
        assert_eq!(
            plan_label(Some("max"), Some("default_claude_max_5x")).as_deref(),
            Some("Max 5x")
        );
        assert_eq!(plan_label(Some("max"), None).as_deref(), Some("Max"));
        assert_eq!(
            plan_label(None, Some("default_claude_max_20x")).as_deref(),
            Some("Max 20x")
        );
        assert_eq!(
            plan_label(Some("pro"), Some("default_claude_ai")).as_deref(),
            Some("Pro")
        );
        assert_eq!(plan_label(Some("team"), None).as_deref(), Some("Team"));
        assert_eq!(plan_label(None, None), None);
    }

    #[test]
    fn expiry_uses_skew() {
        let oauth = |expires| ClaudeOauth {
            expires_at_ms: expires,
            ..ClaudeOauth::default()
        };
        assert!(token_expired(&oauth(Some(1_000)), 1_000));
        assert!(token_expired(&oauth(Some(1_000 + EXPIRY_SKEW_MS)), 1_000));
        assert!(!token_expired(&oauth(Some(1_001 + EXPIRY_SKEW_MS)), 1_000));
        assert!(!token_expired(&oauth(None), 1_000));
    }
}

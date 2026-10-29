//! State-machine tests for the limits lookup: fake HTTP, fake credentials
//! and a hand-driven clock. Nothing here reads real credentials or touches
//! the network.

use std::collections::{HashMap, VecDeque};
use std::path::PathBuf;
use std::sync::atomic::{AtomicI64, Ordering};

use futures_util::future::BoxFuture;
use serde_json::json;

use super::credentials::{ClaudeOauth, CodexAuth, CredRead, CredentialSource, Secret};
use super::store::{Store, BACKOFF_STEPS_MS, CACHE_TTL_MS, MAX_RETRY_AFTER_MS, REFRESH_MIN_INTERVAL_MS};
use super::transport::{HttpOutcome, HttpRequest, LimitsHttp};
use super::*;

const T0: i64 = 1_790_000_000_000;
const MIN: i64 = 60_000;
const CLAUDE_TOKEN: &str = "sk-ant-oat01-SECRET-claude-token";
const CODEX_TOKEN: &str = "codex-SECRET-access-token";
const CODEX_ACCOUNT: &str = "acct-SECRET-0001";

struct RecordedCall {
    url: &'static str,
    headers: Vec<(&'static str, String)>,
}

#[derive(Default)]
struct FakeHttp {
    script: parking_lot::Mutex<HashMap<&'static str, VecDeque<HttpOutcome>>>,
    calls: parking_lot::Mutex<Vec<RecordedCall>>,
}

impl FakeHttp {
    fn push(&self, url: &'static str, outcome: HttpOutcome) {
        self.script
            .lock()
            .entry(url)
            .or_default()
            .push_back(outcome);
    }

    fn calls_to(&self, url: &str) -> usize {
        self.calls.lock().iter().filter(|c| c.url == url).count()
    }
}

impl LimitsHttp for FakeHttp {
    fn get<'a>(&'a self, request: &'a HttpRequest) -> BoxFuture<'a, HttpOutcome> {
        self.calls.lock().push(RecordedCall {
            url: request.url,
            headers: request.headers.clone(),
        });
        let outcome = self
            .script
            .lock()
            .get_mut(request.url)
            .and_then(VecDeque::pop_front)
            .expect("unexpected request: no scripted outcome left");
        Box::pin(async move {
            // Let a concurrently polled caller run while "in flight".
            tokio::task::yield_now().await;
            outcome
        })
    }
}

struct FakeCreds {
    claude: parking_lot::Mutex<CredRead<ClaudeOauth>>,
    codex: parking_lot::Mutex<CredRead<CodexAuth>>,
}

impl CredentialSource for FakeCreds {
    fn claude(&self) -> BoxFuture<'_, CredRead<ClaudeOauth>> {
        let read = self.claude.lock().clone();
        Box::pin(async move { read })
    }

    fn codex(&self) -> BoxFuture<'_, CredRead<CodexAuth>> {
        let read = self.codex.lock().clone();
        Box::pin(async move { read })
    }
}

fn claude_login(expires_at_ms: i64) -> ClaudeOauth {
    ClaudeOauth {
        access_token: Some(Secret::new(CLAUDE_TOKEN)),
        expires_at_ms: Some(expires_at_ms),
        subscription_type: Some("max".to_string()),
        rate_limit_tier: Some("default_claude_max_20x".to_string()),
    }
}

fn codex_login() -> CodexAuth {
    CodexAuth {
        access_token: Some(Secret::new(CODEX_TOKEN)),
        account_id: Some(Secret::new(CODEX_ACCOUNT)),
        plan_hint: Some("plus".to_string()),
        expires_at_ms: None,
    }
}

struct Harness {
    http: FakeHttp,
    creds: FakeCreds,
    clock: AtomicI64,
    store: Store,
}

impl Harness {
    fn new() -> Self {
        Self::with_store(Store::new(None))
    }

    fn with_store(store: Store) -> Self {
        Self {
            http: FakeHttp::default(),
            creds: FakeCreds {
                claude: parking_lot::Mutex::new(CredRead::Found(claude_login(T0 + 3_600_000))),
                codex: parking_lot::Mutex::new(CredRead::Found(codex_login())),
            },
            clock: AtomicI64::new(T0),
            store,
        }
    }

    fn at(&self, now: i64) -> &Self {
        self.clock.store(now, Ordering::SeqCst);
        self
    }

    async fn get(&self, ids: &[ProviderId], refresh: bool) -> LimitsResponse {
        let now = || self.clock.load(Ordering::SeqCst);
        let env = Env {
            http: &self.http,
            creds: &self.creds,
            now: &now,
        };
        lookup(&env, &self.store, ids, refresh).await
    }

    async fn one(&self, id: ProviderId, refresh: bool) -> ProviderLimits {
        self.get(&[id], refresh).await.providers.remove(0)
    }
}

fn ok(body: serde_json::Value) -> HttpOutcome {
    HttpOutcome::Response {
        status: 200,
        body: body.to_string(),
        retry_after_secs: None,
    }
}

fn status(code: u16) -> HttpOutcome {
    HttpOutcome::Response {
        status: code,
        body: String::new(),
        retry_after_secs: None,
    }
}

fn claude_body() -> serde_json::Value {
    json!({
        "five_hour": { "utilization": 52.0, "resets_at": "2026-10-28T12:00:00Z" },
        "seven_day": { "utilization": 37.0, "resets_at": "2026-11-01T00:00:00Z" },
        "seven_day_opus": null,
        "limits": [{ "kind": "weekly_scoped", "percent": 2,
                     "scope": { "model": { "id": "claude-fable-5-1", "display_name": "Fable" } } }],
        "extra_usage": { "is_enabled": true, "monthly_limit": 5000, "used_credits": 1240 }
    })
}

fn codex_body() -> serde_json::Value {
    json!({
        "plan_type": "pro",
        "rate_limit": {
            "primary_window": { "used_percent": 8, "limit_window_seconds": 18000, "reset_at": 1_790_014_520 },
            "secondary_window": { "used_percent": 71, "limit_window_seconds": 604800, "reset_at": 1_790_183_600 }
        }
    })
}

fn window_ids(result: &ProviderLimits) -> Vec<&str> {
    result.windows.iter().map(|w| w.id.as_str()).collect()
}

fn scratch_cache_path() -> PathBuf {
    std::env::temp_dir()
        .join(format!("ccgui-usage-limits-test-{}", uuid::Uuid::new_v4()))
        .join("usage-limits-cache.json")
}

#[tokio::test]
async fn claude_ok_maps_plan_windows_extra_and_sends_oauth_headers() {
    let h = Harness::new();
    h.http.push(claude::USAGE_URL, ok(claude_body()));
    let result = h.one(ProviderId::Claude, false).await;

    assert_eq!(result.status, "ok");
    assert_eq!(result.id, "claude");
    assert_eq!(result.host, "api.anthropic.com");
    assert_eq!(result.plan.as_deref(), Some("Max 20x"));
    assert_eq!(
        window_ids(&result),
        ["five_hour", "seven_day", "scoped:claude-fable-5-1"]
    );
    assert_eq!(
        result.extra,
        Some(ExtraUsage {
            used_usd: 12.4,
            limit_usd: 50.0
        })
    );
    assert_eq!(result.fetched_at, Some(T0));
    assert_eq!((result.retry_at, result.error.as_deref()), (None, None));

    let calls = h.http.calls.lock();
    let headers = &calls[0].headers;
    let header = |name: &str| {
        headers
            .iter()
            .find(|(n, _)| *n == name)
            .map(|(_, v)| v.as_str())
    };
    assert_eq!(
        header("Authorization"),
        Some(format!("Bearer {CLAUDE_TOKEN}").as_str())
    );
    assert_eq!(header("anthropic-beta"), Some("oauth-2025-04-20"));
}

#[tokio::test]
async fn codex_ok_prefers_response_plan_and_sends_account_header() {
    let h = Harness::new();
    h.http.push(codex::USAGE_URL, ok(codex_body()));
    let result = h.one(ProviderId::Codex, false).await;

    assert_eq!(result.status, "ok");
    assert_eq!(result.host, "chatgpt.com");
    assert_eq!(
        result.plan.as_deref(),
        Some("Pro"),
        "response plan_type beats the JWT hint"
    );
    assert_eq!(window_ids(&result), ["session", "weekly"]);
    assert_eq!(result.extra, None);
    let calls = h.http.calls.lock();
    assert!(calls[0]
        .headers
        .iter()
        .any(|(n, v)| *n == "ChatGPT-Account-Id" && v == CODEX_ACCOUNT));
}

#[tokio::test]
async fn expired_or_blank_claude_token_short_circuits_without_network() {
    let h = Harness::new();
    *h.creds.claude.lock() = CredRead::Found(claude_login(T0 - 1));
    let result = h.one(ProviderId::Claude, true).await;
    assert_eq!(result.status, "expired");
    assert_eq!(result.plan.as_deref(), Some("Max 20x"));
    assert!(result.windows.is_empty() && result.extra.is_none() && result.fetched_at.is_none());

    *h.creds.claude.lock() = CredRead::Found(ClaudeOauth {
        access_token: None,
        ..claude_login(T0 + 3_600_000)
    });
    assert_eq!(h.one(ProviderId::Claude, true).await.status, "expired");
    assert_eq!(h.http.calls_to(claude::USAGE_URL), 0);
}

#[tokio::test]
async fn expired_codex_jwt_short_circuits_without_network() {
    let h = Harness::new();
    *h.creds.codex.lock() = CredRead::Found(CodexAuth {
        expires_at_ms: Some(T0 - 1),
        ..codex_login()
    });
    let result = h.one(ProviderId::Codex, true).await;
    assert_eq!(result.status, "expired");
    assert_eq!(result.plan.as_deref(), Some("Plus"));
    assert_eq!(h.http.calls_to(codex::USAGE_URL), 0);
}

#[tokio::test]
async fn missing_or_unreadable_credentials() {
    let h = Harness::new();
    *h.creds.claude.lock() = CredRead::Missing;
    *h.creds.codex.lock() = CredRead::Unreadable;
    let response = h.get(&ProviderId::ALL, true).await;
    let claude = &response.providers[0];
    assert_eq!(
        (claude.status.as_str(), claude.plan.as_deref()),
        ("signedOut", None)
    );
    let codex = &response.providers[1];
    assert_eq!(codex.status, "error");
    assert_eq!(codex.error.as_deref(), Some("credentials unreadable"));
    assert!(h.http.calls.lock().is_empty());
}

#[tokio::test]
async fn auth_failures_map_to_expired() {
    let h = Harness::new();
    h.http.push(claude::USAGE_URL, status(401));
    h.http.push(claude::USAGE_URL, status(403));
    h.http.push(codex::USAGE_URL, status(401));
    h.http.push(codex::USAGE_URL, status(403));

    // Each refresh is spaced past the refresh floor so it reaches the network.
    let step = |i: i64| T0 + i * REFRESH_MIN_INTERVAL_MS;
    let claude = h.at(step(0)).one(ProviderId::Claude, true).await;
    assert_eq!(claude.status, "expired");
    assert!(claude.windows.is_empty());
    let claude = h.at(step(1)).one(ProviderId::Claude, true).await;
    assert_eq!(
        (claude.status.as_str(), claude.error.as_deref()),
        ("error", Some("HTTP 403"))
    );
    assert_eq!(h.at(step(0)).one(ProviderId::Codex, true).await.status, "expired");
    // chatgpt.com also answers 403 for Cloudflare challenges: re-login would
    // not help, so it is an error, not "expired".
    let codex = h.at(step(1)).one(ProviderId::Codex, true).await;
    assert_eq!(
        (codex.status.as_str(), codex.error.as_deref()),
        ("error", Some("HTTP 403"))
    );
}

#[tokio::test]
async fn failures_keep_last_good_data() {
    let h = Harness::new();
    h.http.push(claude::USAGE_URL, ok(claude_body()));
    h.http.push(claude::USAGE_URL, HttpOutcome::Network);
    h.http.push(claude::USAGE_URL, status(500));
    h.http.push(claude::USAGE_URL, ok(json!("not an object")));
    h.http.push(claude::USAGE_URL, status(429));
    assert_eq!(h.one(ProviderId::Claude, false).await.status, "ok");

    let offline = h.at(T0 + 2 * MIN).one(ProviderId::Claude, true).await;
    assert_eq!(offline.status, "offline");
    assert_eq!(offline.fetched_at, Some(T0));
    assert_eq!(
        window_ids(&offline),
        ["five_hour", "seven_day", "scoped:claude-fable-5-1"]
    );
    assert_eq!(offline.plan.as_deref(), Some("Max 20x"));

    let server = h.at(T0 + 3 * MIN).one(ProviderId::Claude, true).await;
    assert_eq!(
        (server.status.as_str(), server.error.as_deref()),
        ("error", Some("HTTP 500"))
    );
    assert_eq!(server.fetched_at, Some(T0));

    let garbled = h.at(T0 + 4 * MIN).one(ProviderId::Claude, true).await;
    assert_eq!(garbled.error.as_deref(), Some("unexpected response"));
    assert_eq!(garbled.windows.len(), 3);

    let limited = h.at(T0 + 5 * MIN).one(ProviderId::Claude, true).await;
    assert_eq!(limited.status, "rateLimited");
    assert_eq!(limited.retry_at, Some(T0 + 5 * MIN + MIN));
    assert_eq!(limited.fetched_at, Some(T0));
    assert_eq!(
        limited.extra,
        Some(ExtraUsage {
            used_usd: 12.4,
            limit_usd: 50.0
        })
    );
}

#[tokio::test]
async fn backoff_schedule_and_no_network_before_retry_at() {
    let h = Harness::new();
    let mut now = T0;
    for (n, expected_delay) in [MIN, 2 * MIN, 5 * MIN, 10 * MIN, 10 * MIN]
        .into_iter()
        .enumerate()
    {
        h.http.push(
            claude::USAGE_URL,
            status(if n % 2 == 0 { 429 } else { 503 }),
        );
        let result = h.at(now).one(ProviderId::Claude, true).await;
        assert_eq!(result.status, "rateLimited");
        assert_eq!(result.retry_at, Some(now + expected_delay), "attempt {n}");
        assert_eq!(h.http.calls_to(claude::USAGE_URL), n + 1);

        // A refresh before retryAt must not touch the network.
        let waiting = h
            .at(now + expected_delay - 1)
            .one(ProviderId::Claude, true)
            .await;
        assert_eq!(waiting.status, "rateLimited");
        assert_eq!(waiting.retry_at, Some(now + expected_delay));
        assert_eq!(h.http.calls_to(claude::USAGE_URL), n + 1);
        now += expected_delay;
    }
    assert_eq!(BACKOFF_STEPS_MS, [MIN, 2 * MIN, 5 * MIN, 10 * MIN]);

    // Success resets the schedule.
    h.http.push(claude::USAGE_URL, ok(claude_body()));
    h.http.push(claude::USAGE_URL, status(429));
    assert_eq!(h.at(now).one(ProviderId::Claude, true).await.status, "ok");
    let later = now + REFRESH_MIN_INTERVAL_MS;
    let again = h.at(later).one(ProviderId::Claude, true).await;
    assert_eq!(again.retry_at, Some(later + MIN));
}

#[tokio::test]
async fn retry_after_extends_backoff_up_to_cap() {
    let h = Harness::new();
    let limited = |secs| HttpOutcome::Response {
        status: 429,
        body: String::new(),
        retry_after_secs: Some(secs),
    };
    h.http.push(codex::USAGE_URL, limited(300));
    h.http.push(codex::USAGE_URL, limited(10));
    h.http.push(codex::USAGE_URL, limited(999_999));

    let first = h.at(T0).one(ProviderId::Codex, true).await;
    assert_eq!(first.retry_at, Some(T0 + 5 * MIN));
    let second = h.at(T0 + 5 * MIN).one(ProviderId::Codex, true).await;
    assert_eq!(
        second.retry_at,
        Some(T0 + 5 * MIN + 2 * MIN),
        "schedule wins over a shorter header"
    );
    let third = h.at(T0 + 7 * MIN).one(ProviderId::Codex, true).await;
    assert_eq!(third.retry_at, Some(T0 + 7 * MIN + MAX_RETRY_AFTER_MS));
}

#[tokio::test]
async fn cache_ttl_and_refresh() {
    let h = Harness::new();
    for _ in 0..3 {
        h.http.push(codex::USAGE_URL, ok(codex_body()));
    }
    h.at(T0).one(ProviderId::Codex, false).await;
    let cached = h
        .at(T0 + CACHE_TTL_MS - 1)
        .one(ProviderId::Codex, false)
        .await;
    assert_eq!(
        (cached.status.as_str(), cached.fetched_at),
        ("ok", Some(T0))
    );
    assert_eq!(h.http.calls_to(codex::USAGE_URL), 1);

    let refetched = h.at(T0 + CACHE_TTL_MS).one(ProviderId::Codex, false).await;
    assert_eq!(refetched.fetched_at, Some(T0 + CACHE_TTL_MS));
    assert_eq!(h.http.calls_to(codex::USAGE_URL), 2);

    h.at(T0 + CACHE_TTL_MS + 1)
        .one(ProviderId::Codex, true)
        .await;
    assert_eq!(
        h.http.calls_to(codex::USAGE_URL),
        2,
        "a refresh right after a fetch reuses it (refresh floor)"
    );
    h.at(T0 + CACHE_TTL_MS + REFRESH_MIN_INTERVAL_MS)
        .one(ProviderId::Codex, true)
        .await;
    assert_eq!(
        h.http.calls_to(codex::USAGE_URL),
        3,
        "refresh bypasses the TTL once past the floor"
    );
}

#[tokio::test]
async fn concurrent_callers_share_one_request() {
    let h = Harness::new();
    h.http.push(claude::USAGE_URL, ok(claude_body()));
    let (a, b) = tokio::join!(
        h.one(ProviderId::Claude, true),
        h.one(ProviderId::Claude, true)
    );
    assert_eq!(h.http.calls_to(claude::USAGE_URL), 1);
    assert_eq!(a, b);
}

#[tokio::test]
async fn providers_fail_independently_and_keep_order() {
    let h = Harness::new();
    h.http.push(claude::USAGE_URL, HttpOutcome::Network);
    h.http.push(codex::USAGE_URL, ok(codex_body()));
    let response = h.get(&[ProviderId::Codex, ProviderId::Claude], false).await;
    let statuses: Vec<(&str, &str)> = response
        .providers
        .iter()
        .map(|p| (p.id.as_str(), p.status.as_str()))
        .collect();
    assert_eq!(statuses, [("codex", "ok"), ("claude", "offline")]);
    let claude = &response.providers[1];
    assert!(claude.windows.is_empty() && claude.fetched_at.is_none());
}

#[tokio::test]
async fn persists_last_good_and_serves_it_after_restart() {
    let path = scratch_cache_path();
    let h = Harness::with_store(Store::new(Some(path.clone())));
    h.http.push(claude::USAGE_URL, ok(claude_body()));
    h.http.push(codex::USAGE_URL, ok(codex_body()));
    h.get(&ProviderId::ALL, false).await;

    let on_disk = std::fs::read_to_string(&path).expect("cache written");
    for secret in [CLAUDE_TOKEN, CODEX_TOKEN, CODEX_ACCOUNT, "Bearer"] {
        assert!(!on_disk.contains(secret), "cache file leaked {secret}");
    }

    let restarted = Harness::with_store(Store::new(Some(path.clone())));
    let fresh = restarted
        .at(T0 + 10_000)
        .one(ProviderId::Claude, false)
        .await;
    assert_eq!((fresh.status.as_str(), fresh.fetched_at), ("ok", Some(T0)));
    assert_eq!(
        restarted.http.calls.lock().len(),
        0,
        "young disk copy served without a request"
    );

    restarted.http.push(codex::USAGE_URL, HttpOutcome::Network);
    let offline = restarted
        .at(T0 + 10 * MIN)
        .one(ProviderId::Codex, false)
        .await;
    assert_eq!(offline.status, "offline");
    assert_eq!(offline.fetched_at, Some(T0));
    assert_eq!(window_ids(&offline), ["session", "weekly"]);
    assert_eq!(offline.plan.as_deref(), Some("Pro"));

    let _ = std::fs::remove_dir_all(path.parent().expect("scratch dir"));
}

#[tokio::test]
async fn corrupt_cache_file_is_ignored() {
    let path = scratch_cache_path();
    std::fs::create_dir_all(path.parent().expect("dir")).expect("mkdir");
    std::fs::write(&path, "{ not json").expect("write");
    let h = Harness::with_store(Store::new(Some(path.clone())));
    h.http.push(claude::USAGE_URL, HttpOutcome::Network);
    let result = h.one(ProviderId::Claude, false).await;
    assert_eq!(result.status, "offline");
    assert!(result.windows.is_empty());
    let _ = std::fs::remove_dir_all(path.parent().expect("scratch dir"));
}

#[tokio::test]
async fn serialized_output_never_contains_credentials() {
    let h = Harness::new();
    h.http.push(claude::USAGE_URL, ok(claude_body()));
    h.http.push(codex::USAGE_URL, ok(codex_body()));
    h.http.push(claude::USAGE_URL, status(401));
    h.http.push(codex::USAGE_URL, status(429));
    let mut outputs = vec![h.get(&ProviderId::ALL, true).await];
    outputs.push(h.at(T0 + MIN).get(&ProviderId::ALL, true).await);
    *h.creds.claude.lock() = CredRead::Found(claude_login(T0));
    // Still inside the Codex backoff: served without a request.
    outputs.push(h.at(T0 + 2 * MIN - 1).get(&ProviderId::ALL, true).await);

    let json = serde_json::to_string(&outputs).expect("serializes");
    for secret in [CLAUDE_TOKEN, CODEX_TOKEN, CODEX_ACCOUNT, "Bearer"] {
        assert!(!json.contains(secret), "output leaked {secret}");
    }
    assert!(
        json.contains("\"usedPercent\"") && json.contains("\"fetchedAt\""),
        "camelCase keys"
    );
}

#[test]
fn resolve_ids_defaults_dedupes_and_rejects_unknown() {
    assert_eq!(
        resolve_ids(None).unwrap(),
        [ProviderId::Claude, ProviderId::Codex]
    );
    let ids = vec![
        "codex".to_string(),
        " claude ".to_string(),
        "codex".to_string(),
    ];
    assert_eq!(
        resolve_ids(Some(ids)).unwrap(),
        [ProviderId::Codex, ProviderId::Claude]
    );
    assert!(resolve_ids(Some(vec![])).unwrap().is_empty());
    let error = resolve_ids(Some(vec!["gemini".to_string()])).unwrap_err();
    assert!(error.contains("gemini"));
}

#[test]
fn endpoints_are_fixed_https_vendor_hosts() {
    assert!(claude::USAGE_URL.starts_with("https://api.anthropic.com/"));
    assert!(codex::USAGE_URL.starts_with("https://chatgpt.com/"));
    assert_eq!(ProviderId::Claude.host(), "api.anthropic.com");
    assert_eq!(ProviderId::Codex.host(), "chatgpt.com");
}

#[test]
fn request_debug_hides_header_values() {
    let request = claude::request(&Secret::new(CLAUDE_TOKEN));
    assert!(!format!("{request:?}").contains(CLAUDE_TOKEN));
}

#[test]
fn title_case_labels() {
    assert_eq!(title_case("plus").as_deref(), Some("Plus"));
    assert_eq!(title_case("pro_lite").as_deref(), Some("Pro Lite"));
    assert_eq!(title_case("free").as_deref(), Some("Free"));
    assert_eq!(title_case("unknown"), None);
    assert_eq!(title_case(" "), None);
}

#[test]
fn public_get_future_is_send() {
    // `get` backs an async Tauri command, whose future must be Send. Only
    // constructed, never polled: polling would read real credentials.
    fn assert_send<T: Send>(_: &T) {}
    let future = get(None, false);
    assert_send(&future);
    drop(future);
}

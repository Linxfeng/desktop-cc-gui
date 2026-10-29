//! Model prices (USD per token) from LiteLLM's public table: a bundled
//! snapshot (scripts/build-model-prices.mjs) plus an optional newer copy the
//! user downloaded into `<app home>/model-prices.json`. Download only —
//! nothing is ever uploaded. Unknown models price as `None`, never as some
//! other model's rate.

use super::time::{now_ms, parse_day, utc_today};
use super::types::{PriceInfo, Tokens};
use serde::Deserialize;
use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock, RwLock};

const BUNDLED: &str = include_str!("../../resources/pricing/model-prices.json");
const LITELLM_URL: &str =
    "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";
/// Must match TEXT_MODES in scripts/build-model-prices.mjs.
const TEXT_MODES: [&str; 3] = ["chat", "completion", "responses"];
const MAX_BODY_BYTES: usize = 32 * 1024 * 1024;
const MIN_MODELS: usize = 100;
const RESOLVE_CACHE_CAP: usize = 4096;
/// First-party providers win when several LiteLLM keys share a bare id.
const PROVIDER_PREFERENCE: [&str; 12] = [
    "anthropic",
    "openai",
    "deepseek",
    "moonshot",
    "xai",
    "gemini",
    "mistral",
    "zai",
    "minimax",
    "dashscope",
    "openrouter",
    "vertex_ai",
];

#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct ModelPrice {
    pub input: f64,
    pub output: f64,
    pub cache_read: Option<f64>,
    pub cache_write: Option<f64>,
}

impl ModelPrice {
    /// Cache tokens fall back to the input rate when the table has no
    /// cache price for this model.
    pub fn cost(&self, tokens: &Tokens) -> f64 {
        tokens.input as f64 * self.input
            + tokens.output as f64 * self.output
            + tokens.cache_read as f64 * self.cache_read.unwrap_or(self.input)
            + tokens.cache_write as f64 * self.cache_write.unwrap_or(self.input)
    }
}

pub(crate) struct PriceTable {
    source: String,
    snapshot_date: String,
    updated_at: Option<i64>,
    prices: HashMap<String, ModelPrice>,
    /// lowercase id → table id
    lower: HashMap<String, String>,
    /// lowercase id without provider path → provider-prefixed table ids
    bare: HashMap<String, Vec<String>>,
    resolved: parking_lot::Mutex<HashMap<String, Option<ModelPrice>>>,
}

#[derive(Deserialize)]
struct Snapshot {
    #[serde(rename = "snapshotDate")]
    snapshot_date: String,
    models: HashMap<String, [Option<f64>; 4]>,
}

pub(crate) fn parse_snapshot(
    text: &str,
    source: &str,
    updated_at: Option<i64>,
) -> Result<PriceTable, String> {
    let snapshot: Snapshot = serde_json::from_str(text).map_err(|e| format!("price table: {e}"))?;
    parse_day(&snapshot.snapshot_date)?;
    let mut prices = HashMap::with_capacity(snapshot.models.len());
    for (id, [input, output, cache_read, cache_write]) in snapshot.models {
        if let (Some(input), Some(output)) = (input, output) {
            prices.insert(
                id,
                ModelPrice {
                    input,
                    output,
                    cache_read,
                    cache_write,
                },
            );
        }
    }
    let mut ids: Vec<&String> = prices.keys().collect();
    ids.sort();
    let mut lower = HashMap::new();
    let mut bare: HashMap<String, Vec<String>> = HashMap::new();
    for id in ids {
        let lowered = id.to_lowercase();
        if let Some((_, tail)) = lowered.rsplit_once('/') {
            bare.entry(tail.to_string()).or_default().push(id.clone());
        }
        lower.entry(lowered).or_insert_with(|| id.clone());
    }
    Ok(PriceTable {
        source: source.to_string(),
        snapshot_date: snapshot.snapshot_date,
        updated_at,
        prices,
        lower,
        bare,
        resolved: parking_lot::Mutex::new(HashMap::new()),
    })
}

impl PriceTable {
    pub fn info(&self) -> PriceInfo {
        PriceInfo {
            source: self.source.clone(),
            snapshot_date: self.snapshot_date.clone(),
            updated_at: self.updated_at,
            models: self.prices.len() as i64,
        }
    }

    pub fn price(&self, model: &str) -> Option<ModelPrice> {
        if let Some(hit) = self.resolved.lock().get(model) {
            return *hit;
        }
        let price = self
            .resolve(model)
            .and_then(|id| self.prices.get(&id).copied());
        let mut cache = self.resolved.lock();
        if cache.len() >= RESOLVE_CACHE_CAP {
            cache.clear();
        }
        cache.insert(model.to_string(), price);
        price
    }

    /// Table id for `model`: exact → lowercase → without provider prefix →
    /// without date suffix → Claude dotted version → provider-prefixed
    /// table ids → longest prefix ending at a separator.
    pub fn resolve(&self, model: &str) -> Option<String> {
        let raw = model.trim();
        if raw.is_empty() || raw == "unknown" {
            return None;
        }
        if self.prices.contains_key(raw) {
            return Some(raw.to_string());
        }
        let candidates = candidates(raw);
        if let Some(id) = candidates.iter().find_map(|c| self.lower.get(c)) {
            return Some(id.clone());
        }
        if let Some(id) = candidates
            .iter()
            .find_map(|c| self.bare.get(c).and_then(|ids| preferred(ids)))
        {
            return Some(id);
        }
        candidates.iter().find_map(|c| self.longest_prefix(c))
    }

    /// Mirrors TokenTracker (MIT) suffix stripping, restricted to suffixes
    /// that select a mode of the *same* model (reasoning effort, thinking,
    /// `latest`, `:free`). Any other suffix (`-turbo`, `-plus`, `-spark`,
    /// `-pro`, `-mini`, a version number…) names a different model with its
    /// own price, so the model stays unpriced rather than borrowing one.
    fn longest_prefix(&self, candidate: &str) -> Option<String> {
        let mut cut = candidate.len();
        while let Some(pos) = candidate[..cut].rfind(['-', ':', '@', '_', '/']) {
            let segment = &candidate[pos + 1..cut];
            if pos < 3 || !MODE_SUFFIXES.contains(&segment) {
                return None;
            }
            let prefix = &candidate[..pos];
            if let Some(id) = self.lower.get(prefix) {
                return Some(id.clone());
            }
            if let Some(id) = self.bare.get(prefix).and_then(|ids| preferred(ids)) {
                return Some(id);
            }
            cut = pos;
        }
        None
    }
}

/// Suffixes that pick a mode of one model rather than a different model.
const MODE_SUFFIXES: &[&str] = &[
    "minimal", "low", "medium", "high", "xhigh", "max", "thinking", "nothinking", "latest", "free",
];

fn preferred(ids: &[String]) -> Option<String> {
    let rank = |id: &str| {
        let provider = id.split('/').next().unwrap_or_default();
        PROVIDER_PREFERENCE
            .iter()
            .position(|p| *p == provider)
            .unwrap_or(PROVIDER_PREFERENCE.len())
    };
    ids.iter()
        .min_by(|a, b| rank(a).cmp(&rank(b)).then(a.cmp(b)))
        .cloned()
}

static DATE_SUFFIX: LazyLock<regex::Regex> = LazyLock::new(|| {
    regex::Regex::new(r"(?:[-@_]\d{8}|[-@]\d{4}-\d{2}-\d{2})$").expect("static regex")
});
static CLAUDE_DOTTED: LazyLock<regex::Regex> = LazyLock::new(|| {
    regex::Regex::new(r"^claude-(opus|sonnet|haiku|fable)-(\d+)\.(\d+)").expect("static regex")
});

/// Normalized lookup ids, most specific first, without duplicates.
fn candidates(raw: &str) -> Vec<String> {
    let lower = raw.to_lowercase();
    // `anthropic/claude-x`, `openrouter/anthropic/claude-x` → `claude-x`;
    // a `[1m]`-style context marker is not part of the id.
    let tail = lower.rsplit('/').next().unwrap_or(&lower);
    let bare = tail.split('[').next().unwrap_or(tail).trim().to_string();
    let undated = DATE_SUFFIX.replace(&bare, "").into_owned();
    let claude = CLAUDE_DOTTED
        .replace(&undated, "claude-$1-$2-$3")
        .into_owned();
    let mut out: Vec<String> = Vec::with_capacity(4);
    for candidate in [lower, bare, undated, claude] {
        if !candidate.is_empty() && !out.contains(&candidate) {
            out.push(candidate);
        }
    }
    out
}

/// LiteLLM → compact snapshot models. Same filter as the build script.
pub(crate) fn compact_litellm(raw: &serde_json::Value) -> BTreeMap<String, [Option<f64>; 4]> {
    let cost = |entry: &serde_json::Value, field: &str| {
        entry
            .get(field)
            .and_then(|v| v.as_f64())
            .filter(|v| v.is_finite() && *v >= 0.0)
    };
    let mut out = BTreeMap::new();
    let Some(entries) = raw.as_object() else {
        return out;
    };
    for (id, entry) in entries {
        let mode = entry
            .get("mode")
            .and_then(|m| m.as_str())
            .unwrap_or_default();
        if id == "sample_spec" || !TEXT_MODES.contains(&mode) || id.split('/').count() > 3 {
            continue;
        }
        let (Some(input), Some(output)) = (
            cost(entry, "input_cost_per_token"),
            cost(entry, "output_cost_per_token"),
        ) else {
            continue;
        };
        if input == 0.0 && output == 0.0 {
            continue;
        }
        out.insert(
            id.clone(),
            [
                Some(input),
                Some(output),
                cost(entry, "cache_read_input_token_cost"),
                cost(entry, "cache_creation_input_token_cost"),
            ],
        );
    }
    out
}

fn bundled() -> PriceTable {
    parse_snapshot(BUNDLED, "bundled", None).unwrap_or_else(|error| {
        eprintln!("[usage-stats] bundled price table unreadable: {error}");
        empty_table()
    })
}

fn empty_table() -> PriceTable {
    parse_snapshot(
        r#"{"snapshotDate":"1970-01-01","models":{}}"#,
        "bundled",
        None,
    )
    .expect("static empty table")
}

fn cache_path() -> PathBuf {
    crate::paths::app_home().join("model-prices.json")
}

fn load_cached(path: &Path) -> Option<PriceTable> {
    let text = std::fs::read_to_string(path).ok()?;
    let updated_at = std::fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64);
    match parse_snapshot(&text, "online", updated_at) {
        Ok(table) if !table.prices.is_empty() => Some(table),
        Ok(_) => None,
        Err(error) => {
            eprintln!("[usage-stats] cached price table ignored: {error}");
            None
        }
    }
}

/// Online copy when it is at least as new as the bundled snapshot.
pub(crate) fn load_preferred(cache: &Path) -> PriceTable {
    let bundled = bundled();
    match load_cached(cache) {
        Some(online) if online.snapshot_date >= bundled.snapshot_date => online,
        _ => bundled,
    }
}

static TABLE: LazyLock<RwLock<Arc<PriceTable>>> =
    LazyLock::new(|| RwLock::new(Arc::new(load_preferred(&cache_path()))));

pub(crate) fn current() -> Arc<PriceTable> {
    match TABLE.read() {
        Ok(guard) => Arc::clone(&guard),
        Err(poisoned) => Arc::clone(&poisoned.into_inner()),
    }
}

fn replace_current(table: PriceTable) {
    let mut guard = TABLE
        .write()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    *guard = Arc::new(table);
}

/// Download LiteLLM's table, keep the compact form as the online copy and
/// switch to it. On failure the current table stays in use.
pub(crate) async fn update() -> Result<PriceInfo, String> {
    let body = download().await?;
    let path = cache_path();
    tokio::task::spawn_blocking(move || {
        let raw: serde_json::Value =
            serde_json::from_slice(&body).map_err(|e| format!("parse price table: {e}"))?;
        let text = build_cache_text(&raw, &utc_today())?;
        write_atomically(&path, text.as_bytes())?;
        let table = load_cached(&path).ok_or_else(|| "saved price table unreadable".to_string())?;
        let info = table.info();
        replace_current(table);
        Ok(info)
    })
    .await
    .map_err(|e| format!("price update task: {e}"))?
}

pub(crate) fn build_cache_text(
    raw: &serde_json::Value,
    snapshot_date: &str,
) -> Result<String, String> {
    let models = compact_litellm(raw);
    if models.len() < MIN_MODELS {
        return Err(format!(
            "only {} priced models in the download; keeping the current table",
            models.len()
        ));
    }
    let snapshot = serde_json::json!({
        "source": "litellm",
        "snapshotDate": snapshot_date,
        "models": models,
    });
    serde_json::to_string(&snapshot).map_err(|e| format!("encode price table: {e}"))
}

fn write_atomically(path: &Path, bytes: &[u8]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("create {}: {e}", parent.display()))?;
    }
    let tmp = path.with_extension(format!("json.{}.tmp", now_ms()));
    std::fs::write(&tmp, bytes).map_err(|e| format!("write price table: {e}"))?;
    std::fs::rename(&tmp, path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("save price table: {e}")
    })
}

/// Plain GET; the process-wide proxy env (proxy.rs) applies as for every
/// other reqwest client in the app.
async fn download() -> Result<Vec<u8>, String> {
    let client = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(10))
        .timeout(std::time::Duration::from_secs(90))
        .build()
        .map_err(|e| format!("build http client: {e}"))?;
    let mut response = client
        .get(LITELLM_URL)
        .send()
        .await
        .and_then(|r| r.error_for_status())
        .map_err(|e| format!("download price table: {e}"))?;
    if response
        .content_length()
        .is_some_and(|len| len > MAX_BODY_BYTES as u64)
    {
        return Err("price table exceeds the 32MB limit".to_string());
    }
    let mut body = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|e| format!("download price table: {e}"))?
    {
        if body.len() + chunk.len() > MAX_BODY_BYTES {
            return Err("price table exceeds the 32MB limit".to_string());
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

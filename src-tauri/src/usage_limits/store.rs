//! Per-provider state: TTL cache, 429 backoff, last good result and its
//! on-disk copy (`usage-limits-cache.json`, no secrets — only plan, windows,
//! extra usage and fetch time).

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

use serde::{Deserialize, Serialize};

use super::{clamp_f64, ExtraUsage, LimitWindow, ProviderId};

/// Serve the previous result for this long unless the caller asks for a
/// refresh.
pub(crate) const CACHE_TTL_MS: i64 = 60_000;
/// Floor for explicit refreshes (`refresh: true`): repeated calls inside this
/// window reuse the last answer instead of hitting the vendor again.
pub(crate) const REFRESH_MIN_INTERVAL_MS: i64 = 20_000;
/// Wait after consecutive 429/503 answers: 1 → 2 → 5 → 10 minutes, then
/// 10 minutes for every further one.
pub(crate) const BACKOFF_STEPS_MS: [i64; 4] = [60_000, 120_000, 300_000, 600_000];
/// Upper bound for a server-sent Retry-After that exceeds the schedule.
// Mirrors TokenTracker (MIT): Claude 429 cool-down capped at 60 minutes.
pub(crate) const MAX_RETRY_AFTER_MS: i64 = 60 * 60_000;
const DISK_CACHE_VERSION: u32 = 1;
/// Bounds applied to the on-disk copy so a hand-edited or corrupted file
/// cannot inflate what the UI receives.
const MAX_PERSISTED_WINDOWS: usize = 16;
const MAX_PERSISTED_TEXT: usize = 64;

/// The last successful read. Exactly what is persisted.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GoodData {
    pub plan: Option<String>,
    pub windows: Vec<LimitWindow>,
    pub extra: Option<ExtraUsage>,
    pub fetched_at: i64,
}

#[derive(Debug, Default)]
pub(crate) struct ProviderState {
    seeded: bool,
    pub last_good: Option<GoodData>,
    /// The last result handed out and when it was computed (TTL cache).
    pub last_result: Option<(super::ProviderLimits, i64)>,
    /// Consecutive 429/503 answers; reset by any other server answer.
    pub backoff_level: u32,
    pub retry_at: Option<i64>,
}

impl ProviderState {
    /// Record a 429/503 and return the new `retry_at`.
    pub(crate) fn note_rate_limited(&mut self, now_ms: i64, retry_after_secs: Option<u64>) -> i64 {
        self.backoff_level = self.backoff_level.saturating_add(1);
        let step = backoff_delay_ms(self.backoff_level);
        let server = retry_after_secs
            .map(|secs| i64::try_from(secs).unwrap_or(i64::MAX).saturating_mul(1000))
            .map(|ms| ms.min(MAX_RETRY_AFTER_MS))
            .unwrap_or(0);
        let retry_at = now_ms + step.max(server);
        self.retry_at = Some(retry_at);
        retry_at
    }

    pub(crate) fn clear_backoff(&mut self) {
        self.backoff_level = 0;
        self.retry_at = None;
    }

    /// `retry_at` while it still lies in the future.
    pub(crate) fn active_retry_at(&self, now_ms: i64) -> Option<i64> {
        self.retry_at.filter(|at| now_ms < *at)
    }
}

/// Delay for the n-th consecutive rate-limit answer (n ≥ 1).
pub(crate) fn backoff_delay_ms(level: u32) -> i64 {
    let index = (level.max(1) as usize - 1).min(BACKOFF_STEPS_MS.len() - 1);
    BACKOFF_STEPS_MS[index]
}

pub(crate) struct Slot {
    pub state: tokio::sync::Mutex<ProviderState>,
    /// Bumped whenever a lookup finishes, so a caller that queued behind an
    /// in-flight lookup can reuse its result instead of fetching again.
    pub generation: AtomicU64,
}

impl Slot {
    fn new() -> Self {
        Self {
            state: tokio::sync::Mutex::new(ProviderState::default()),
            generation: AtomicU64::new(0),
        }
    }

    pub(crate) fn generation(&self) -> u64 {
        self.generation.load(Ordering::Acquire)
    }

    pub(crate) fn bump(&self) {
        self.generation.fetch_add(1, Ordering::AcqRel);
    }
}

pub(crate) struct Store {
    claude: Slot,
    codex: Slot,
    disk: parking_lot::Mutex<DiskCache>,
}

impl Store {
    /// `cache_path: None` keeps everything in memory (tests).
    pub(crate) fn new(cache_path: Option<PathBuf>) -> Self {
        Self {
            claude: Slot::new(),
            codex: Slot::new(),
            disk: parking_lot::Mutex::new(DiskCache {
                path: cache_path,
                loaded: false,
                entries: BTreeMap::new(),
            }),
        }
    }

    pub(crate) fn slot(&self, provider: ProviderId) -> &Slot {
        match provider {
            ProviderId::Claude => &self.claude,
            ProviderId::Codex => &self.codex,
        }
    }

    /// Lazily seed `last_good` from disk the first time a provider is used.
    pub(crate) fn seed(&self, provider: ProviderId, state: &mut ProviderState) {
        if state.seeded {
            return;
        }
        state.seeded = true;
        if state.last_good.is_none() {
            state.last_good = self.disk.lock().get(provider.as_str());
        }
    }

    pub(crate) fn persist(&self, provider: ProviderId, good: &GoodData) {
        self.disk.lock().put(provider.as_str(), good.clone());
    }
}

#[derive(Serialize, Deserialize)]
struct DiskFile {
    version: u32,
    #[serde(default)]
    providers: BTreeMap<String, GoodData>,
}

struct DiskCache {
    path: Option<PathBuf>,
    loaded: bool,
    entries: BTreeMap<String, GoodData>,
}

impl DiskCache {
    fn get(&mut self, id: &str) -> Option<GoodData> {
        self.ensure_loaded();
        self.entries.get(id).cloned()
    }

    fn put(&mut self, id: &str, good: GoodData) {
        self.ensure_loaded();
        self.entries.insert(id.to_string(), good);
        let Some(path) = self.path.as_ref() else {
            return;
        };
        let file = DiskFile {
            version: DISK_CACHE_VERSION,
            providers: self.entries.clone(),
        };
        let written = serde_json::to_string_pretty(&file)
            .map_err(|e| e.to_string())
            .and_then(|text| {
                if let Some(dir) = path.parent() {
                    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
                }
                crate::settings::atomic_write(path, &text)
            });
        if let Err(error) = written {
            eprintln!("[usage-limits] failed to persist cache: {error}");
        }
    }

    fn ensure_loaded(&mut self) {
        if self.loaded {
            return;
        }
        self.loaded = true;
        let Some(path) = self.path.as_ref() else {
            return;
        };
        let Ok(text) = std::fs::read_to_string(path) else {
            return;
        };
        let Ok(file) = serde_json::from_str::<DiskFile>(&text) else {
            return;
        };
        if file.version != DISK_CACHE_VERSION {
            return;
        }
        self.entries = file
            .providers
            .into_iter()
            .filter(|(id, _)| ProviderId::parse(id).is_some())
            .map(|(id, good)| (id, sanitize(good)))
            .collect();
    }
}

fn sanitize(good: GoodData) -> GoodData {
    let windows = good
        .windows
        .into_iter()
        .take(MAX_PERSISTED_WINDOWS)
        .map(|w| LimitWindow {
            id: truncate(w.id),
            kind: truncate(w.kind),
            label: w.label.map(truncate),
            used_percent: clamp_f64(w.used_percent),
            ..w
        })
        .collect();
    GoodData {
        plan: good.plan.map(truncate),
        windows,
        extra: good
            .extra
            .filter(|e| e.used_usd.is_finite() && e.limit_usd.is_finite()),
        fetched_at: good.fetched_at,
    }
}

fn truncate(text: String) -> String {
    if text.chars().count() <= MAX_PERSISTED_TEXT {
        return text;
    }
    text.chars().take(MAX_PERSISTED_TEXT).collect()
}

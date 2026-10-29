//! Public IPC shapes (camelCase on the wire) and the internal event model.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryRequest {
    /// Local `YYYY-MM-DD`, inclusive.
    pub from: String,
    /// Local `YYYY-MM-DD`, inclusive.
    pub to: String,
    /// `"day"` (default) or `"hour"`.
    #[serde(default)]
    pub bucket: Option<String>,
    /// Minutes east of UTC (480 for UTC+8).
    #[serde(default)]
    pub tz_offset_minutes: i32,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageStatRow {
    /// Local `2026-10-27` (day) or `2026-10-27T14` (hour).
    pub bucket: String,
    pub engine: String,
    pub model: String,
    /// Session working directory.
    pub project: Option<String>,
    /// Distinct sessions in the group.
    pub sessions: i64,
    /// Model responses (events) in the group.
    pub requests: i64,
    /// Uncached input tokens.
    pub input: i64,
    /// Output tokens, reasoning included.
    pub output: i64,
    pub cache_read: i64,
    pub cache_write: i64,
    /// Reasoning tokens (already part of `output`; informational).
    pub reasoning: i64,
    /// Estimated USD; `None` when the model has no known price.
    pub cost: Option<f64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryResponse {
    pub rows: Vec<UsageStatRow>,
    /// First local day with any recorded usage (whole history).
    pub first_day: Option<String>,
    /// Epoch ms of the last completed scan.
    pub scanned_at: Option<i64>,
    pub scanning: bool,
    /// Models in `rows` without a known price.
    pub unknown_models: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceStatus {
    pub engine: String,
    pub label: String,
    pub roots: Vec<String>,
    /// Environment variable this source honors for its home, if any.
    pub env: Option<String>,
    /// Session files currently found under `roots`.
    pub files: i64,
    /// `ok` | `missing` | `denied` | `error`.
    pub status: String,
    pub error: Option<String>,
    pub last_scan_at: Option<i64>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanSummary {
    /// Files whose content was (re)read in this scan.
    pub files_scanned: i64,
    /// Events inserted or changed.
    pub events_added: i64,
    pub duration_ms: i64,
    pub scanned_at: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PriceInfo {
    /// `bundled` | `online`.
    pub source: String,
    pub snapshot_date: String,
    /// Epoch ms the online copy was saved; `None` for the bundled snapshot.
    pub updated_at: Option<i64>,
    pub models: i64,
}

/// Normalized token counts for one model response. `input` excludes cache
/// reads/writes; `reasoning` is a subset of `output`.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) struct Tokens {
    pub input: i64,
    pub output: i64,
    pub cache_read: i64,
    pub cache_write: i64,
    pub reasoning: i64,
}

impl Tokens {
    pub fn is_zero(&self) -> bool {
        self.input == 0
            && self.output == 0
            && self.cache_read == 0
            && self.cache_write == 0
            && self.reasoning == 0
    }
}

/// One deduplicated model response. `key` is globally unique per response
/// so re-reading, copied or forked logs upsert instead of double counting.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct UsageEvent {
    pub key: String,
    pub ts_ms: i64,
    pub engine: &'static str,
    pub model: String,
    pub project: Option<String>,
    pub session_id: Option<String>,
    pub tokens: Tokens,
}

/// Engines whose logs this layer reads.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub(crate) enum Engine {
    Claude,
    Codex,
    Pi,
    Omp,
}

impl Engine {
    pub const ALL: [Engine; 4] = [Engine::Claude, Engine::Codex, Engine::Pi, Engine::Omp];

    pub fn id(self) -> &'static str {
        match self {
            Engine::Claude => "claude",
            Engine::Codex => "codex",
            Engine::Pi => "pi",
            Engine::Omp => "omp",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Engine::Claude => "Claude Code",
            Engine::Codex => "Codex",
            Engine::Pi => "Pi",
            Engine::Omp => "oh-my-pi",
        }
    }

    pub fn env(self) -> Option<&'static str> {
        match self {
            Engine::Claude => Some("CLAUDE_CONFIG_DIR"),
            Engine::Codex => Some("CODEX_HOME"),
            Engine::Pi | Engine::Omp => None,
        }
    }

    /// Whether a file name under this engine's roots is a session log.
    pub fn accepts_file(self, name: &str) -> bool {
        match self {
            Engine::Codex => name.starts_with("rollout-") && name.ends_with(".jsonl"),
            Engine::Claude | Engine::Pi | Engine::Omp => name.ends_with(".jsonl"),
        }
    }
}

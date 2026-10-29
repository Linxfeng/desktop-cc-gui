//! Per-engine JSONL line parsers. Each parser is fed one complete line at a
//! time and may carry a little state between lines (Codex's current model,
//! pi's session header). That state is serialized into the file cursor so an
//! incremental read resumes exactly where the previous one stopped.

pub(crate) mod claude;
pub(crate) mod codex;
pub(crate) mod pi;

use super::types::{Engine, UsageEvent};
use serde::{Deserialize, Deserializer};
use std::collections::HashMap;

/// Cross-file state shared by every parser in one scan.
#[derive(Debug, Default)]
pub(crate) struct ParseCtx {
    /// Codex session id → lineage root (the session a fork chain started
    /// from). Loaded from the DB at scan start.
    pub codex_roots: HashMap<String, String>,
    /// Lineage pairs learned while parsing the current file; the scanner
    /// persists them with the file's events.
    pub new_lineage: Vec<(String, String)>,
}

impl ParseCtx {
    pub fn codex_root(&self, session_id: &str) -> String {
        self.codex_roots
            .get(session_id)
            .cloned()
            .unwrap_or_else(|| session_id.to_string())
    }

    pub fn set_codex_root(&mut self, session_id: &str, root: &str) {
        if self.codex_roots.get(session_id).map(String::as_str) == Some(root) {
            return;
        }
        self.codex_roots
            .insert(session_id.to_string(), root.to_string());
        self.new_lineage
            .push((session_id.to_string(), root.to_string()));
    }
}

pub(crate) enum FileParser {
    Claude(claude::ClaudeParser),
    Codex(codex::CodexParser),
    Pi(pi::PiParser),
}

impl FileParser {
    /// `state` is the JSON saved by [`FileParser::state_json`] after the
    /// previous read of the same file (None when reading from byte 0).
    pub fn new(engine: Engine, file_name: &str, state: Option<&str>) -> Self {
        match engine {
            Engine::Claude => FileParser::Claude(claude::ClaudeParser),
            Engine::Codex => FileParser::Codex(codex::CodexParser::new(file_name, state)),
            Engine::Pi | Engine::Omp => FileParser::Pi(pi::PiParser::new(engine, state)),
        }
    }

    /// Cheap byte-level prefilter: false means the line cannot matter, so
    /// it is skipped without JSON parsing.
    pub fn wants(&self, line: &[u8]) -> bool {
        match self {
            FileParser::Claude(p) => p.wants(line),
            FileParser::Codex(p) => p.wants(line),
            FileParser::Pi(p) => p.wants(line),
        }
    }

    pub fn feed(&mut self, line: &[u8], ctx: &mut ParseCtx, out: &mut Vec<UsageEvent>) {
        match self {
            FileParser::Claude(p) => p.feed(line, out),
            FileParser::Codex(p) => p.feed(line, ctx, out),
            FileParser::Pi(p) => p.feed(line, out),
        }
    }

    pub fn state_json(&self) -> Option<String> {
        match self {
            FileParser::Claude(_) => None,
            FileParser::Codex(p) => p.state_json(),
            FileParser::Pi(p) => p.state_json(),
        }
    }
}

pub(crate) fn contains(haystack: &[u8], needle: &[u8]) -> bool {
    if needle.is_empty() || haystack.len() < needle.len() {
        return needle.is_empty();
    }
    let first = needle[0];
    haystack
        .windows(needle.len())
        .any(|window| window[0] == first && window == needle)
}

/// Trimmed non-empty string, else None.
pub(crate) fn clean(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

/// Lenient token count: any non-negative JSON number (floored), else 0.
/// Strings, negatives and nulls never fail the whole line.
pub(crate) fn de_count<'de, D: Deserializer<'de>>(deserializer: D) -> Result<i64, D::Error> {
    let value = serde_json::Value::deserialize(deserializer)?;
    Ok(count_of(&value))
}

pub(crate) fn de_opt_count<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<i64>, D::Error> {
    let value = serde_json::Value::deserialize(deserializer)?;
    Ok(value.as_f64().map(|_| count_of(&value)))
}

/// No single model response reports anywhere near this many tokens; larger
/// values are corrupt lines. Reading them as 0 keeps SQLite's integer SUM()
/// from overflowing (which would fail every query covering that day).
const MAX_TOKENS_PER_EVENT: f64 = 1e10;

pub(crate) fn count_of(value: &serde_json::Value) -> i64 {
    match value.as_f64() {
        Some(n) if n.is_finite() && n > 0.0 && n <= MAX_TOKENS_PER_EVENT => n.floor() as i64,
        _ => 0,
    }
}

/// Lenient optional string: non-strings read as None instead of failing.
pub(crate) fn de_opt_string<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<String>, D::Error> {
    let value = serde_json::Value::deserialize(deserializer)?;
    Ok(clean(value.as_str()))
}

/// Model id as stored: trimmed, `unknown` when absent.
pub(crate) fn model_or_unknown(model: Option<String>) -> String {
    model.unwrap_or_else(|| "unknown".to_string())
}

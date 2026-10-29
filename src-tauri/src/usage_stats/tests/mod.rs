//! usage_stats tests. Everything runs on scratch directories and scratch
//! databases; only `sources` touches HOME, under `paths::HOME_ENV_LOCK`.

mod parsers;
mod pricing;
mod query;
mod real_machine;
mod scan;
mod sources;

use super::parsers::{FileParser, ParseCtx};
use super::sources::SourceSpec;
use super::types::{Engine, UsageEvent};
use serde_json::json;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};

static NEXT_SCRATCH: AtomicUsize = AtomicUsize::new(0);

/// Temp directory removed on drop.
pub(super) struct Scratch(pub PathBuf);

impl Scratch {
    pub fn new(tag: &str) -> Self {
        let n = NEXT_SCRATCH.fetch_add(1, Ordering::SeqCst);
        let dir = std::env::temp_dir().join(format!(
            "ccgui-usage-stats-{tag}-{}-{n}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        Self(dir)
    }

    pub fn path(&self, rel: &str) -> PathBuf {
        self.0.join(rel)
    }

    pub fn db(&self) -> rusqlite::Connection {
        super::store::open(&self.0.join("usage-stats.db")).unwrap()
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

pub(super) fn write_lines(path: &Path, lines: &[String]) {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).unwrap();
    }
    let mut text = lines.join("\n");
    text.push('\n');
    std::fs::write(path, text).unwrap();
}

pub(super) fn append_text(path: &Path, text: &str) {
    use std::io::Write;
    let mut file = std::fs::OpenOptions::new().append(true).open(path).unwrap();
    file.write_all(text.as_bytes()).unwrap();
}

/// Parse `lines` as one file with a fresh parser and shared `ctx`.
pub(super) fn feed_with(
    engine: Engine,
    file_name: &str,
    lines: &[String],
    ctx: &mut ParseCtx,
) -> Vec<UsageEvent> {
    let mut parser = FileParser::new(engine, file_name, None);
    let mut out = Vec::new();
    for line in lines {
        if parser.wants(line.as_bytes()) {
            parser.feed(line.as_bytes(), ctx, &mut out);
        }
    }
    out
}

pub(super) fn feed(engine: Engine, file_name: &str, lines: &[String]) -> Vec<UsageEvent> {
    feed_with(engine, file_name, lines, &mut ParseCtx::default())
}

pub(super) fn spec(engine: Engine, root: &Path) -> SourceSpec {
    SourceSpec {
        engine,
        roots: vec![root.to_path_buf()],
    }
}

// ── fixture lines ───────────────────────────────────────────────────────────

/// usage = [input, output, cache_read, cache_write]
pub(super) fn claude_line(
    msg_id: &str,
    req: &str,
    ts: &str,
    model: &str,
    usage: [i64; 4],
) -> String {
    json!({
        "type": "assistant",
        "sessionId": "sess-1",
        "cwd": "/work/alpha",
        "timestamp": ts,
        "requestId": req,
        "uuid": format!("uuid-{msg_id}-{ts}"),
        "message": {
            "id": msg_id,
            "model": model,
            "role": "assistant",
            "content": [{"type": "text", "text": "secret prompt text"}],
            "usage": {
                "input_tokens": usage[0],
                "output_tokens": usage[1],
                "cache_read_input_tokens": usage[2],
                "cache_creation_input_tokens": usage[3],
            }
        }
    })
    .to_string()
}

pub(super) fn codex_meta(id: &str, cwd: &str, forked_from: Option<&str>) -> String {
    let mut payload = json!({"id": id, "cwd": cwd, "base_instructions": "x".repeat(2000)});
    if let Some(parent) = forked_from {
        payload["forked_from_id"] = json!(parent);
    }
    json!({"timestamp": "2026-10-27T10:00:00.000Z", "type": "session_meta", "payload": payload})
        .to_string()
}

pub(super) fn codex_turn(model: &str) -> String {
    json!({"timestamp": "2026-10-27T10:00:01.000Z", "type": "turn_context",
           "payload": {"model": model, "cwd": "/work/codex"}})
    .to_string()
}

/// [input(incl. cached), cached, output, reasoning]
fn codex_usage(u: [i64; 4]) -> serde_json::Value {
    json!({"input_tokens": u[0], "cached_input_tokens": u[1], "cache_write_input_tokens": 0,
           "output_tokens": u[2], "reasoning_output_tokens": u[3], "total_tokens": u[0] + u[2]})
}

pub(super) fn codex_tc(ts: &str, last: [i64; 4], total: [i64; 4]) -> String {
    json!({"timestamp": ts, "type": "event_msg", "payload": {"type": "token_count",
           "info": {"last_token_usage": codex_usage(last), "total_token_usage": codex_usage(total)},
           "rate_limits": {"primary": null}}})
    .to_string()
}

pub(super) fn codex_record(ts: &str, response_id: &str, usage: [i64; 4]) -> String {
    json!({"timestamp": ts, "type": "token_usage_record",
           "payload": {"response_id": response_id, "usage": codex_usage(usage)}})
    .to_string()
}

pub(super) fn pi_header(id: &str, cwd: &str) -> String {
    json!({"type": "session", "version": 3, "id": id, "timestamp": "2026-10-25T04:54:29.653Z", "cwd": cwd}).to_string()
}

/// usage = [input, output, cache_read, cache_write]
pub(super) fn pi_assistant(
    entry_id: &str,
    ts_ms: i64,
    response_id: Option<&str>,
    model: &str,
    usage: [i64; 4],
) -> String {
    let mut message = json!({
        "role": "assistant", "provider": "deepseek", "model": model,
        "content": [{"type": "text", "text": "hello"}],
        "usage": {"input": usage[0], "output": usage[1], "cacheRead": usage[2], "cacheWrite": usage[3],
                  "reasoningTokens": 7, "totalTokens": usage.iter().sum::<i64>(),
                  "cost": {"total": 0.001}},
        "timestamp": ts_ms,
    });
    if let Some(id) = response_id {
        message["responseId"] = json!(id);
    }
    json!({"type": "message", "id": entry_id, "parentId": null,
           "timestamp": "2026-10-25T04:50:49.544Z", "message": message})
    .to_string()
}

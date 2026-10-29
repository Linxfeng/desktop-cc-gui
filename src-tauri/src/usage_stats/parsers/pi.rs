//! pi (`~/.pi/agent/sessions`) and oh-my-pi (`~/.omp/agent/sessions`)
//! session logs: `<cwd-slug>/<ts>_<session>.jsonl`, with task subagents in
//! nested directories. Each file starts with a `{"type":"session",id,cwd}`
//! header (a `title` line may precede it); `type:"message"` entries whose
//! `message.role` is `assistant` carry `usage` {input, output, cacheRead,
//! cacheWrite, reasoning|reasoningTokens}. `input` already excludes cache
//! reads and reasoning is part of `output` (totalTokens = input + output +
//! cacheRead + cacheWrite on real logs).
//!
//! Key: engine + response timestamp + provider `responseId` (entry id when
//! absent). A forked/branched session copies these entries verbatim, so the
//! copy upserts onto the original instead of double counting. The 8-hex
//! entry id alone is too short to be globally unique across sessions.

use super::{clean, de_count, de_opt_count, de_opt_string, model_or_unknown, UsageEvent};
use crate::usage_stats::time::{epoch_ms_from_number, parse_iso_ms};
use crate::usage_stats::types::{Engine, Tokens};
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
struct State {
    #[serde(default)]
    session_id: Option<String>,
    #[serde(default)]
    cwd: Option<String>,
    #[serde(default)]
    header_seen: bool,
}

#[derive(Deserialize)]
struct Line {
    #[serde(default, rename = "type", deserialize_with = "de_opt_string")]
    kind: Option<String>,
    #[serde(default, deserialize_with = "de_opt_string")]
    id: Option<String>,
    #[serde(default, deserialize_with = "de_opt_string")]
    timestamp: Option<String>,
    #[serde(default, deserialize_with = "de_opt_string")]
    cwd: Option<String>,
    #[serde(default)]
    message: Option<Message>,
}

#[derive(Deserialize)]
struct Message {
    #[serde(default, deserialize_with = "de_opt_string")]
    role: Option<String>,
    #[serde(default, deserialize_with = "de_opt_string")]
    model: Option<String>,
    #[serde(default)]
    usage: Option<Usage>,
    #[serde(default)]
    timestamp: Option<Value>,
    #[serde(default, rename = "responseId", deserialize_with = "de_opt_string")]
    response_id: Option<String>,
}

#[derive(Deserialize)]
struct Usage {
    #[serde(default, deserialize_with = "de_count")]
    input: i64,
    #[serde(default, deserialize_with = "de_count")]
    output: i64,
    #[serde(default, rename = "cacheRead", deserialize_with = "de_count")]
    cache_read: i64,
    #[serde(default, rename = "cacheWrite", deserialize_with = "de_count")]
    cache_write: i64,
    #[serde(default, rename = "reasoningTokens", deserialize_with = "de_opt_count")]
    reasoning_tokens: Option<i64>,
    #[serde(default, deserialize_with = "de_opt_count")]
    reasoning: Option<i64>,
}

pub(crate) struct PiParser {
    engine: &'static str,
    state: State,
}

impl PiParser {
    pub fn new(engine: Engine, state: Option<&str>) -> Self {
        Self {
            engine: engine.id(),
            state: state
                .and_then(|text| serde_json::from_str(text).ok())
                .unwrap_or_default(),
        }
    }

    pub fn state_json(&self) -> Option<String> {
        serde_json::to_string(&self.state).ok()
    }

    pub fn wants(&self, line: &[u8]) -> bool {
        super::contains(line, b"\"usage\"")
            || (!self.state.header_seen && super::contains(line, b"\"session\""))
    }

    pub fn feed(&mut self, line: &[u8], out: &mut Vec<UsageEvent>) {
        let Ok(parsed) = serde_json::from_slice::<Line>(line) else {
            return;
        };
        match parsed.kind.as_deref() {
            Some("session") if !self.state.header_seen => {
                self.state.header_seen = true;
                self.state.session_id = parsed.id;
                self.state.cwd = parsed.cwd;
            }
            Some("message") => {
                if let Some(event) = self.message_event(parsed) {
                    out.push(event);
                }
            }
            _ => {}
        }
    }

    fn message_event(&self, line: Line) -> Option<UsageEvent> {
        let message = line.message?;
        if message.role.as_deref() != Some("assistant") {
            return None;
        }
        let usage = message.usage?;
        let tokens = Tokens {
            input: usage.input,
            output: usage.output,
            cache_read: usage.cache_read,
            cache_write: usage.cache_write,
            reasoning: usage
                .reasoning_tokens
                .or(usage.reasoning)
                .unwrap_or(0)
                .min(usage.output),
        };
        if tokens.is_zero() {
            return None;
        }
        let ts_ms = match message.timestamp.as_ref() {
            Some(Value::Number(n)) => n.as_f64().and_then(epoch_ms_from_number),
            Some(Value::String(text)) => parse_iso_ms(text),
            _ => None,
        }
        .or_else(|| line.timestamp.as_deref().and_then(parse_iso_ms))?;
        let id = message.response_id.or(line.id)?;
        Some(UsageEvent {
            key: format!("{}:{ts_ms}:{id}", self.engine),
            ts_ms,
            engine: self.engine,
            model: model_or_unknown(clean(message.model.as_deref())),
            project: self.state.cwd.clone(),
            session_id: self.state.session_id.clone(),
            tokens,
        })
    }
}

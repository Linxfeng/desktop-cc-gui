use super::*;
use crate::usage_stats::store;
use crate::usage_stats::time::parse_iso_ms;
use crate::usage_stats::types::Tokens;

fn store_all(scratch: &Scratch, events: &[UsageEvent]) -> rusqlite::Connection {
    let conn = scratch.db();
    for event in events {
        store::upsert_event(&conn, event).unwrap();
    }
    conn
}

// ── Claude ──────────────────────────────────────────────────────────────────

#[test]
fn claude_lines_of_one_response_collapse_to_one_event() {
    let scratch = Scratch::new("claude-dedupe");
    let usage = [2, 249, 14_316, 27_469];
    let lines = vec![
        claude_line(
            "msg_1",
            "req_1",
            "2026-10-26T08:47:30.952Z",
            "claude-opus-5-5",
            usage,
        ),
        claude_line(
            "msg_1",
            "req_1",
            "2026-10-26T08:47:32.118Z",
            "claude-opus-5-5",
            usage,
        ),
        claude_line(
            "msg_2",
            "req_2",
            "2026-10-26T08:47:34.435Z",
            "claude-opus-5-5",
            [2, 199, 41_785, 4_430],
        ),
    ];
    let events = feed(Engine::Claude, "s.jsonl", &lines);
    assert_eq!(events.len(), 3, "every usage line parses");
    assert_eq!(events[0].key, events[1].key, "same message.id + requestId");
    assert_eq!(events[0].key, "claude:msg_1:req_1");
    assert_eq!(
        events[0].tokens,
        Tokens {
            input: 2,
            output: 249,
            cache_read: 14_316,
            cache_write: 27_469,
            reasoning: 0
        }
    );
    assert_eq!(events[0].project.as_deref(), Some("/work/alpha"));
    assert_eq!(events[0].session_id.as_deref(), Some("sess-1"));

    let conn = store_all(&scratch, &events);
    assert_eq!(store::event_count(&conn), 2);
    let first_ts: i64 = conn
        .query_row(
            "SELECT ts_ms FROM events WHERE key = 'claude:msg_1:req_1'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(
        Some(first_ts),
        parse_iso_ms("2026-10-26T08:47:30.952Z"),
        "earliest line keeps its time"
    );
}

#[test]
fn claude_duplicate_upsert_is_last_write_wins_for_usage() {
    let scratch = Scratch::new("claude-lww");
    let first = feed(
        Engine::Claude,
        "a.jsonl",
        &[claude_line(
            "m",
            "r",
            "2026-10-26T08:00:00Z",
            "claude-x",
            [1, 10, 0, 0],
        )],
    );
    let later = feed(
        Engine::Claude,
        "a.jsonl",
        &[claude_line(
            "m",
            "r",
            "2026-10-26T08:00:01Z",
            "claude-x",
            [1, 99, 0, 0],
        )],
    );
    let conn = store_all(&scratch, &first);
    assert!(
        store::upsert_event(&conn, &later[0]).unwrap(),
        "changed usage reports a change"
    );
    assert!(
        !store::upsert_event(&conn, &later[0]).unwrap(),
        "identical upsert is a no-op"
    );
    let output: i64 = conn
        .query_row("SELECT output FROM events", [], |r| r.get(0))
        .unwrap();
    assert_eq!(output, 99);
}

#[test]
fn claude_skips_synthetic_zero_and_non_assistant_lines() {
    let mut user = serde_json::from_str::<serde_json::Value>(&claude_line(
        "u",
        "r",
        "2026-10-26T08:00:00Z",
        "claude-x",
        [5, 5, 0, 0],
    ))
    .unwrap();
    user["type"] = serde_json::json!("user");
    let lines = vec![
        claude_line(
            "syn",
            "",
            "2026-10-26T08:00:00Z",
            "<synthetic>",
            [0, 3, 0, 0],
        ),
        claude_line(
            "zero",
            "r0",
            "2026-10-26T08:00:00Z",
            "claude-x",
            [0, 0, 0, 0],
        ),
        user.to_string(),
        "not json at all \"usage\"".to_string(),
        r#"{"type":"assistant","message":{"id":"x","usage":{"input_tokens":3}}}"#.to_string(),
    ];
    assert!(
        feed(Engine::Claude, "s.jsonl", &lines).is_empty(),
        "no timestamp → skipped too"
    );
}

#[test]
fn claude_without_message_id_falls_back_to_line_uuid() {
    let mut line: serde_json::Value = serde_json::from_str(&claude_line(
        "m",
        "r",
        "2026-10-26T08:00:00Z",
        "glm-5",
        [1, 2, 0, 0],
    ))
    .unwrap();
    line["message"].as_object_mut().unwrap().remove("id");
    let events = feed(Engine::Claude, "s.jsonl", &[line.to_string()]);
    assert_eq!(events.len(), 1);
    assert!(events[0].key.starts_with("claude:uuid:"));
}

// ── Codex ───────────────────────────────────────────────────────────────────

#[test]
fn codex_token_count_normalizes_cached_input() {
    let lines = vec![
        codex_meta("sess-a", "/work/codex", None),
        codex_turn("gpt-5.1-codex"),
        codex_tc(
            "2026-10-27T10:00:05.000Z",
            [1000, 800, 50, 20],
            [1000, 800, 50, 20],
        ),
    ];
    let events = feed(
        Engine::Codex,
        "rollout-2026-10-27T10-00-00-sess-a.jsonl",
        &lines,
    );
    assert_eq!(events.len(), 1);
    let event = &events[0];
    assert_eq!(
        event.tokens,
        Tokens {
            input: 200,
            output: 50,
            cache_read: 800,
            cache_write: 0,
            reasoning: 20
        }
    );
    assert_eq!(event.model, "gpt-5.1-codex");
    assert_eq!(event.project.as_deref(), Some("/work/codex"));
    assert_eq!(event.session_id.as_deref(), Some("sess-a"));
    assert!(event.key.starts_with("codex:tc:sess-a:"));
}

#[test]
fn codex_repeated_token_count_is_counted_once() {
    let lines = vec![
        codex_meta("sess-a", "/w", None),
        codex_turn("gpt-5"),
        codex_tc("2026-10-27T10:00:05.000Z", [100, 0, 10, 0], [100, 0, 10, 0]),
        // Same cumulative total again (rate-limit refresh): not a response.
        codex_tc("2026-10-27T10:00:06.000Z", [100, 0, 10, 0], [100, 0, 10, 0]),
        codex_tc(
            "2026-10-27T10:00:09.000Z",
            [150, 100, 5, 0],
            [250, 100, 15, 0],
        ),
    ];
    let events = feed(Engine::Codex, "rollout-x.jsonl", &lines);
    assert_eq!(events.len(), 2);
    assert_eq!(events[1].tokens.input, 50);
    assert_eq!(events[1].tokens.cache_read, 100);
}

#[test]
fn codex_record_and_its_token_count_count_once() {
    let lines = vec![
        codex_meta("sess-r", "/w", None),
        codex_turn("gpt-5.6-sol"),
        codex_record(
            "2026-10-27T10:00:05.000Z",
            "resp_1",
            [27_911, 5_618, 160, 0],
        ),
        codex_tc(
            "2026-10-27T10:00:05.001Z",
            [27_911, 5_618, 160, 0],
            [27_911, 5_618, 160, 0],
        ),
        codex_record("2026-10-27T10:00:09.000Z", "resp_2", [17_372, 17_024, 9, 0]),
        codex_tc(
            "2026-10-27T10:00:09.001Z",
            [17_372, 17_024, 9, 0],
            [45_283, 22_642, 169, 0],
        ),
    ];
    let events = feed(Engine::Codex, "rollout-r.jsonl", &lines);
    let keys: Vec<&str> = events.iter().map(|e| e.key.as_str()).collect();
    assert_eq!(keys, ["codex:resp:resp_1", "codex:resp:resp_2"]);
    assert_eq!(events[0].tokens.input, 27_911 - 5_618);
}

#[test]
fn codex_compaction_record_counts_although_total_does_not_move() {
    let lines = vec![
        codex_meta("sess-c", "/w", None),
        codex_turn("gpt-5"),
        codex_record("2026-10-27T10:00:05.000Z", "resp_1", [100, 0, 10, 0]),
        codex_tc("2026-10-27T10:00:05.001Z", [100, 0, 10, 0], [100, 0, 10, 0]),
        codex_record(
            "2026-10-27T10:01:00.000Z",
            "resp_compact",
            [5000, 0, 300, 0],
        ),
        r#"{"timestamp":"2026-10-27T10:01:00.100Z","type":"compacted","payload":{"message":""}}"#
            .to_string(),
        codex_tc("2026-10-27T10:01:00.200Z", [40, 0, 0, 0], [100, 0, 10, 0]),
    ];
    let events = feed(Engine::Codex, "rollout-c.jsonl", &lines);
    let keys: Vec<&str> = events.iter().map(|e| e.key.as_str()).collect();
    assert_eq!(keys, ["codex:resp:resp_1", "codex:resp:resp_compact"]);
}

#[test]
fn codex_fork_replay_collapses_onto_parent_events() {
    let scratch = Scratch::new("codex-fork");
    let mut ctx = ParseCtx::default();
    let parent = vec![
        codex_meta("parent", "/w", None),
        codex_turn("gpt-5"),
        codex_tc("2026-10-27T09:00:00.000Z", [100, 0, 10, 0], [100, 0, 10, 0]),
        codex_tc(
            "2026-10-27T09:05:00.000Z",
            [200, 100, 20, 0],
            [300, 100, 30, 0],
        ),
    ];
    // The fork replays the parent's token history at fork time, then works on.
    let child = vec![
        codex_meta("child", "/w", Some("parent")),
        codex_turn("gpt-5"),
        codex_tc("2026-10-27T11:00:00.000Z", [100, 0, 10, 0], [100, 0, 10, 0]),
        codex_tc(
            "2026-10-27T11:00:00.002Z",
            [200, 100, 20, 0],
            [300, 100, 30, 0],
        ),
        codex_tc(
            "2026-10-27T11:00:30.000Z",
            [400, 300, 40, 0],
            [700, 400, 70, 0],
        ),
    ];
    // A fork of the fork resolves to the same lineage root.
    let grandchild = vec![
        codex_meta("grandchild", "/w", Some("child")),
        codex_tc("2026-10-27T12:00:00.000Z", [100, 0, 10, 0], [100, 0, 10, 0]),
        codex_tc(
            "2026-10-27T12:00:00.001Z",
            [400, 300, 40, 0],
            [700, 400, 70, 0],
        ),
    ];
    let mut events = feed_with(Engine::Codex, "rollout-1-parent.jsonl", &parent, &mut ctx);
    events.extend(feed_with(
        Engine::Codex,
        "rollout-2-child.jsonl",
        &child,
        &mut ctx,
    ));
    events.extend(feed_with(
        Engine::Codex,
        "rollout-3-grandchild.jsonl",
        &grandchild,
        &mut ctx,
    ));
    assert_eq!(ctx.codex_root("grandchild"), "parent");
    let conn = store_all(&scratch, &events);
    assert_eq!(
        store::event_count(&conn),
        3,
        "two replayed + one genuine child turn"
    );
    let replay_ts: i64 = conn
        .query_row("SELECT MIN(ts_ms) FROM events", [], |r| r.get(0))
        .unwrap();
    assert_eq!(
        Some(replay_ts),
        parse_iso_ms("2026-10-27T09:00:00.000Z"),
        "parent time wins"
    );
}

#[test]
fn codex_state_survives_an_incremental_boundary() {
    let mut ctx = ParseCtx::default();
    let mut first = FileParser::new(Engine::Codex, "rollout-a.jsonl", None);
    let mut out = Vec::new();
    for line in [codex_meta("sess-s", "/w", None), codex_turn("gpt-5-codex")] {
        first.feed(line.as_bytes(), &mut ctx, &mut out);
    }
    let state = first.state_json().unwrap();
    let mut resumed = FileParser::new(Engine::Codex, "rollout-a.jsonl", Some(&state));
    for line in [
        r#"{"timestamp":"2026-10-27T10:00:02Z","type":"event_msg","payload":{"type":"model_rerouted","from_model":"gpt-5-codex","to_model":"gpt-5"}}"#.to_string(),
        codex_tc("2026-10-27T10:00:05.000Z", [10, 0, 1, 0], [10, 0, 1, 0]),
    ] {
        resumed.feed(line.as_bytes(), &mut ctx, &mut out);
    }
    assert_eq!(out.len(), 1);
    assert_eq!(out[0].model, "gpt-5");
    assert_eq!(out[0].session_id.as_deref(), Some("sess-s"));
}

// ── pi / omp ────────────────────────────────────────────────────────────────

#[test]
fn pi_family_reads_header_and_assistant_usage() {
    let lines = vec![
        r#"{"type":"title","v":1,"title":"t"}"#.to_string(),
        pi_header("sess-p", "/work/pi"),
        r#"{"type":"message","id":"u1","message":{"role":"user","content":"usage?"}}"#.to_string(),
        pi_assistant(
            "a1",
            1_792_903_848_255,
            Some("resp-1"),
            "deepseek-v4-flash",
            [909, 324, 8704, 0],
        ),
        pi_assistant(
            "a2",
            1_792_903_849_733,
            None,
            "deepseek-v4-flash",
            [0, 0, 0, 0],
        ),
    ];
    for engine in [Engine::Pi, Engine::Omp] {
        let events = feed(engine, "s.jsonl", &lines);
        assert_eq!(events.len(), 1, "user and zero-usage entries are skipped");
        let event = &events[0];
        assert_eq!(event.engine, engine.id());
        assert_eq!(event.key, format!("{}:1792903848255:resp-1", engine.id()));
        assert_eq!(event.ts_ms, 1_792_903_848_255);
        assert_eq!(
            event.tokens,
            Tokens {
                input: 909,
                output: 324,
                cache_read: 8704,
                cache_write: 0,
                reasoning: 7
            }
        );
        assert_eq!(event.project.as_deref(), Some("/work/pi"));
        assert_eq!(event.session_id.as_deref(), Some("sess-p"));
    }
}

#[test]
fn pi_forked_copy_shares_keys_with_the_original() {
    let entry = pi_assistant("a1", 1_792_903_848_255, None, "k3.1-pro", [1, 2, 3, 0]);
    let original = feed(
        Engine::Pi,
        "a.jsonl",
        &[pi_header("one", "/w"), entry.clone()],
    );
    let fork = feed(Engine::Pi, "b.jsonl", &[pi_header("two", "/w"), entry]);
    assert_eq!(original[0].key, fork[0].key);
    assert_eq!(
        original[0].key, "pi:1792903848255:a1",
        "entry id when no responseId"
    );
}

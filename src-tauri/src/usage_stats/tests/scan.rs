use super::*;
use crate::usage_stats::scan::{self, ScanMode, ScanProgress};
use crate::usage_stats::sources;
use crate::usage_stats::store;
use crate::usage_stats::types::ScanSummary;

fn run(
    conn: &mut rusqlite::Connection,
    specs: &[SourceSpec],
    mode: ScanMode,
) -> (ScanSummary, Vec<ScanProgress>) {
    let mut progress = Vec::new();
    let summary = scan::run(conn, specs, mode, &mut |p| progress.push(p.clone())).unwrap();
    (summary, progress)
}

fn output_of(conn: &rusqlite::Connection, key: &str) -> i64 {
    conn.query_row("SELECT output FROM events WHERE key = ?1", [key], |r| {
        r.get(0)
    })
    .unwrap()
}

/// A first line longer than the head hash window, so in-place edits further
/// down do not look like a replaced file.
fn padding_line() -> String {
    serde_json::json!({"type": "summary", "summary": "p".repeat(1500)}).to_string()
}

#[test]
fn incremental_scan_reads_only_appended_bytes() {
    let scratch = Scratch::new("scan-append");
    let root = scratch.path("projects");
    let file = root.join("p/s.jsonl");
    let line_a = claude_line(
        "msg_a",
        "r",
        "2026-10-26T08:00:00Z",
        "claude-x",
        [1, 111, 0, 0],
    );
    write_lines(&file, &[padding_line(), line_a.clone()]);
    let specs = [spec(Engine::Claude, &root)];
    let mut conn = scratch.db();

    let (first, _) = run(&mut conn, &specs, ScanMode::Incremental);
    assert_eq!((first.files_scanned, first.events_added), (1, 1));

    // Rewrite A in place (same length, beyond the head window) and append B.
    // Reading only the appended bytes means A keeps its first value.
    let edited = line_a.replace("111", "999");
    let line_b = claude_line(
        "msg_b",
        "r",
        "2026-10-26T08:01:00Z",
        "claude-x",
        [1, 222, 0, 0],
    );
    write_lines(&file, &[padding_line(), edited, line_b]);
    let (second, _) = run(&mut conn, &specs, ScanMode::Incremental);
    assert_eq!((second.files_scanned, second.events_added), (1, 1));
    assert_eq!(output_of(&conn, "claude:msg_a:r"), 111);
    assert_eq!(output_of(&conn, "claude:msg_b:r"), 222);

    let (third, _) = run(&mut conn, &specs, ScanMode::Incremental);
    assert_eq!(
        (third.files_scanned, third.events_added),
        (0, 0),
        "unchanged file is not reopened"
    );
    let cursor = store::cursors_for(&conn, "claude").unwrap();
    let cursor = cursor.values().next().unwrap();
    assert_eq!(
        cursor.offset,
        std::fs::metadata(&file).unwrap().len() as i64
    );
}

#[test]
fn shrunk_or_replaced_file_is_reread_without_double_counting() {
    let scratch = Scratch::new("scan-truncate");
    let root = scratch.path("projects");
    let file = root.join("p/s.jsonl");
    let line_a = claude_line(
        "msg_a",
        "r",
        "2026-10-26T08:00:00Z",
        "claude-x",
        [1, 10, 0, 0],
    );
    let line_b = claude_line(
        "msg_b",
        "r",
        "2026-10-26T08:01:00Z",
        "claude-x",
        [1, 20, 0, 0],
    );
    write_lines(&file, &[line_a.clone(), line_b]);
    let specs = [spec(Engine::Claude, &root)];
    let mut conn = scratch.db();
    run(&mut conn, &specs, ScanMode::Incremental);

    // Shrunk: re-read from 0; A upserts onto itself, B's history stays.
    write_lines(&file, &[line_a]);
    let (summary, _) = run(&mut conn, &specs, ScanMode::Incremental);
    assert_eq!((summary.files_scanned, summary.events_added), (1, 0));
    assert_eq!(store::event_count(&conn), 2);

    // Replaced by a different, longer file: head hash differs → from 0.
    let line_c = claude_line(
        "msg_c",
        "r",
        "2026-10-26T09:00:00Z",
        "claude-x",
        [1, 30, 0, 0],
    );
    let line_d = claude_line(
        "msg_d",
        "r",
        "2026-10-26T09:01:00Z",
        "claude-x",
        [1, 40, 0, 0],
    );
    write_lines(&file, &[line_c, line_d.clone(), line_d]);
    let (summary, _) = run(&mut conn, &specs, ScanMode::Incremental);
    assert_eq!(summary.events_added, 2);
    assert_eq!(store::event_count(&conn), 4);
}

#[test]
fn unterminated_tail_waits_until_the_line_is_complete() {
    let scratch = Scratch::new("scan-partial");
    let root = scratch.path("sessions");
    let file = root.join("2026/10/27/rollout-2026-10-27T10-00-00-abc.jsonl");
    let tc = codex_tc(
        "2026-10-27T10:00:09.000Z",
        [150, 100, 5, 0],
        [250, 100, 15, 0],
    );
    let (head, tail) = tc.split_at(tc.len() / 2);
    write_lines(
        &file,
        &[
            codex_meta("abc", "/w", None),
            codex_turn("gpt-5"),
            codex_tc("2026-10-27T10:00:05.000Z", [100, 0, 10, 0], [100, 0, 10, 0]),
        ],
    );
    append_text(&file, head);
    let specs = [spec(Engine::Codex, &root)];
    let mut conn = scratch.db();
    let (first, _) = run(&mut conn, &specs, ScanMode::Incremental);
    assert_eq!(first.events_added, 1);
    let len = std::fs::metadata(&file).unwrap().len() as i64;
    let cursors = store::cursors_for(&conn, "codex").unwrap();
    assert_eq!(
        cursors.values().next().unwrap().offset,
        len - head.len() as i64
    );

    append_text(&file, &format!("{tail}\n"));
    let (second, _) = run(&mut conn, &specs, ScanMode::Incremental);
    assert_eq!(
        second.events_added, 1,
        "the completed line is read once, with carried model state"
    );
    let model: String = conn
        .query_row(
            "SELECT model FROM events ORDER BY ts_ms DESC LIMIT 1",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(model, "gpt-5");
}

#[test]
fn full_rescan_rereads_logs_and_keeps_history_of_deleted_ones() {
    let scratch = Scratch::new("scan-full");
    let root = scratch.path("sessions");
    let keep = root.join("--w--/a.jsonl");
    let gone = root.join("--w--/b.jsonl");
    write_lines(
        &keep,
        &[
            pi_header("a", "/w"),
            pi_assistant("e1", 1_792_903_848_255, None, "m", [1, 1, 0, 0]),
        ],
    );
    write_lines(
        &gone,
        &[
            pi_header("b", "/w"),
            pi_assistant("e2", 1_792_903_848_999, None, "m", [1, 1, 0, 0]),
        ],
    );
    let specs = [spec(Engine::Omp, &root)];
    let mut conn = scratch.db();
    run(&mut conn, &specs, ScanMode::Incremental);
    std::fs::remove_file(&gone).unwrap();

    let (incremental, _) = run(&mut conn, &specs, ScanMode::Incremental);
    assert_eq!(incremental.events_added, 0);
    assert_eq!(store::event_count(&conn), 2, "usage outlives deleted logs");
    assert_eq!(
        store::cursors_for(&conn, "omp").unwrap().len(),
        1,
        "stale cursor pruned"
    );

    let (full, progress) = run(&mut conn, &specs, ScanMode::Full);
    assert_eq!(full.files_scanned, 1, "every log on disk is read again");
    assert!(full.events_added <= 1, "re-read events upsert onto their keys");
    assert_eq!(
        store::event_count(&conn),
        2,
        "a full rescan must not drop usage whose log the CLI already deleted"
    );
    let last = progress.last().unwrap();
    assert!(last.finished);
    assert_eq!((last.done, last.total), (1, 1));
    assert!(!progress[..progress.len() - 1].iter().any(|p| p.finished));
}

#[test]
fn scan_reports_progress_per_engine() {
    let scratch = Scratch::new("scan-progress");
    let claude_root = scratch.path("claude");
    let pi_root = scratch.path("pi");
    write_lines(
        &claude_root.join("p/a.jsonl"),
        &[claude_line(
            "m",
            "r",
            "2026-10-26T08:00:00Z",
            "c",
            [1, 1, 0, 0],
        )],
    );
    write_lines(&pi_root.join("w/a.jsonl"), &[pi_header("s", "/w")]);
    write_lines(&pi_root.join("w/b.jsonl"), &[pi_header("t", "/w")]);
    let specs = [
        spec(Engine::Claude, &claude_root),
        spec(Engine::Pi, &pi_root),
    ];
    let mut conn = scratch.db();
    let (_, progress) = run(&mut conn, &specs, ScanMode::Incremental);
    let engines: Vec<(&str, i64)> = progress
        .iter()
        .map(|p| (p.engine.as_str(), p.done))
        .collect();
    assert_eq!(
        engines,
        [
            ("claude", 0),
            ("claude", 1),
            ("pi", 2),
            ("pi", 3),
            ("pi", 3)
        ]
    );
    assert!(progress.iter().all(|p| p.total == 3));
}

#[cfg(unix)]
#[test]
fn nothing_outside_the_source_roots_is_read() {
    use std::os::unix::fs::symlink;
    let scratch = Scratch::new("scan-safety");
    let root = scratch.path("projects");
    let outside = scratch.path("outside");
    let usage = |id: &str| claude_line(id, "r", "2026-10-26T08:00:00Z", "claude-x", [1, 1, 0, 0]);
    write_lines(&outside.join("secret.jsonl"), &[usage("outside_file")]);
    write_lines(&outside.join("dir/nested.jsonl"), &[usage("outside_dir")]);
    write_lines(&root.join("p/real.jsonl"), &[usage("inside")]);
    write_lines(&root.join("p/notes.txt"), &[usage("wrong_extension")]);
    symlink(outside.join("secret.jsonl"), root.join("p/link.jsonl")).unwrap();
    symlink(outside.join("dir"), root.join("linked-dir")).unwrap();

    let found = sources::discover(&spec(Engine::Claude, &root));
    let paths: Vec<_> = found.files.iter().map(|f| f.path.clone()).collect();
    assert_eq!(paths, [root.join("p/real.jsonl")]);

    let mut conn = scratch.db();
    run(
        &mut conn,
        &[spec(Engine::Claude, &root)],
        ScanMode::Incremental,
    );
    let keys: Vec<String> = conn
        .prepare("SELECT key FROM events")
        .unwrap()
        .query_map([], |r| r.get(0))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    assert_eq!(keys, ["claude:inside:r"]);
}

#[test]
fn codex_accepts_only_rollout_files_and_reads_parents_first() {
    let scratch = Scratch::new("scan-codex-names");
    let root = scratch.path("sessions");
    let archived = scratch.path("archived_sessions");
    write_lines(
        &root.join("2026/10/27/rollout-2026-10-27T11-00-00-child.jsonl"),
        &[codex_meta("child", "/w", Some("parent"))],
    );
    write_lines(
        &archived.join("rollout-2026-10-27T09-00-00-parent.jsonl"),
        &[codex_meta("parent", "/w", None)],
    );
    write_lines(
        &root.join("2026/10/27/history.jsonl"),
        &[codex_meta("other", "/w", None)],
    );
    let found = sources::discover(&SourceSpec {
        engine: Engine::Codex,
        roots: vec![root.clone(), archived.clone()],
    });
    let names: Vec<String> = found
        .files
        .iter()
        .map(|f| f.path.file_name().unwrap().to_string_lossy().into_owned())
        .collect();
    assert_eq!(
        names,
        [
            "rollout-2026-10-27T09-00-00-parent.jsonl",
            "rollout-2026-10-27T11-00-00-child.jsonl"
        ]
    );
}

#[test]
fn readers_keep_old_numbers_while_a_rebuild_is_open() {
    let scratch = Scratch::new("scan-reader");
    let root = scratch.path("projects");
    write_lines(
        &root.join("p/a.jsonl"),
        &[claude_line(
            "m",
            "r",
            "2026-10-26T08:00:00Z",
            "c",
            [1, 1, 0, 0],
        )],
    );
    let mut writer = scratch.db();
    run(
        &mut writer,
        &[spec(Engine::Claude, &root)],
        ScanMode::Incremental,
    );

    // What a full rescan does first: reset cursors inside one open write
    // transaction.
    writer.execute_batch("BEGIN IMMEDIATE").unwrap();
    store::reset_cursors(&writer).unwrap();
    let reader = scratch.db();
    let from = crate::usage_stats::time::parse_iso_ms("2026-10-26T00:00:00Z").unwrap();
    let rows = store::aggregate(&reader, from, from + 86_400_000, false, 0).unwrap();
    assert_eq!(
        rows.len(),
        1,
        "opening + querying neither blocks nor loses rows"
    );
    writer.execute_batch("ROLLBACK").unwrap();
}

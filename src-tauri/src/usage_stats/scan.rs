//! Incremental log reader: for every discovered file, read only the bytes
//! appended since the stored cursor (from 0 when the file shrank or its head
//! changed), stream complete lines through the engine parser and upsert the
//! events together with the new cursor in one savepoint.

use super::parsers::{FileParser, ParseCtx};
use super::sources::{discover, FoundFile, SourceSpec};
use super::store::{self, Cursor};
use super::time::now_ms;
use super::types::{Engine, ScanSummary, UsageEvent};
use rusqlite::Connection;
use serde::Serialize;
use std::fs::File;
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};

/// Bytes hashed at the head of a file to notice it was replaced.
const HEAD_BYTES: i64 = 1024;
/// A single JSONL line larger than this is skipped (never buffered whole).
const MAX_LINE_BYTES: usize = 64 * 1024 * 1024;
const READ_BUFFER: usize = 256 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ScanMode {
    Incremental,
    /// Wipe everything and rebuild from the logs (one transaction, so
    /// readers keep the old numbers until the rebuild commits).
    Full,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ScanProgress {
    pub done: i64,
    pub total: i64,
    pub engine: String,
    pub finished: bool,
}

#[derive(Debug, Default)]
struct FileOutcome {
    read: bool,
    changed: i64,
}

pub(crate) fn run(
    conn: &mut Connection,
    specs: &[SourceSpec],
    mode: ScanMode,
    progress: &mut dyn FnMut(&ScanProgress),
) -> Result<ScanSummary, String> {
    let started = now_ms();
    let full = mode == ScanMode::Full;
    if full {
        conn.execute_batch("BEGIN IMMEDIATE")
            .and_then(|_| store::reset_cursors(conn))
            .map_err(|e| format!("start rebuild: {e}"))?;
    }
    let result = scan_all(conn, specs, progress);
    if full {
        let end = if result.is_ok() { "COMMIT" } else { "ROLLBACK" };
        conn.execute_batch(end)
            .map_err(|e| format!("finish rebuild: {e}"))?;
    }
    let (files_scanned, events_added) = result?;
    let scanned_at = now_ms();
    Ok(ScanSummary {
        files_scanned,
        events_added,
        duration_ms: scanned_at - started,
        scanned_at,
    })
}

fn scan_all(
    conn: &mut Connection,
    specs: &[SourceSpec],
    progress: &mut dyn FnMut(&ScanProgress),
) -> Result<(i64, i64), String> {
    let discoveries: Vec<_> = specs
        .iter()
        .map(|spec| (spec.engine, discover(spec)))
        .collect();
    let total: i64 = discoveries.iter().map(|(_, d)| d.files.len() as i64).sum();
    let mut ctx = ParseCtx {
        codex_roots: store::load_lineage(conn).map_err(|e| format!("load lineage: {e}"))?,
        ..ParseCtx::default()
    };
    let first_engine = specs.first().map(|s| s.engine.id()).unwrap_or_default();
    let mut report = |done: i64, engine: &str, finished: bool| {
        progress(&ScanProgress {
            done,
            total,
            engine: engine.to_string(),
            finished,
        })
    };
    report(0, first_engine, false);
    let (mut done, mut files_read, mut changed) = (0i64, 0i64, 0i64);
    for (engine, discovery) in &discoveries {
        let id = engine.id();
        let cursors = store::cursors_for(conn, id).map_err(|e| format!("load cursors: {e}"))?;
        let mut seen = Vec::with_capacity(discovery.files.len());
        for found in &discovery.files {
            let key = found.path.to_string_lossy().into_owned();
            match process_file(conn, &mut ctx, *engine, found, cursors.get(&key)) {
                Ok(outcome) => {
                    files_read += i64::from(outcome.read);
                    changed += outcome.changed;
                }
                // Path only: never log file contents.
                Err(error) => eprintln!("[usage-stats] {id} {}: {error}", found.path.display()),
            }
            seen.push(key);
            done += 1;
            report(done, id, false);
        }
        // A root that failed to list must not drop the cursors of its files.
        if discovery.complete() {
            store::prune_cursors(conn, id, &seen).map_err(|e| format!("{id} prune: {e}"))?;
        }
        store::set_meta(conn, &format!("last_scan_at:{id}"), &now_ms().to_string())
            .map_err(|e| format!("{id} scan time: {e}"))?;
    }
    store::set_meta(conn, "last_scan_at", &now_ms().to_string())
        .map_err(|e| format!("save scan time: {e}"))?;
    report(
        total,
        specs.last().map(|s| s.engine.id()).unwrap_or_default(),
        true,
    );
    Ok((files_read, changed))
}

fn process_file(
    conn: &mut Connection,
    ctx: &mut ParseCtx,
    engine: Engine,
    found: &FoundFile,
    previous: Option<&Cursor>,
) -> Result<FileOutcome, String> {
    // Defense in depth: discovery only yields regular files under the root,
    // but the file may have been swapped for a symlink since.
    if !found.path.starts_with(&found.root) {
        return Err("outside its source root".to_string());
    }
    let meta = std::fs::symlink_metadata(&found.path).map_err(|e| e.to_string())?;
    if !meta.is_file() {
        return Ok(FileOutcome::default());
    }
    let len = meta.len() as i64;
    let mtime = mtime_ms(&meta);
    if previous.is_some_and(|c| c.size == len && c.mtime_ms == mtime && c.offset <= len) {
        return Ok(FileOutcome::default());
    }
    let mut file = File::open(&found.path).map_err(|e| e.to_string())?;
    let resume = match previous {
        Some(c)
            if c.offset <= len
                && hash_head(&mut file, c.head_len)?.as_deref() == Some(c.head_hash.as_str()) =>
        {
            Some((c.offset, c.state.clone()))
        }
        _ => None,
    };
    let (start, state) = resume.unwrap_or((0, None));
    let head_len = len.min(HEAD_BYTES);
    let head_hash = hash_head(&mut file, head_len)?.unwrap_or_default();
    let file_name = found
        .path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or_default();
    let mut parser = FileParser::new(engine, file_name, state.as_deref());
    let mut events = Vec::new();
    ctx.new_lineage.clear();
    let offset = read_lines(&mut file, start, len, &mut parser, ctx, &mut events)
        .map_err(|e| format!("read: {e}"))?;
    let cursor = Cursor {
        path: found.path.to_string_lossy().into_owned(),
        engine: engine.id().to_string(),
        size: len,
        mtime_ms: mtime,
        offset,
        head_len,
        head_hash,
        state: parser.state_json(),
    };
    let changed =
        persist(conn, &events, &ctx.new_lineage, &cursor).map_err(|e| format!("store: {e}"))?;
    ctx.new_lineage.clear();
    Ok(FileOutcome {
        read: true,
        changed,
    })
}

/// Events, lineage and cursor commit together: the cursor never advances
/// past events that were not stored.
fn persist(
    conn: &mut Connection,
    events: &[UsageEvent],
    lineage: &[(String, String)],
    cursor: &Cursor,
) -> rusqlite::Result<i64> {
    let savepoint = conn.savepoint()?;
    let mut changed = 0;
    for event in events {
        changed += i64::from(store::upsert_event(&savepoint, event)?);
    }
    store::save_lineage(&savepoint, lineage)?;
    store::save_cursor(&savepoint, cursor)?;
    savepoint.commit()?;
    Ok(changed)
}

enum LineRead {
    Eof,
    Line { consumed: usize, terminated: bool },
    Oversized { consumed: usize, terminated: bool },
}

/// Read `[start, len)` line by line; returns the offset after the last
/// line consumed. An unterminated tail is consumed only if it is already a
/// complete JSON value — otherwise the writer is mid-line and the next scan
/// picks it up whole.
fn read_lines(
    file: &mut File,
    start: i64,
    len: i64,
    parser: &mut FileParser,
    ctx: &mut ParseCtx,
    out: &mut Vec<UsageEvent>,
) -> std::io::Result<i64> {
    file.seek(SeekFrom::Start(start as u64))?;
    let limit = (len - start).max(0) as u64;
    let mut reader = BufReader::with_capacity(READ_BUFFER, Read::by_ref(file).take(limit));
    let mut offset = start;
    let mut buf = Vec::new();
    loop {
        buf.clear();
        match read_line_capped(&mut reader, &mut buf)? {
            LineRead::Eof => break,
            LineRead::Oversized {
                consumed,
                terminated,
            } => {
                if !terminated {
                    break;
                }
                offset += consumed as i64;
            }
            LineRead::Line {
                consumed,
                terminated,
            } => {
                let line = trim_eol(&buf);
                if !terminated && serde_json::from_slice::<serde::de::IgnoredAny>(line).is_err() {
                    break;
                }
                offset += consumed as i64;
                if !line.is_empty() && parser.wants(line) {
                    parser.feed(line, ctx, out);
                }
            }
        }
    }
    Ok(offset)
}

fn read_line_capped<R: BufRead>(reader: &mut R, buf: &mut Vec<u8>) -> std::io::Result<LineRead> {
    let mut consumed = 0usize;
    let mut oversized = false;
    loop {
        let available = reader.fill_buf()?;
        if available.is_empty() {
            return Ok(match (consumed, oversized) {
                (0, _) => LineRead::Eof,
                (_, true) => LineRead::Oversized {
                    consumed,
                    terminated: false,
                },
                (_, false) => LineRead::Line {
                    consumed,
                    terminated: false,
                },
            });
        }
        let newline = available.iter().position(|&b| b == b'\n');
        let take = newline.map_or(available.len(), |i| i + 1);
        if !oversized {
            if buf.len() + take > MAX_LINE_BYTES {
                oversized = true;
                buf.clear();
            } else {
                buf.extend_from_slice(&available[..take]);
            }
        }
        reader.consume(take);
        consumed += take;
        if newline.is_some() {
            return Ok(if oversized {
                LineRead::Oversized {
                    consumed,
                    terminated: true,
                }
            } else {
                LineRead::Line {
                    consumed,
                    terminated: true,
                }
            });
        }
    }
}

fn trim_eol(line: &[u8]) -> &[u8] {
    let mut end = line.len();
    while end > 0 && matches!(line[end - 1], b'\n' | b'\r') {
        end -= 1;
    }
    &line[..end]
}

/// Hash of the first `len` bytes; None when the file is now shorter.
fn hash_head(file: &mut File, len: i64) -> Result<Option<String>, String> {
    use sha2::{Digest, Sha256};
    let len = usize::try_from(len.clamp(0, HEAD_BYTES)).unwrap_or(0);
    let mut head = vec![0u8; len];
    file.seek(SeekFrom::Start(0)).map_err(|e| e.to_string())?;
    match file.read_exact(&mut head) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(e) => return Err(e.to_string()),
    }
    let digest = Sha256::digest(&head);
    Ok(Some(
        digest[..16].iter().map(|b| format!("{b:02x}")).collect(),
    ))
}

fn mtime_ms(meta: &std::fs::Metadata) -> i64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

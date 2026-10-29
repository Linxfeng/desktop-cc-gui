//! Codex adapter probe: drives the REAL send_message + run_reader pipeline
//! (tokio select + 500ms usage-tail poll) against a fake `codex` CLI that
//! speaks the app-server JSON-RPC handshake (`initialize` -> `thread/start` ->
//! `turn/start` -> notifications), which is the transport the codex adapter
//! actually uses. Checks the turn always settles with a `done` event -
//! including when the final agent_message is a very long line that spans
//! multiple pipe reads (the select tick can land mid-line).
//!
//! The fake CLI is placed in `%APPDATA%\npm`, the FIRST extra search path
//! `resolve::find_cli_binary` probes on Windows (before PATH), so the real
//! codex install is never consulted. APPDATA/USERPROFILE/LOCALAPPDATA are
//! redirected into the temp home so no real user state is touched.
//!
//! No Tauri app is built: the state is constructed directly and the sink
//! writes into a capturing `Emit`. `tauri::test::mock_builder` links the GUI
//! crates into the test exe, which then fails to load on Windows without a
//! comctl32 v6 manifest (0xc0000139) - the app exe gets one from tauri-build,
//! a bare `cargo test` binary does not.
//!
//! Windows-only: the fake CLI is a .cmd shim resolved via the %APPDATA%\npm
//! probe path, which does not exist on unix — there the real codex install
//! would be spawned instead. The whole target is gated accordingly.
#![cfg(target_os = "windows")]

use ccgui_next_lib::db::Db;
use ccgui_next_lib::engine::{self, ProcessRegistry};
use ccgui_next_lib::event_sink::{BroadcastEmit, Emit, EventSink, ENGINE_EVENT_NAME};
use ccgui_next_lib::AppState;
use serde_json::Value;
use std::sync::{Arc, Mutex};

static ENV_LOCK: Mutex<()> = Mutex::new(());

/// Collects the batched `engine://event` payloads the reader emits.
struct Capture(Mutex<Vec<Value>>);

impl Emit for Capture {
    fn emit_json(&self, name: &str, raw_json: &str) {
        if name != ENGINE_EVENT_NAME {
            return;
        }
        if let Ok(batch) = serde_json::from_str::<Vec<Value>>(raw_json) {
            self.0.lock().unwrap().extend(batch);
        }
    }
}

fn temp_home(tag: &str) -> std::path::PathBuf {
    let dir =
        std::env::temp_dir().join(format!("ccgui-codex-probe-{}-{}", tag, std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

/// Redirect the known-folder env vars so Windows extra search paths and the
/// npm-prefix probe all resolve inside `home` (the fake codex.cmd then wins
/// the binary resolution). Restores nothing - each test uses its own temp
/// home and the guard is process-lifetime anyway.
fn redirect_env(home: &std::path::Path) {
    std::env::set_var("HOME", home);
    std::env::set_var("APPDATA", home.join("appdata"));
    std::env::set_var("USERPROFILE", home.join("profile"));
    std::env::set_var("LOCALAPPDATA", home.join("localappdata"));
    ccgui_next_lib::engine::resolve::clear_search_paths_cache();
}

/// Fake codex CLI: `%APPDATA%\npm\codex.cmd` running a Node script that
/// answers the app-server JSON-RPC handshake and then streams the turn.
/// The scenario comes from `CODEX_PROBE_SCENARIO`:
/// - `normal` / `long`: `initialize` -> `thread/start` -> `turn/start`, then
///   one `item/completed` (agentMessage) and `turn/completed`. In `long` the
///   notification line is ~400KB written in small chunks with delays, so the
///   reader's 500ms poll tick lands mid-line.
/// - `early-error`: the thread request is answered by a `turn/failed`
///   notification carrying the error and no thread id, so the run keeps the
///   client's own run id and never gets a session id.
fn write_fake_codex(home: &std::path::Path) {
    let bin_dir = home.join("appdata").join("npm");
    std::fs::create_dir_all(&bin_dir).unwrap();
    let cmd = bin_dir.join("codex.cmd");
    std::fs::write(&cmd, "@echo off\r\nnode \"%~dp0fake-codex.js\" %*\r\n").unwrap();
    let js = bin_dir.join("fake-codex.js");
    std::fs::write(
        &js,
        r#"const process = require("process");
const scenario = process.env.CODEX_PROBE_SCENARIO || "normal";
const THREAD_ID = "thread-probe-1";
let buffered = "";

// App-server framing: one JSON-RPC object per line on stdout.
const send = (value) => process.stdout.write(JSON.stringify(value) + "\n");
const reply = (id, result) => send({ jsonrpc: "2.0", id, result });
const notify = (method, params) => send({ jsonrpc: "2.0", method, params });

const finishTurn = () => {
  notify("turn/completed", {
    threadId: THREAD_ID,
    turn: { id: "turn-probe-1", status: "completed" },
  });
  setTimeout(() => process.exit(0), 50);
};

const emitAgentMessage = (text) => {
  notify("item/completed", {
    threadId: THREAD_ID,
    item: { id: "item_1", type: "agentMessage", text },
  });
};

const streamLongMessage = () => {
  const body = "LONG-ANSWER-START|" + "x".repeat(400 * 1024) + "|LONG-ANSWER-END";
  const line = JSON.stringify({
    jsonrpc: "2.0",
    method: "item/completed",
    params: {
      threadId: THREAD_ID,
      item: { id: "item_1", type: "agentMessage", text: body },
    },
  });
  const step = 8192;
  let offset = 0;
  const writeNext = () => {
    if (offset < line.length) {
      process.stdout.write(line.slice(offset, offset + step));
      offset += step;
      setTimeout(writeNext, 8);
    } else {
      process.stdout.write("\n");
      finishTurn();
    }
  };
  writeNext();
};

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffered += chunk;
  let newline;
  while ((newline = buffered.indexOf("\n")) >= 0) {
    const line = buffered.slice(0, newline).trim();
    buffered = buffered.slice(newline + 1);
    if (!line) continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      continue;
    }
    const { method, id } = message;
    if (method === "initialize") {
      reply(id, { userAgent: "codex-cli/0.154.0" });
      continue;
    }
    if (method === "thread/start" || method === "thread/resume") {
      if (scenario === "early-error") {
        notify("turn/failed", {
          threadId: null,
          turn: {
            id: "turn-probe-1",
            status: "failed",
            error: { message: "failed before thread started" },
          },
        });
        setTimeout(() => process.exit(0), 20);
        return;
      }
      reply(id, { thread: { id: THREAD_ID } });
      continue;
    }
    if (method === "turn/start") {
      reply(id, { turn: { id: "turn-probe-1" } });
      if (scenario === "long") {
        streamLongMessage();
      } else {
        emitAgentMessage("hello from fake codex");
        finishTurn();
      }
      continue;
    }
    // Any other server request (e.g. a config read): answer it so the client
    // never waits for a reply that would otherwise time out.
    if (id !== undefined) reply(id, {});
  }
});
"#,
    )
    .unwrap();
}

fn build_state(home: &std::path::Path) -> (AppState, Arc<Capture>) {
    ccgui_next_lib::paths::ensure_dirs().unwrap();
    let capture = Arc::new(Capture(Mutex::new(Vec::new())));
    let emitter = Arc::clone(&capture) as Arc<dyn Emit>;
    let sink = EventSink::new(Arc::clone(&emitter));
    let state = AppState {
        db: Arc::new(Db::open_at(&home.join("app.db")).unwrap()),
        sink,
        terminal_sink: EventSink::with_name(
            Arc::clone(&emitter),
            ccgui_next_lib::terminal::TERMINAL_OUTPUT_EVENT,
        ),
        plugin_sink: EventSink::with_name(
            Arc::clone(&emitter),
            ccgui_next_lib::event_sink::PLUGIN_AGENT_EVENT_NAME,
        ),
        mission_sink: EventSink::with_name(
            Arc::clone(&emitter),
            ccgui_next_lib::event_sink::MISSION_AGENT_EVENT_NAME,
        ),
        terminals: ccgui_next_lib::terminal::TerminalRegistry::default(),
        processes: Arc::new(ProcessRegistry::default()),
        emitters: BroadcastEmit::new(emitter),
        web: ccgui_next_lib::web::WebAccessState::default(),
        relay: ccgui_next_lib::relay::RelayState::default(),
        dsh_host: Arc::new(ccgui_next_lib::dsh_host::DshHostState::default()),
        opencode_server: std::sync::Arc::new(
            ccgui_next_lib::engine::opencode_server::OpencodeServerState::default(),
        ),
        worktree_creations: ccgui_next_lib::git_worktree::CreationRegistry::default(),
    };
    (state, capture)
}

async fn send_codex_and_wait(
    state: &AppState,
    events: &Arc<Capture>,
    deadline_ms: u64,
) -> Vec<Value> {
    let workspace = std::env::temp_dir().join(format!("ccgui-codex-ws-{}", std::process::id()));
    std::fs::create_dir_all(&workspace).unwrap();
    let result = engine::send_message_inner(
        state,
        "codex".to_string(),
        workspace.to_string_lossy().to_string(),
        None,
        "hi".to_string(),
        Vec::new(),
        None,
        None,
        None,
        None,
        None,
        None,
        Some("run-client-probe".into()),
        None,
        None,
    )
    .await
    .expect("send_message must succeed");
    assert_eq!(result.run_id, "run-client-probe");

    let deadline = std::time::Instant::now() + std::time::Duration::from_millis(deadline_ms);
    loop {
        let kinds: Vec<String> = events
            .0
            .lock()
            .unwrap()
            .iter()
            .filter_map(|e| e.get("kind").and_then(Value::as_str).map(str::to_string))
            .collect();
        if kinds.iter().any(|k| k == "done") || kinds.iter().any(|k| k == "error") {
            break;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "no done/error within {deadline_ms}ms; kinds={kinds:?}"
        );
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    let collected = events.0.lock().unwrap().clone();
    assert!(collected
        .iter()
        .all(|event| event["runId"] == "run-client-probe"));
    collected
}

fn collected_text(events: &[Value]) -> String {
    events
        .iter()
        .filter(|e| e.get("kind").and_then(Value::as_str) == Some("message"))
        .filter_map(|e| {
            e.get("data")
                .and_then(|d| d.get("text"))
                .and_then(Value::as_str)
        })
        .collect()
}

#[tokio::test]
#[allow(clippy::await_holding_lock)]
async fn codex_error_before_session_id_keeps_the_client_run_id() {
    let _env_guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let home = temp_home("early-error");
    redirect_env(&home);
    write_fake_codex(&home);
    std::env::set_var("CODEX_PROBE_SCENARIO", "early-error");
    let (state, events) = build_state(&home);
    let collected = send_codex_and_wait(&state, &events, 15_000).await;
    let error = collected.iter().find(|e| e["kind"] == "error").unwrap();
    assert!(error["sessionId"].is_null());
    assert_eq!(error["data"], "failed before thread started");
}

#[tokio::test]
#[allow(clippy::await_holding_lock)]
async fn codex_normal_turn_settles_with_done() {
    let _env_guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let home = temp_home("normal");
    redirect_env(&home);
    write_fake_codex(&home);
    std::env::set_var("CODEX_PROBE_SCENARIO", "normal");

    let (state, events) = build_state(&home);
    let collected = send_codex_and_wait(&state, &events, 15_000).await;
    let kinds: Vec<&str> = collected
        .iter()
        .filter_map(|e| e.get("kind").and_then(Value::as_str))
        .collect();
    assert!(
        kinds.contains(&"done"),
        "codex normal turn never settled: {kinds:?}"
    );
    let text = collected_text(&collected);
    assert!(
        text.contains("hello from fake codex"),
        "agent text missing: {text:?}"
    );
    // Registry drains after the run.
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    while state.processes.0.lock().unwrap().len() > 0 {
        assert!(std::time::Instant::now() < deadline, "registry not drained");
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
}

#[tokio::test]
#[allow(clippy::await_holding_lock)]
async fn codex_long_final_message_settles_and_keeps_text() {
    let _env_guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let home = temp_home("long");
    redirect_env(&home);
    write_fake_codex(&home);
    std::env::set_var("CODEX_PROBE_SCENARIO", "long");

    let (state, events) = build_state(&home);
    let collected = send_codex_and_wait(&state, &events, 20_000).await;
    let kinds: Vec<&str> = collected
        .iter()
        .filter_map(|e| e.get("kind").and_then(Value::as_str))
        .collect();
    assert!(
        kinds.contains(&"done"),
        "codex long turn never settled: {kinds:?}"
    );
    let text = collected_text(&collected);
    assert!(
        text.contains("LONG-ANSWER-START") && text.contains("LONG-ANSWER-END"),
        "long agent message corrupted/dropped: len={} head={:?}",
        text.len(),
        &text[..text.len().min(80)]
    );
}

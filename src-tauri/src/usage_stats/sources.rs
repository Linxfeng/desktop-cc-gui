//! Where each CLI keeps its logs, and a read-only walk that lists them.
//! Roots come from the same helpers the history sidebar uses, so
//! CLAUDE_CONFIG_DIR / CODEX_HOME (and the CC GUI codex-home override) apply.

use super::types::{Engine, SourceStatus};
use std::path::{Path, PathBuf};

/// Session logs never sit deeper than this below a root (Claude subagents
/// are `<project>/<session>/subagents/agent-*.jsonl`; omp nests advisors).
const MAX_DEPTH: usize = 8;

#[derive(Debug, Clone)]
pub(crate) struct SourceSpec {
    pub engine: Engine,
    pub roots: Vec<PathBuf>,
}

/// One session log found under a root.
#[derive(Debug, Clone)]
pub(crate) struct FoundFile {
    pub path: PathBuf,
    pub root: PathBuf,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum RootState {
    Ok,
    Missing,
    Denied(String),
    Error(String),
}

#[derive(Debug, Clone)]
pub(crate) struct Discovery {
    pub files: Vec<FoundFile>,
    pub roots: Vec<(PathBuf, RootState)>,
}

impl Discovery {
    /// Every root was walked without error (pruning cursors is then safe).
    pub fn complete(&self) -> bool {
        self.roots
            .iter()
            .all(|(_, state)| matches!(state, RootState::Ok | RootState::Missing))
    }
}

pub(crate) fn default_specs() -> Vec<SourceSpec> {
    Engine::ALL
        .into_iter()
        .map(|engine| SourceSpec {
            engine,
            roots: default_roots(engine),
        })
        .collect()
}

fn default_roots(engine: Engine) -> Vec<PathBuf> {
    match engine {
        Engine::Claude => {
            vec![crate::engine::engine_home(Some("CLAUDE_CONFIG_DIR"), ".claude").join("projects")]
        }
        Engine::Codex => {
            let mut homes = vec![crate::engine::codex_home()];
            // v0.9 managed provider homes kept their own sessions trees; the
            // history sidebar scans them too.
            let legacy = crate::paths::legacy_home().join("codex-provider-homes");
            if let Ok(entries) = std::fs::read_dir(&legacy) {
                let mut extra: Vec<PathBuf> = entries
                    .flatten()
                    .filter(|e| e.file_type().is_ok_and(|t| t.is_dir()))
                    .map(|e| e.path())
                    .collect();
                extra.sort();
                homes.extend(extra);
            }
            homes
                .into_iter()
                .flat_map(|home| [home.join("sessions"), home.join("archived_sessions")])
                .collect()
        }
        Engine::Pi => vec![pi_family_root(".pi")],
        Engine::Omp => vec![pi_family_root(".omp")],
    }
}

fn pi_family_root(home_dir_name: &str) -> PathBuf {
    crate::engine::engine_home(None, home_dir_name)
        .join("agent")
        .join("sessions")
}

/// Walk every root of `spec`. Symlinks are never followed (a link inside a
/// root could point anywhere), only regular files the engine accepts are
/// returned, and nothing is opened — this is readdir only.
pub(crate) fn discover(spec: &SourceSpec) -> Discovery {
    let mut files = Vec::new();
    let mut roots = Vec::new();
    for root in &spec.roots {
        let state = walk_root(spec.engine, root, &mut files);
        roots.push((root.clone(), state));
    }
    if spec.engine == Engine::Codex {
        // Rollout names start with their creation time: parents are read
        // before the forks that replay them.
        files.sort_by(|a, b| {
            a.path
                .file_name()
                .cmp(&b.path.file_name())
                .then(a.path.cmp(&b.path))
        });
    } else {
        files.sort_by(|a, b| a.path.cmp(&b.path));
    }
    Discovery { files, roots }
}

fn walk_root(engine: Engine, root: &Path, out: &mut Vec<FoundFile>) -> RootState {
    let entries = match std::fs::read_dir(root) {
        Ok(entries) => entries,
        Err(e) => return root_error(e),
    };
    // Paths (not open ReadDir handles) on the stack: a wide tree must not
    // hold one file descriptor per pending directory.
    let mut stack: Vec<(PathBuf, usize)> = Vec::new();
    let mut current = Some((entries, 0usize));
    while let Some((entries, depth)) = current.take() {
        for entry in entries.flatten() {
            let Ok(kind) = entry.file_type() else {
                continue;
            };
            let path = entry.path();
            if kind.is_dir() && depth + 1 < MAX_DEPTH {
                stack.push((path, depth + 1));
            } else if kind.is_file()
                && entry
                    .file_name()
                    .to_str()
                    .is_some_and(|name| engine.accepts_file(name))
            {
                out.push(FoundFile {
                    path,
                    root: root.to_path_buf(),
                });
            }
        }
        // An unreadable subdirectory is skipped; only the root decides status.
        while current.is_none() {
            let Some((dir, depth)) = stack.pop() else {
                break;
            };
            current = std::fs::read_dir(&dir).ok().map(|entries| (entries, depth));
        }
    }
    RootState::Ok
}

fn root_error(error: std::io::Error) -> RootState {
    match error.kind() {
        std::io::ErrorKind::NotFound => RootState::Missing,
        std::io::ErrorKind::PermissionDenied => RootState::Denied(error.to_string()),
        // A root that exists but is a file, or an I/O failure.
        _ => RootState::Error(error.to_string()),
    }
}

/// Status line for one source: `ok` if any root is readable, else the
/// most telling failure (denied > error > missing).
pub(crate) fn status_of(
    spec: &SourceSpec,
    discovery: &Discovery,
    last_scan_at: Option<i64>,
) -> SourceStatus {
    let any_ok = discovery.roots.iter().any(|(_, s)| *s == RootState::Ok);
    let denied = discovery.roots.iter().find_map(|(root, s)| match s {
        RootState::Denied(e) => Some(format!("{}: {e}", root.display())),
        _ => None,
    });
    let failed = discovery.roots.iter().find_map(|(root, s)| match s {
        RootState::Error(e) => Some(format!("{}: {e}", root.display())),
        _ => None,
    });
    let (status, error) = if any_ok {
        ("ok", denied.or(failed))
    } else if let Some(denied) = denied {
        ("denied", Some(denied))
    } else if let Some(failed) = failed {
        ("error", Some(failed))
    } else {
        ("missing", None)
    };
    SourceStatus {
        engine: spec.engine.id().to_string(),
        label: spec.engine.label().to_string(),
        roots: spec
            .roots
            .iter()
            .map(|r| r.to_string_lossy().into_owned())
            .collect(),
        env: spec.engine.env().map(str::to_string),
        files: discovery.files.len() as i64,
        status: status.to_string(),
        error,
        last_scan_at,
    }
}

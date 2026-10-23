//! 本机 WSL 工作区的会话发现 —— 在发行版内扫描,不碰 UNC 文件系统。
//!
//! 为什么要单独一套:经 `\\wsl.localhost\…` 列 446 个转录本要 6–8 秒、读到
//! 头部要 10 秒,而同一个 `find` 在发行版内只要 31ms / 672ms(实机 V19、
//! V20)。所以列表走一次 `find -printf`,只对签名(size / mtime)变化的文件
//! 再发一次短调用读头部(标题 / cwd)。
//!
//! 结果复用前端已有的"远程会话行"形态(`remote` + `remotePath`):侧栏打开
//! 与删除都走既有链路,不需要新的前端会话模型。

use serde::Serialize;
use std::collections::HashMap;

use super::claude_encode_project_path;
use crate::engine::{wsl_path, wsl_probe, wsl_transport};

const TAB: char = '\t';

/// 与插件会话源上报的行同形(`src/features/plugins/runtime/session-source.ts`)。
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WslSessionRow {
    pub engine: String,
    pub session_id: String,
    pub workspace_path: String,
    pub title: String,
    pub updated_at: Option<i64>,
    /// 发行版内转录本绝对路径(打开回放 / 删除都靠它)。
    pub remote_path: String,
}

/// 一次扫描里的候选转录本。
#[derive(Debug, Clone, PartialEq)]
pub struct ScannedFile {
    pub engine: String,
    pub path: String,
    pub size: i64,
    pub mtime: f64,
}

/// 列表脚本:一次调用同时给出 claude 与 codex 的候选文件。
///
/// 输出每行 `<engine> TAB <path> TAB <size> TAB <mtime>`。目录在**发行版内**
/// 展开,这样 `$CLAUDE_CONFIG_DIR` / `$CODEX_HOME` 与 CLI 自己看到的配置一致
/// (与本地扫描的 `engine_home` 语义对齐)。缺失目录静默跳过:没装过某个
/// CLI 不会让整次扫描失败。
pub fn list_script(linux_workspace: &str) -> String {
    let encoded = claude_encode_project_path(linux_workspace);
    let sep = TAB;
    format!(
        "cdir=\"${{CLAUDE_CONFIG_DIR:-$HOME/.claude}}/projects/{encoded}\"\n\
xdir=\"${{CODEX_HOME:-$HOME/.codex}}/sessions\"\n\
pdir=\"${{PI_CODING_AGENT_DIR:-$HOME/.pi/agent}}/sessions\"\n\
if [ -d \"$cdir\" ]; then find \"$cdir\" -maxdepth 1 -name '*.jsonl' -printf 'claude{sep}%p{sep}%s{sep}%T@{sep}\n' 2>/dev/null; fi\n\
if [ -d \"$xdir\" ]; then find \"$xdir\" -name '*.jsonl' -printf 'codex{sep}%p{sep}%s{sep}%T@{sep}\n' 2>/dev/null; fi\n\
if [ -d \"$pdir\" ]; then find \"$pdir\" -name '*.jsonl' -printf 'pi{sep}%p{sep}%s{sep}%T@{sep}\n' 2>/dev/null; fi"
    )
}

/// 解析 `find -printf` 输出(四列:engine、path、size、mtime)。畸形行丢弃,
/// 不因为一个坏条目丢掉整份列表。
pub fn parse_find_output(raw: &str) -> Vec<ScannedFile> {
    raw.lines()
        .filter_map(|line| {
            let fields: Vec<&str> = line.trim_end_matches('\r').split(TAB).collect();
            // find 的 -printf 以 TAB 结尾 → 末列是空串。
            if fields.len() != 5 {
                return None;
            }
            let engine = match fields[0] {
                "claude" => "claude",
                "codex" => "codex",
                "pi" => "pi",
                _ => return None,
            };
            let path = fields[1].trim();
            if !path.starts_with('/') || path.contains('\0') {
                return None;
            }
            Some(ScannedFile {
                engine: engine.to_string(),
                path: path.to_string(),
                size: fields[2].trim().parse::<i64>().ok()?,
                mtime: fields[3].trim().parse::<f64>().ok()?,
            })
        })
        .collect()
}

/// 从转录本头部解析标题与 cwd(引擎相关):
/// - Claude:第一条非噪声 user 行的纯文本;
/// - Codex:`session_meta.cwd` 决定归属,标题取首条 user message。
///
/// 头部被 16KB 截断是常态(可能断在 JSON 中间),所以逐行解析、坏行跳过。
pub fn parse_head(engine: &str, head: &str) -> (String, String) {
    let mut title = String::new();
    let mut cwd = String::new();
    for line in head.lines() {
        let Ok(value) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        match engine {
            "codex" => {
                if cwd.is_empty() {
                    if let Some(dir) = value
                        .get("payload")
                        .and_then(|p| p.get("cwd"))
                        .and_then(|v| v.as_str())
                    {
                        cwd = dir.to_string();
                    }
                }
                if title.is_empty() {
                    if let Some(text) = codex_user_text(&value) {
                        title = truncate_title(&text);
                    }
                }
            }
            "pi" => {
                // pi 的会话头在第一行 `{"type":"session","cwd":…}`;
                // 用户消息是 `{"type":"message","message":{"role":"user"…}}`。
                if cwd.is_empty() {
                    if let Some(dir) = value.get("cwd").and_then(|v| v.as_str()) {
                        cwd = dir.to_string();
                    }
                }
                if title.is_empty() {
                    if let Some(text) = pi_user_text(&value) {
                        title = truncate_title(&text);
                    }
                }
            }
            _ => {
                if cwd.is_empty() {
                    if let Some(dir) = value.get("cwd").and_then(|v| v.as_str()) {
                        cwd = dir.to_string();
                    }
                }
                if title.is_empty() {
                    if let Some(text) = claude_user_text(&value) {
                        title = truncate_title(&text);
                    }
                }
            }
        }
        if !title.is_empty() && !cwd.is_empty() {
            break;
        }
    }
    (title, cwd)
}

fn truncate_title(text: &str) -> String {
    let collapsed = text.split_whitespace().collect::<Vec<_>>().join(" ");
    collapsed.chars().take(80).collect()
}

/// Claude:`{"type":"user","message":{"content":"…"|[{type:text,text:…}]}}`。
fn claude_user_text(value: &serde_json::Value) -> Option<String> {
    if value.get("type").and_then(|t| t.as_str()) != Some("user") {
        return None;
    }
    let content = value.get("message")?.get("content")?;
    let text = match content {
        serde_json::Value::String(s) => s.clone(),
        serde_json::Value::Array(parts) => parts
            .iter()
            .filter(|p| p.get("type").and_then(|t| t.as_str()) == Some("text"))
            .filter_map(|p| p.get("text").and_then(|t| t.as_str()))
            .collect::<Vec<_>>()
            .join(""),
        _ => return None,
    };
    let trimmed = text.trim();
    // 注入上下文 / 工具结果不是用户写的标题。
    if trimmed.is_empty() || trimmed.starts_with('<') || trimmed.contains("system-reminder") {
        return None;
    }
    Some(trimmed.to_string())
}

/// Codex rollout:用户消息在 `{"type":"event_msg","payload":{"type":"user_message",…}}`。
fn codex_user_text(value: &serde_json::Value) -> Option<String> {
    let payload = value.get("payload")?;
    let kind = payload.get("type").and_then(|t| t.as_str())?;
    if kind != "user_message" {
        return None;
    }
    let text = payload
        .get("message")
        .or_else(|| payload.get("text"))
        .and_then(|v| v.as_str())?
        .trim();
    if text.is_empty() || text.starts_with('<') {
        return None;
    }
    Some(text.to_string())
}

/// pi 的用户消息:`{"type":"message","message":{"role":"user","content":…}}`。
fn pi_user_text(value: &serde_json::Value) -> Option<String> {
    if value.get("type").and_then(|t| t.as_str()) != Some("message") {
        return None;
    }
    let message = value.get("message")?;
    if message.get("role").and_then(|r| r.as_str()) != Some("user") {
        return None;
    }
    let content = message.get("content")?;
    let text = match content {
        serde_json::Value::String(s) => s.clone(),
        serde_json::Value::Array(parts) => parts
            .iter()
            .filter(|p| p.get("type").and_then(|t| t.as_str()) == Some("text"))
            .filter_map(|p| p.get("text").and_then(|t| t.as_str()))
            .collect::<Vec<_>>()
            .join(""),
        _ => return None,
    };
    let trimmed = text.trim();
    if trimmed.is_empty() || trimmed.starts_with('<') || trimmed.contains("system-reminder") {
        return None;
    }
    Some(trimmed.to_string())
}

/// 转录本是否属于该工作区:Claude 靠目录编码已经筛过(同目录即归属),
/// Codex 靠头部 cwd,缺失 cwd 时保守地不归属(宁缺勿错)。
///
/// 嵌套工作区(`/repo` 与 `/repo/sub`)按**最长前缀唯一归属**:否则同一
/// Codex 会话会在父子两个工作区各出一行,前端行 id 相同,React key 冲突
/// (§10 P1-11 / D6)。
pub fn row_belongs_to_workspace(
    engine: &str,
    owning_cwd: &str,
    workspace: &str,
    siblings: &[String],
) -> bool {
    let current = workspace.trim_end_matches('/');
    let fallback = [current.to_string()];
    let siblings = if siblings.is_empty() {
        &fallback[..]
    } else {
        siblings
    };
    match engine {
        "codex" => owning_workspace(owning_cwd, siblings) == Some(current),
        // Claude / pi 的目录编码会把 `_`/`-` 等折叠成 `-`,`/home/a_b` 与
        // `/home/a-b` 会落到同一项目目录。读到 cwd 后同样按工作区复核;
        // 尚未读头(cwd 为空)时先展示,避免首屏整批消失(§10 D5)。
        "claude" | "pi" => {
            owning_cwd.trim().is_empty()
                || owning_workspace(owning_cwd, siblings) == Some(current)
        }
        _ => true,
    }
}

/// cwd 命中的最长工作区前缀;没有命中返回 None。
fn owning_workspace<'a>(owning_cwd: &str, workspaces: &'a [String]) -> Option<&'a str> {
    let cwd = owning_cwd.trim_end_matches('/');
    if cwd.is_empty() {
        return None;
    }
    workspaces
        .iter()
        .map(|w| w.trim_end_matches('/'))
        .filter(|w| !w.is_empty() && (cwd == *w || cwd.starts_with(&format!("{w}/"))))
        .max_by_key(|w| w.len())
}

/// 缓存签名比较:size 与 mtime 都没变 → 复用缓存里的标题/cwd,不读头部。
pub fn signature_changed(cached: Option<(i64, f64)>, size: i64, mtime: f64) -> bool {
    match cached {
        Some((cached_size, cached_mtime)) => {
            cached_size != size || (cached_mtime - mtime).abs() > 1e-6
        }
        None => true,
    }
}

/// 会话 id:转录文件名去掉 `.jsonl`(与本地扫描的 stem 规则一致)。
pub fn session_id_from_path(path: &str) -> Option<String> {
    let name = path.rsplit('/').next()?;
    let stem = name.strip_suffix(".jsonl")?;
    if stem.is_empty() || stem == "history" {
        return None;
    }
    Some(stem.to_string())
}

/// pi 的文件名是 `<timestamp>_<uuid>.jsonl`;会话 id 是后半段 UUID
/// (`--session <id>` 也只认它),不是整个文件名。
fn session_id_for_path(engine: &str, path: &str) -> Option<String> {
    let stem = session_id_from_path(path)?;
    if engine != "pi" {
        return Some(stem);
    }
    let id = stem.rsplit_once('_').map(|(_, id)| id).unwrap_or(&stem);
    (!id.is_empty()).then(|| id.to_string())
}

/// mtime 秒 → 毫秒时间戳(前端 `updatedAt` 用 ms)。
pub fn mtime_ms(mtime: f64) -> Option<i64> {
    (mtime > 0.0).then(|| (mtime * 1000.0) as i64)
}

/// 扫描结果缓存:distro → (path → (size, mtime, title, cwd))。
/// 与 db 缓存互补:db 跨重启,这份只省同一次运行内的重复头部读取。
pub type HeadCache = HashMap<String, HashMap<String, (i64, f64, String, String)>>;

/// 从一次扫描结果构造会话行。`head_cache` 为已有缓存(签名未变就不读头),
/// 标题为空的行由 [`apply_head`] 在读完头部后补齐。
pub fn build_rows(
    windows_workspace: &str,
    linux_workspace: &str,
    siblings: &[String],
    files: &[ScannedFile],
    head_cache: &mut HashMap<String, (i64, f64, String, String)>,
) -> Vec<WslSessionRow> {
    let mut rows = Vec::new();
    for file in files {
        let Some(session_id) = session_id_for_path(&file.engine, &file.path) else {
            continue;
        };
        let cached = head_cache.get(&file.path).cloned();
        let (title, cwd) = match &cached {
            Some((size, mtime, title, cwd))
                if !signature_changed(Some((*size, *mtime)), file.size, file.mtime) =>
            {
                (title.clone(), cwd.clone())
            }
            // 文件变了但归属没变:先沿用缓存的 cwd,读头失败时 Codex 行
            // 不会整批消失(§10 P1-8)。标题在读头成功后回填。
            Some((_, _, _, cwd)) => (String::new(), cwd.clone()),
            None => (String::new(), String::new()),
        };
        if !row_belongs_to_workspace(&file.engine, &cwd, linux_workspace, siblings) {
            continue;
        }
        rows.push(WslSessionRow {
            engine: file.engine.clone(),
            session_id,
            workspace_path: windows_workspace.to_string(),
            title,
            updated_at: mtime_ms(file.mtime),
            remote_path: file.path.clone(),
        });
    }
    rows
}

/// 把刚读到的头部写回缓存与行(已有标题不覆盖)。
pub fn apply_head(
    cache: &mut HashMap<String, (i64, f64, String, String)>,
    rows: &mut [WslSessionRow],
    file: &ScannedFile,
    title: String,
    cwd: String,
) {
    cache.insert(
        file.path.clone(),
        (file.size, file.mtime, title.clone(), cwd.clone()),
    );
    if title.is_empty() {
        return;
    }
    if let Some(row) = rows.iter_mut().find(|r| r.remote_path == file.path) {
        if row.title.is_empty() {
            row.title = title;
        }
    }
}

/// 需要读头部的文件:未缓存或签名变化。
pub fn needs_head(
    cache: &HashMap<String, (i64, f64, String, String)>,
    file: &ScannedFile,
) -> bool {
    match cache.get(&file.path) {
        Some((size, mtime, _, _)) => signature_changed(Some((*size, *mtime)), file.size, file.mtime),
        None => true,
    }
}

/// 同一发行版内所有本机 WSL 工作区的 Linux 路径(用于最长前缀归属)。
fn sibling_linux_workspaces(db: &crate::db::Db, distro: &str) -> Vec<String> {
    let conn = db.0.lock();
    let Ok(mut stmt) = conn.prepare("SELECT path FROM workspaces") else {
        return Vec::new();
    };
    let Ok(rows) = stmt.query_map([], |r| r.get::<_, String>(0)) else {
        return Vec::new();
    };
    let mut out: Vec<String> = rows
        .flatten()
        .filter_map(|path| wsl_path::parse_wsl_unc(&path))
        .filter(|unc| unc.distro.eq_ignore_ascii_case(distro))
        .map(|unc| unc.linux_path)
        .collect();
    out.sort();
    out.dedup();
    out
}

/// Codex 子代理 rollout 的哨兵 cwd:不可能命中任何工作区,因此行不会出现,
/// 但缓存签名仍保留,下一轮不必重复读头。
const CODEX_SUBAGENT_CWD: &str = "\u{1}subagent";

fn is_codex_subagent_head(head: &str) -> bool {
    head.lines()
        .filter_map(|line| serde_json::from_str::<serde_json::Value>(line).ok())
        .any(|value| {
            value.get("type").and_then(|t| t.as_str()) == Some("session_meta")
                && value
                    .get("payload")
                    .and_then(|p| p.get("source"))
                    .and_then(|s| s.get("subagent"))
                    .is_some_and(|v| v.is_object() || v.as_bool() == Some(true))
        })
}

/// 批量读头脚本:每个文件先打一行 `__HEAD__<path>`,再输出 base64 的头部
/// (`head -c` 截断)。一次短调用覆盖本次全部签名变化的文件(实机 V21:
/// 全量读头 5.3s,增量通常 < 1s)。
pub fn heads_script(paths: &[String], bytes: usize) -> String {
    let mut script = String::new();
    for path in paths {
        let quoted = wsl_transport::sh_quote(path);
        script.push_str(&format!(
            "printf '__HEAD__%s\\n' {quoted}\nhead -c {bytes} -- {quoted} 2>/dev/null | base64 -w0\nprintf '\\n'\n"
        ));
    }
    script
}

/// 解析 [`heads_script`] 的输出:path → base64 头部。缺行/坏 base64 跳过。
pub fn parse_heads_output(raw: &str) -> HashMap<String, String> {
    use base64::Engine as _;
    let mut out = HashMap::new();
    let mut current: Option<String> = None;
    let mut blob = String::new();
    let flush = |path: Option<String>, blob: &mut String, out: &mut HashMap<String, String>| {
        if let Some(path) = path {
            let decoded = base64::engine::general_purpose::STANDARD
                .decode(blob.trim())
                .map(|bytes| String::from_utf8_lossy(&bytes).to_string())
                .unwrap_or_default();
            if !decoded.is_empty() {
                out.insert(path, decoded);
            }
        }
        blob.clear();
    };
    for line in raw.lines() {
        if let Some(path) = line.strip_prefix("__HEAD__") {
            flush(current.take(), &mut blob, &mut out);
            current = Some(path.to_string());
        } else if current.is_some() {
            blob.push_str(line);
        }
    }
    flush(current, &mut blob, &mut out);
    out
}

/// db 里缓存的头部签名与标题。
fn load_db_cache(
    db: &crate::db::Db,
    distro: &str,
) -> HashMap<String, (i64, f64, String, String)> {
    let conn = db.0.lock();
    let Ok(mut stmt) = conn.prepare(
        "SELECT remote_path, size, mtime, title, owning_cwd FROM wsl_session_cache WHERE distro=?1",
    ) else {
        return HashMap::new();
    };
    let rows = stmt.query_map([distro], |r| {
        Ok((
            r.get::<_, String>(0)?,
            (r.get::<_, i64>(1)?, r.get::<_, f64>(2)?, r.get::<_, String>(3)?, r.get::<_, String>(4)?),
        ))
    });
    match rows {
        Ok(rows) => rows.flatten().collect(),
        Err(_) => HashMap::new(),
    }
}

/// 删除会话后同步清掉 db 与进程内缓存,避免磁盘/db 只增不减(§10 P1-10)。
pub fn forget_cached_session(db: &crate::db::Db, distro: &str, remote_path: &str) {
    if let Ok(mut memory) = memory_cache().lock() {
        if let Some(entries) = memory.get_mut(distro) {
            entries.remove(remote_path);
        }
    }
    let conn = db.0.lock();
    if let Err(error) = conn.execute(
        "DELETE FROM wsl_session_cache WHERE distro=?1 AND remote_path=?2",
        rusqlite::params![distro, remote_path],
    ) {
        eprintln!("[wsl] 会话缓存删除失败(distro={distro}, path={remote_path}): {error}");
    }
}

/// 把本次扫描结果写回 db(签名 + 标题),下次启动不用重读全部头部。
fn store_db_cache(
    db: &crate::db::Db,
    distro: &str,
    cache: &HashMap<String, (i64, f64, String, String)>,
) {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    let mut conn = db.0.lock();
    let Ok(tx) = conn.transaction() else {
        eprintln!("[wsl] 会话缓存事务创建失败(distro={distro})");
        return;
    };
    for (path, (size, mtime, title, cwd)) in cache {
        // 自定义 `CLAUDE_CONFIG_DIR` 不一定含 `.claude`;按目录形态判断
        // (`projects` = Claude,`sessions` = Codex)更稳(§10 P2-7)。
        let engine = if path.contains("/projects/") {
            "claude"
        } else if path.contains("/.pi/") || path.contains("/pi/agent/") {
            "pi"
        } else {
            "codex"
        };
        let session_id = session_id_for_path(engine, path).unwrap_or_default();
        if let Err(error) = tx.execute(
            "INSERT INTO wsl_session_cache
                (distro, remote_path, size, mtime, session_id, engine, owning_cwd, title, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
             ON CONFLICT(distro, remote_path) DO UPDATE SET
                size=excluded.size, mtime=excluded.mtime, session_id=excluded.session_id,
                engine=excluded.engine, owning_cwd=excluded.owning_cwd,
                title=excluded.title, updated_at=excluded.updated_at",
            rusqlite::params![distro, path, size, mtime, session_id, engine, cwd, title, now],
        ) {
            eprintln!("[wsl] 会话缓存写入失败(distro={distro}, path={path}): {error}");
        }
    }
    // 表按发行版设上限:会话目录只增不减,长期使用不能无限增长(§10 P1-10)。
    // 保留最近更新的 5000 条;被删掉的最坏代价是下一次重读头部。
    if let Err(error) = tx.execute(
        "DELETE FROM wsl_session_cache WHERE distro=?1 AND remote_path IN (
             SELECT remote_path FROM wsl_session_cache WHERE distro=?1
             ORDER BY updated_at DESC LIMIT -1 OFFSET 5000
         )",
        rusqlite::params![distro],
    ) {
        eprintln!("[wsl] 会话缓存清理失败(distro={distro}): {error}");
    }
    if let Err(error) = tx.commit() {
        eprintln!("[wsl] 会话缓存提交失败(distro={distro}): {error}");
    }
}

/// 进程内头部缓存(按发行版);db 缓存是它的持久化底座。
fn memory_cache() -> &'static std::sync::Mutex<HeadCache> {
    static CACHE: std::sync::OnceLock<std::sync::Mutex<HeadCache>> = std::sync::OnceLock::new();
    CACHE.get_or_init(|| std::sync::Mutex::new(HashMap::new()))
}

/// 列出本机 WSL 工作区在发行版内的 Claude / Codex 会话。
///
/// 一次 `find` 拿全量签名(约 0.7s),只对签名变化的文件再发一次批量读头。
/// 返回行与插件会话源同形:前端把它们合并成 `remote + remotePath` 的行,
/// 打开回放与删除复用既有链路。
#[tauri::command]
pub async fn wsl_list_sessions(
    state: tauri::State<'_, crate::AppState>,
    workspace_path: String,
) -> Result<Vec<WslSessionRow>, String> {
    // 先尊重显式 meta:带 `meta.wsl` 的工作区即使路径形似 UNC,也归
    // 插件/SSH,不能把本机发行版的会话混进远程工作区(§10 P1-3)。
    wsl_transport::transport_for_workspace(&state.db, &workspace_path)?
        .filter(|tp| tp.is_local())
        .ok_or_else(|| format!("不是本机 WSL 工作区: {workspace_path}"))?;
    let unc = wsl_path::parse_wsl_unc(&workspace_path)
        .ok_or_else(|| format!("不是 WSL 工作区: {workspace_path}"))?;
    let probe = wsl_probe::ensure(&unc.distro)
        .await
        .map_err(|e| e.code())?;
    let mut transport = wsl_transport::local_transport(&unc);
    wsl_transport::apply_probe(&mut transport, &probe);

    let raw = wsl_transport::run_script_output(&transport, &list_script(&unc.linux_path)).await?;
    let files = parse_find_output(&raw);

    // 缓存:进程内优先,重启后回落到 db。
    let mut cache = {
        let mut memory = memory_cache().lock().map_err(|e| e.to_string())?;
        memory
            .entry(unc.distro.clone())
            .or_insert_with(|| load_db_cache(&state.db, &unc.distro))
            .clone()
    };
    let siblings = sibling_linux_workspaces(&state.db, &unc.distro);
    let mut rows = build_rows(
        &workspace_path,
        &unc.linux_path,
        &siblings,
        &files,
        &mut cache,
    );

    let changed: Vec<String> = files
        .iter()
        .filter(|file| needs_head(&cache, file))
        // 已知归属别的 Codex 会话不再读头:首次扫描已经付过代价,之后
        // 不能每轮都把其它工作区的转录本读进缓存(§10 P1-9)。
        .filter(|file| {
            let known_cwd = cache
                .get(&file.path)
                .map(|(_, _, _, cwd)| cwd.as_str())
                .unwrap_or("");
            known_cwd.is_empty()
                || row_belongs_to_workspace(
                    &file.engine,
                    known_cwd,
                    &unc.linux_path,
                    &siblings,
                )
        })
        .map(|file| file.path.clone())
        .collect();
    if !changed.is_empty() {
        match wsl_transport::run_script_output(&transport, &heads_script(&changed, HEAD_BYTES)).await
        {
            Ok(heads_raw) => {
                let heads = parse_heads_output(&heads_raw);
                // 先算出要读头的文件,再逐个回填:needs_head 借用 cache 的
                // 不可变引用,不能放在同一循环里和 apply_head 的可变借用重叠。
                let pending: Vec<ScannedFile> = files
                    .iter()
                    .filter(|f| needs_head(&cache, f))
                    .cloned()
                    .collect();
                for file in &pending {
                    if let Some(head) = heads.get(&file.path) {
                        // Codex 子代理 rollout 是父会话的内部执行记录,不是
                        // 独立会话;本地扫描器同样剔除(§10 P2-5)。写入一个
                        // 不可能命中工作区的哨兵 cwd,避免每轮重复读头。
                        if file.engine == "codex" && is_codex_subagent_head(head) {
                            cache.insert(
                                file.path.clone(),
                                (
                                    file.size,
                                    file.mtime,
                                    String::new(),
                                    CODEX_SUBAGENT_CWD.to_string(),
                                ),
                            );
                            continue;
                        }
                        let (title, cwd) = parse_head(&file.engine, head);
                        apply_head(&mut cache, &mut rows, file, title, cwd);
                    }
                }
                // codex 的归属依赖刚读到的 cwd:读头前保守跳过的行要补回来。
                rows = build_rows(
                    &workspace_path,
                    &unc.linux_path,
                    &siblings,
                    &files,
                    &mut cache,
                );
            }
            // 读头失败不影响列表:标题留空,行仍可打开(回放会重新拉取)。
            Err(error) => eprintln!("[wsl] 读取会话标题失败(distro={}): {error}", unc.distro),
        }
    }

    if let Ok(mut memory) = memory_cache().lock() {
        memory.insert(unc.distro.clone(), cache.clone());
    }
    store_db_cache(&state.db, &unc.distro, &cache);

    rows.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    Ok(rows)
}

/// 读头字节数:标题与 cwd 都在文件头部;16KB 覆盖 codex 的 `session_meta`
/// 与大多数首条用户消息。
const HEAD_BYTES: usize = 16 * 1024;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_find_output_and_rejects_malformed_lines() {
        let raw = "claude\t/home/u/.claude/projects/-home-u-repo/s-1.jsonl\t1234\t1700000000.5\t\n\
codex\t/home/u/.codex/sessions/2026/10/19/rollout-a.jsonl\t99\t1700000100.25\t\n\
半截行没有制表符\n\
\n\
claude\t/home/u/x.jsonl\tabc\t123\t\n\
other\t/home/u/y.jsonl\t1\t2\t\n";
        let files = parse_find_output(raw);
        assert_eq!(files.len(), 2);
        assert_eq!(files[0].engine, "claude");
        assert_eq!(files[0].path, "/home/u/.claude/projects/-home-u-repo/s-1.jsonl");
        assert_eq!(files[0].size, 1234);
        assert_eq!(files[1].mtime, 1700000100.25);
    }

    #[test]
    fn parses_claude_head_title_and_cwd() {
        let head = "{\"type\":\"user\",\"cwd\":\"/home/me/repo\",\"message\":{\"content\":\"<system-reminder>no</system-reminder>\"}}\n\
{\"type\":\"user\",\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"列出当前目录文件\"}]}}\n";
        let (title, cwd) = parse_head("claude", head);
        assert_eq!(cwd, "/home/me/repo");
        assert_eq!(title, "列出当前目录文件");
    }

    #[test]
    fn parses_codex_session_meta_cwd() {
        let head = "{\"type\":\"session_meta\",\"payload\":{\"id\":\"r1\",\"cwd\":\"/home/me/repo\"}}\n\
{\"type\":\"event_msg\",\"payload\":{\"type\":\"user_message\",\"message\":\"修复构建错误\"}}\n";
        let (title, cwd) = parse_head("codex", head);
        assert_eq!(cwd, "/home/me/repo");
        assert_eq!(title, "修复构建错误");
    }

    #[test]
    fn parses_pi_session_head_and_uuid() {
        let head = "{\"type\":\"session\",\"version\":3,\"id\":\"01a05bbc-518c\",\"cwd\":\"/home/me/repo\"}\n\
{\"type\":\"message\",\"message\":{\"role\":\"user\",\"content\":[{\"type\":\"text\",\"text\":\"分析当前项目\"}]}}\n";
        let (title, cwd) = parse_head("pi", head);
        assert_eq!(cwd, "/home/me/repo");
        assert_eq!(title, "分析当前项目");
        assert_eq!(
            session_id_for_path(
                "pi",
                "/home/u/.pi/agent/sessions/--home-me-repo--/2026-09-01T06-51-03-436Z_01a05bbc-518c.jsonl"
            )
            .as_deref(),
            Some("01a05bbc-518c")
        );
        // pi 的行也按读到的 cwd 归属;目录编码碰撞时不会串工作区。
        let siblings = vec!["/home/me/repo".to_string()];
        assert!(row_belongs_to_workspace(
            "pi",
            "/home/me/repo",
            "/home/me/repo",
            &siblings
        ));
        assert!(!row_belongs_to_workspace(
            "pi",
            "/home/me/other",
            "/home/me/repo",
            &siblings
        ));
    }

    #[test]
    fn truncated_head_is_tolerated() {
        // 16KB 断在 JSON 中间是常态:坏行跳过,前面的行仍然可用
        let head = "{\"type\":\"user\",\"cwd\":\"/home/me/repo\",\"message\":{\"content\":\"hi\"}}\n\
{\"type\":\"user\",\"cwd\":\"/home/me/repo\",\"message\":{\"cont";
        let (title, cwd) = parse_head("claude", head);
        assert_eq!(cwd, "/home/me/repo");
        assert_eq!(title, "hi");
    }

    #[test]
    fn codex_rows_need_matching_cwd() {
        let only = vec!["/home/me/repo".to_string()];
        assert!(row_belongs_to_workspace(
            "codex",
            "/home/me/repo",
            "/home/me/repo",
            &only
        ));
        assert!(row_belongs_to_workspace(
            "codex",
            "/home/me/repo/sub",
            "/home/me/repo",
            &only
        ));
        assert!(!row_belongs_to_workspace(
            "codex",
            "/home/me/other",
            "/home/me/repo",
            &only
        ));
        // 缺 cwd:不归属(宁缺勿错)
        assert!(!row_belongs_to_workspace(
            "codex",
            "",
            "/home/me/repo",
            &only
        ));
        // claude 已经由目录编码筛过
        assert!(row_belongs_to_workspace(
            "claude",
            "",
            "/home/me/repo",
            &only
        ));
    }

    #[test]
    fn nested_workspaces_use_the_longest_prefix() {
        let siblings = vec![
            "/home/me/repo".to_string(),
            "/home/me/repo/sub".to_string(),
        ];
        // 子工作区的会话不能同时出现在父工作区(§10 D6)。
        assert!(!row_belongs_to_workspace(
            "codex",
            "/home/me/repo/sub/x",
            "/home/me/repo",
            &siblings
        ));
        assert!(row_belongs_to_workspace(
            "codex",
            "/home/me/repo/sub/x",
            "/home/me/repo/sub",
            &siblings
        ));
        assert!(row_belongs_to_workspace(
            "codex",
            "/home/me/repo/other",
            "/home/me/repo",
            &siblings
        ));
    }

    #[test]
    fn signature_changes_invalidate_but_stable_ones_do_not() {
        assert!(signature_changed(None, 10, 1.0));
        assert!(!signature_changed(Some((10, 1.0)), 10, 1.0));
        assert!(signature_changed(Some((10, 1.0)), 11, 1.0));
        assert!(signature_changed(Some((10, 1.0)), 10, 2.0));
    }

    #[test]
    fn rows_skip_unrelated_codex_files_and_keep_cached_titles() {
        let files = vec![
            ScannedFile {
                engine: "claude".into(),
                path: "/home/me/.claude/projects/-home-me-repo/s-1.jsonl".into(),
                size: 10,
                mtime: 1700000000.0,
            },
            ScannedFile {
                engine: "codex".into(),
                path: "/home/me/.codex/sessions/rollout-other.jsonl".into(),
                size: 20,
                mtime: 1700000001.0,
            },
        ];
        let mut cache: HashMap<String, (i64, f64, String, String)> = HashMap::new();
        cache.insert(
            "/home/me/.claude/projects/-home-me-repo/s-1.jsonl".to_string(),
            (10, 1700000000.0, "缓存标题".into(), "/home/me/repo".into()),
        );
        cache.insert(
            "/home/me/.codex/sessions/rollout-other.jsonl".to_string(),
            (20, 1700000001.0, "别的仓库".into(), "/home/me/other".into()),
        );
        let rows = build_rows(
            r"\\wsl.localhost\Ubuntu\home\me\repo",
            "/home/me/repo",
            &["/home/me/repo".to_string()],
            &files,
            &mut cache,
        );
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].engine, "claude");
        assert_eq!(rows[0].session_id, "s-1");
        assert_eq!(rows[0].title, "缓存标题");
        assert_eq!(
            rows[0].remote_path,
            "/home/me/.claude/projects/-home-me-repo/s-1.jsonl"
        );
        assert_eq!(rows[0].workspace_path, r"\\wsl.localhost\Ubuntu\home\me\repo");
    }

    #[test]
    fn apply_head_fills_only_missing_titles() {
        let file = ScannedFile {
            engine: "claude".into(),
            path: "/p/s.jsonl".into(),
            size: 5,
            mtime: 1.0,
        };
        let mut rows = vec![WslSessionRow {
            engine: "claude".into(),
            session_id: "s".into(),
            workspace_path: "w".into(),
            title: String::new(),
            updated_at: None,
            remote_path: "/p/s.jsonl".into(),
        }];
        let mut cache = HashMap::new();
        apply_head(&mut cache, &mut rows, &file, "新标题".into(), "/p".into());
        assert_eq!(rows[0].title, "新标题");
        assert!(cache.contains_key("/p/s.jsonl"));
        // 已有标题不再覆盖
        apply_head(&mut cache, &mut rows, &file, "另一标题".into(), "/p".into());
        assert_eq!(rows[0].title, "新标题");
    }

    #[test]
    fn heads_script_quotes_every_path() {
        // 批量读头是实际走的那一支:每个路径都要过 shell 引号(空格/中文
        // 目录在发行版里是常态),否则整段脚本会被空格切成多个参数。
        let script = heads_script(&["/home/me/a b.jsonl".to_string()], 16384);
        assert!(script.contains("'__HEAD__%s\\n' '/home/me/a b.jsonl'"));
        assert!(script.contains("head -c 16384 -- '/home/me/a b.jsonl'"));
        assert!(script.contains("base64 -w0"));
    }

    #[test]
    fn session_id_strips_suffix_and_skips_history() {
        assert_eq!(
            session_id_from_path("/p/s-1.jsonl").as_deref(),
            Some("s-1")
        );
        assert_eq!(session_id_from_path("/p/history.jsonl"), None);
        assert_eq!(session_id_from_path("/p/x.txt"), None);
    }
}

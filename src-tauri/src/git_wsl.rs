//! WSL 工作区的 Git：全部命令在发行版内执行。
//!
//! 为什么不走主机：Windows 侧 `git` / libgit2 对 `\\wsl.localhost\…` 会触发
//! 所有权校验（V24：`dubious ownership`，2.8s），发行版内同一操作 33ms。本
//! 模块因此只做两件事：构造发行版内脚本、解析它的哨兵输出；所有 `wsl.exe`
//! 细节仍经 [`wsl_transport`]，模块内不出现平台字面量（边界守卫允许本文件，
//! 但实现不需要）。
//!
//! 脚本永远 `exit 0`：非零退出会被传输层统一成 `WSL_SHORT_CALL_FAILED`，
//! git 的真实 stderr 就丢了。结果走 stdout 哨兵，文本/路径一律 base64 ——
//! 路径可能含空格、中文与引号，NUL 分隔的原始字节经传输层 lossy 解码不安全。

use crate::engine::wsl_path::WslUncPath;
use crate::engine::wsl_transport;
use crate::git::{BranchInfo, GitFileEntry, GitStatus, GitTreeLevel, GitTreeStatus, RepositorySummary};
use std::collections::HashMap;

// ── 哨兵 ────────────────────────────────────────────────────────────────────

const SENT_NOT_REPO: &str = "__CCGUI__GIT_NOT_REPO";
const SENT_NO_GIT: &str = "__CCGUI__GIT_NO_GIT";
const SENT_CWD: &str = "__CCGUI__GIT_CWD";
const SENT_ERR: &str = "__CCGUI__GIT_ERR ";
const SENT_STATUS: &str = "__CCGUI__GIT_STATUS ";
const SENT_CACHED: &str = "__CCGUI__GIT_CACHED ";
const SENT_WORK: &str = "__CCGUI__GIT_WORK ";
const SENT_UNTRACKED: &str = "__CCGUI__GIT_UNTRACKED ";
const SENT_HEAD: &str = "__CCGUI__GIT_HEAD ";

/// 单次补丁文本上限（与主机 `MAX_DIFF_PATCH_BYTES` 一致）。
const MAX_DIFF_PATCH_BYTES: usize = 2 * 1024 * 1024;
const DIFF_TRUNCATED_MARKER: &str = "[... diff truncated: file too large to preview ...]\n";

/// untracked 行数统计的上限（文件数与单文件字节数，与主机默认一致）。
const MAX_UNTRACKED_FILES: usize = 500;
const MAX_UNTRACKED_BYTES: u64 = 1024 * 1024;

// ── 错误 ────────────────────────────────────────────────────────────────────

fn not_repo() -> String {
    // 复用主机 `open_repo` 的字符串：前端 useGitStore 用它判断「不是仓库」。
    "NOT_A_REPO".to_string()
}

/// git stderr → 稳定错误码。认证类单独成码（前端给可操作提示），其余带上
/// git 原文（与主机返回 libgit2 原文同一规则）。
fn map_git_error(stderr: &str) -> String {
    let detail = stderr.trim();
    let lower = detail.to_lowercase();
    let auth = lower.contains("authentication failed")
        || lower.contains("publickey")
        || lower.contains("permission denied")
        || lower.contains("could not read username")
        || lower.contains("could not read password")
        || lower.contains("terminal prompts disabled")
        || lower.contains("no credential")
        || lower.contains("access denied");
    if auth {
        return format!("WSL_GIT_AUTH_FAILED:{detail}");
    }
    format!("WSL_GIT_FAILED:{detail}")
}

// ── 脚本骨架 ────────────────────────────────────────────────────────────────

/// 公共前缀：git 存在性 → 进入目录 → 仓库根。失败全部走哨兵 + exit 0。
/// 目录不存在与「不是仓库」分开报：前者是工作区被删/挂载失败，后者才是
/// 普通的非 git 目录（文档 §7 的错误契约）。
fn repo_prelude(linux_path: &str) -> String {
    format!(
        "command -v git >/dev/null 2>&1 || {{ printf '{SENT_NO_GIT}\\n'; exit 0; }}\n\
         cd -- {} 2>/dev/null || {{ printf '{SENT_CWD}\\n'; exit 0; }}\n\
         root=$(git rev-parse --show-toplevel 2>/dev/null) || {{ printf '{SENT_NOT_REPO}\\n'; exit 0; }}\n",
        wsl_transport::sh_quote(linux_path)
    )
}

/// 在 `$root` 上跑一条 git 命令：成功打印 base64(stdout)，失败打印
/// `SENT_ERR base64(stderr+stdout)`。「有输出就算成功」的用法（如 diff 的
/// 退出码 1）不套这个包装。
fn run_or_err(args: &str) -> String {
    format!(
        "if git -C \"$root\" {args} > /tmp/ccgui-git-out.$$ 2> /tmp/ccgui-git-err.$$; then\n\
           base64 -w0 < /tmp/ccgui-git-out.$$; rm -f /tmp/ccgui-git-out.$$ /tmp/ccgui-git-err.$$\n\
         else\n\
           printf '{SENT_ERR}%s\\n' \"$(cat /tmp/ccgui-git-err.$$ /tmp/ccgui-git-out.$$ | base64 -w0)\"\n\
           rm -f /tmp/ccgui-git-out.$$ /tmp/ccgui-git-err.$$\n\
         fi\n"
    )
}

/// 脚本结果的公共分类：CWD / NOT_REPO / NO_GIT / ERR → 对应错误；否则返回原文。
fn classify(raw: &str, cwd: &str) -> Result<String, String> {
    for line in raw.lines() {
        let line = line.trim_end();
        if line == SENT_CWD {
            return Err(format!("WSL_CWD_NOT_FOUND:{cwd}"));
        }
        if line.contains(SENT_NOT_REPO) {
            return Err(not_repo());
        }
        if line.contains(SENT_NO_GIT) {
            return Err("WSL_GIT_MISSING".to_string());
        }
        if let Some(b64) = line.strip_prefix(SENT_ERR) {
            let stderr = decode_b64(b64).unwrap_or_default();
            return Err(map_git_error(&stderr));
        }
    }
    Ok(raw.to_string())
}

fn decode_b64(text: &str) -> Option<String> {
    use base64::Engine as _;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(text.trim())
        .ok()?;
    Some(String::from_utf8_lossy(&bytes).into_owned())
}

fn encode_b64(text: &str) -> String {
    use base64::Engine as _;
    base64::engine::general_purpose::STANDARD.encode(text.as_bytes())
}

async fn run(unc: &WslUncPath, script: &str) -> Result<String, String> {
    let transport = wsl_transport::local_transport(unc);
    wsl_transport::run_script_output(&transport, script).await
}

// ── status ─────────────────────────────────────────────────────────────────

/// porcelain v2 的一条记录。
#[derive(Debug, Clone, PartialEq, Eq)]
struct StatusRecord {
    path: String,
    /// X（索引侧）与 Y（工作树侧）；untracked 记录的两位都是 `?`。
    x: char,
    y: char,
}

#[derive(Debug, Default, Clone, PartialEq, Eq)]
struct ParsedStatus {
    branch: String,
    ahead: Option<usize>,
    behind: Option<usize>,
    records: Vec<StatusRecord>,
}

/// `git status --porcelain=v2 --branch -z` 的解析（纯函数）。
///
/// `-z` 下**所有**记录（含 `#` 头）都以 NUL 结尾；rename/copy 记录（`2 …`）
/// 之后紧跟一条独立记录存放原路径，需要多消费一条。
fn parse_status_v2(raw: &str) -> ParsedStatus {
    let mut parsed = ParsedStatus::default();
    let mut records = raw.split('\0').filter(|r| !r.is_empty()).peekable();
    while let Some(record) = records.next() {
        if let Some(head) = record.strip_prefix("# branch.head ") {
            parsed.branch = if head == "(detached)" {
                "HEAD".to_string()
            } else {
                head.to_string()
            };
            continue;
        }
        if let Some(ab) = record.strip_prefix("# branch.ab ") {
            // 形如 "+3 -1"；没有 upstream 时 git 不打印这一行。
            let mut parts = ab.split_whitespace();
            let ahead = parts.next().and_then(|v| v.strip_prefix('+'));
            let behind = parts.next().and_then(|v| v.strip_prefix('-'));
            parsed.ahead = ahead.and_then(|v| v.parse().ok());
            parsed.behind = behind.and_then(|v| v.parse().ok());
            continue;
        }
        if record.starts_with('#') {
            continue;
        }
        if let Some(path) = record.strip_prefix("? ") {
            parsed.records.push(StatusRecord {
                path: path.to_string(),
                x: '?',
                y: '?',
            });
            continue;
        }
        if record.starts_with("! ") {
            continue;
        }
        if record.starts_with("1 ") {
            // `1 XY sub mH mI mW hH hI path`：path 可含空格，只能按前 8 段切。
            if let Some(rec) = split_v2_record(record, 1) {
                parsed.records.push(rec);
            }
            continue;
        }
        if record.starts_with("2 ") {
            // `2 XY sub mH mI mW hH hI Xscore path` + 下一条记录是原路径。
            if let Some(rec) = split_v2_record(record, 2) {
                parsed.records.push(rec);
            }
            let _ = records.next();
            continue;
        }
    }
    parsed
}

/// 取 v2 记录的 XY 与路径。路径可能含空格，只能按固定段数切：`1` 记录在
/// 路径前有 8 段（kind、XY、sub、mH、mI、mW、hH、hI），`2` 记录多一个
/// rename/copy 的 score 段（9 段）。切完剩下的整段就是路径。
fn split_v2_record(record: &str, kind: usize) -> Option<StatusRecord> {
    let fields_before_path = if kind == 2 { 9 } else { 8 };
    let mut rest = record;
    let mut xy = "";
    for index in 0..fields_before_path {
        let (part, tail) = rest.split_once(' ')?;
        if index == 1 {
            xy = part;
        }
        rest = tail;
    }
    let mut chars = xy.chars();
    let x = chars.next().unwrap_or('.');
    let y = chars.next().unwrap_or('.');
    Some(StatusRecord {
        path: rest.to_string(),
        x,
        y,
    })
}

/// 状态标签：与主机 `status_label` 同一优先级（删除 > 重命名 > 新增 >
/// 类型变化 > 修改）。
fn label_for(letter: char) -> &'static str {
    match letter {
        'D' => "deleted",
        'R' | 'C' => "renamed",
        'A' => "added",
        'T' => "typechange",
        _ => "modified",
    }
}

/// `--numstat -z` 解析：普通记录 `add\tdel\tpath`；rename 记录
/// `add\tdel\t` 后跟两条 `old` / `new` 记录。`-`（二进制）按 0 计
/// （主机对二进制同样给出 Some(0) + Some(0)）。
fn parse_numstat(raw: &str) -> HashMap<String, (usize, usize)> {
    let mut out = HashMap::new();
    let mut records = raw.split('\0').filter(|r| !r.is_empty());
    while let Some(record) = records.next() {
        let mut parts = record.splitn(3, '\t');
        let (Some(add), Some(del), Some(path)) = (parts.next(), parts.next(), parts.next()) else {
            continue;
        };
        let counts = (
            add.parse::<usize>().unwrap_or(0),
            del.parse::<usize>().unwrap_or(0),
        );
        if path.is_empty() {
            // rename：接下来两条记录是旧路径与新路径。
            let _old = records.next();
            if let Some(new) = records.next() {
                out.insert(new.to_string(), counts);
            }
            continue;
        }
        out.insert(path.to_string(), counts);
    }
    out
}

/// untracked 行数：`SENT_UNTRACKED <base64 path> <lines>`。
fn parse_untracked_counts(raw: &str) -> HashMap<String, usize> {
    let mut out = HashMap::new();
    for line in raw.lines() {
        let Some(rest) = line.trim_end().strip_prefix(SENT_UNTRACKED) else {
            continue;
        };
        let Some((path_b64, lines)) = rest.split_once(' ') else {
            continue;
        };
        let Some(path) = decode_b64(path_b64) else {
            continue;
        };
        if let Ok(lines) = lines.trim().parse::<usize>() {
            out.insert(path, lines);
        }
    }
    out
}

/// 记录 → 三个分组（staged / unstaged / untracked），路径相对仓库根。
fn collect_records(records: &[StatusRecord]) -> (Vec<GitFileEntry>, Vec<GitFileEntry>, Vec<GitFileEntry>) {
    let mut staged = Vec::new();
    let mut unstaged = Vec::new();
    let mut untracked = Vec::new();
    for rec in records {
        if rec.x == '?' {
            untracked.push(GitFileEntry {
                path: rec.path.clone(),
                status: "added".to_string(),
                additions: None,
                deletions: None,
            });
            continue;
        }
        if rec.x != '.' && rec.x != ' ' {
            staged.push(GitFileEntry {
                path: rec.path.clone(),
                status: label_for(rec.x).to_string(),
                additions: None,
                deletions: None,
            });
        }
        if rec.y != '.' && rec.y != ' ' {
            unstaged.push(GitFileEntry {
                path: rec.path.clone(),
                status: label_for(rec.y).to_string(),
                additions: None,
                deletions: None,
            });
        }
    }
    (staged, unstaged, untracked)
}

fn status_script(linux_path: &str) -> String {
    format!(
        "{}\
         printf '{SENT_STATUS}%s\\n' \"$(git -C \"$root\" status --porcelain=v2 --branch -z --untracked-files=all | base64 -w0)\"\n\
         printf '{SENT_CACHED}%s\\n' \"$(git -C \"$root\" diff --cached --numstat -z | base64 -w0)\"\n\
         printf '{SENT_WORK}%s\\n' \"$(git -C \"$root\" diff --numstat -z | base64 -w0)\"\n\
         git -C \"$root\" ls-files --others --exclude-standard -z \
           | {{ n=0; while IFS= read -r -d '' f; do n=$((n+1)); [ \"$n\" -gt {max_files} ] && break; \
                [ -f \"$root/$f\" ] || continue; \
                sz=$(stat -c %s \"$root/$f\" 2>/dev/null) || continue; \
                [ \"$sz\" -gt {max_bytes} ] && continue; \
                lines=$(awk 'END{{print NR}}' \"$root/$f\" 2>/dev/null) || continue; \
                printf '{SENT_UNTRACKED}%s %s\\n' \"$(printf '%s' \"$f\" | base64 -w0)\" \"$lines\"; \
              done; }}\n\
         exit 0\n",
        repo_prelude(linux_path),
        max_files = MAX_UNTRACKED_FILES,
        max_bytes = MAX_UNTRACKED_BYTES,
    )
}

pub async fn status(unc: &WslUncPath) -> Result<GitStatus, String> {
    let raw = run(unc, &status_script(&unc.linux_path)).await?;
    let raw = classify(&raw, &unc.linux_path)?;
    Ok(build_status(&raw))
}

/// 哨兵输出 → `GitStatus`（纯函数，供单测直接喂样本）。
pub(crate) fn build_status(raw: &str) -> GitStatus {
    let mut status_raw = String::new();
    let mut cached_raw = String::new();
    let mut work_raw = String::new();
    for line in raw.lines() {
        let line = line.trim_end();
        if let Some(b64) = line.strip_prefix(SENT_STATUS) {
            status_raw = decode_b64(b64).unwrap_or_default();
        } else if let Some(b64) = line.strip_prefix(SENT_CACHED) {
            cached_raw = decode_b64(b64).unwrap_or_default();
        } else if let Some(b64) = line.strip_prefix(SENT_WORK) {
            work_raw = decode_b64(b64).unwrap_or_default();
        }
    }
    let parsed = parse_status_v2(&status_raw);
    let cached = parse_numstat(&cached_raw);
    let work = parse_numstat(&work_raw);
    let untracked_lines = parse_untracked_counts(raw);
    let (mut staged, mut unstaged, mut untracked) = collect_records(&parsed.records);
    for entry in staged.iter_mut() {
        if let Some((a, d)) = cached.get(&entry.path) {
            entry.additions = Some(*a);
            entry.deletions = Some(*d);
        }
    }
    for entry in unstaged.iter_mut() {
        if let Some((a, d)) = work.get(&entry.path) {
            entry.additions = Some(*a);
            entry.deletions = Some(*d);
        }
    }
    for entry in untracked.iter_mut() {
        if let Some(lines) = untracked_lines.get(&entry.path) {
            entry.additions = Some(*lines);
            entry.deletions = Some(0);
        }
    }
    GitStatus {
        branch: if parsed.branch.is_empty() {
            "HEAD".to_string()
        } else {
            parsed.branch
        },
        staged,
        unstaged,
        untracked,
        ahead: parsed.ahead,
        behind: parsed.behind,
    }
}

// ── diff ───────────────────────────────────────────────────────────────────

fn diff_script(linux_path: &str, file: &str, staged: bool) -> String {
    let quoted_file = wsl_transport::sh_quote(file);
    let body = if staged {
        format!("git -C \"$root\" diff --cached --no-color -U3 -- {quoted_file}")
    } else {
        format!(
            "if git -C \"$root\" ls-files --error-unmatch -- {quoted_file} >/dev/null 2>&1; then\n\
               git -C \"$root\" diff --no-color -U3 -- {quoted_file}\n\
             else\n\
               # untracked：用 --no-index 生成带 + 行的补丁（有差异时退出码 1，不算失败）。\n\
               ( cd \"$root\" && git diff --no-index --no-color -U3 -- /dev/null {quoted_file} 2>/dev/null )\n\
             fi"
        )
    };
    format!(
        "{}\
         {body} | head -c {cap} | base64 -w0\n\
         exit 0\n",
        repo_prelude(linux_path),
        cap = MAX_DIFF_PATCH_BYTES,
    )
}

pub async fn diff(unc: &WslUncPath, file: &str, staged: bool) -> Result<String, String> {
    validate_repo_relative(file)?;
    let raw = run(unc, &diff_script(&unc.linux_path, file, staged)).await?;
    let raw = classify(&raw, &unc.linux_path)?;
    let b64: String = raw.lines().map(str::trim).collect();
    let bytes = {
        use base64::Engine as _;
        base64::engine::general_purpose::STANDARD
            .decode(b64.as_bytes())
            .unwrap_or_default()
    };
    let truncated = bytes.len() >= MAX_DIFF_PATCH_BYTES;
    let mut text = String::from_utf8_lossy(&bytes).into_owned();
    if truncated {
        if !text.ends_with('\n') {
            text.push('\n');
        }
        text.push_str(DIFF_TRUNCATED_MARKER);
    }
    Ok(text)
}

// ── 变更操作 ───────────────────────────────────────────────────────────────

/// 仓库相对路径校验：空串、`.`、绝对路径与任何 `..` 段一律拒绝。
///
/// 路径正常来自 status 输出，但 `discard` 会对未跟踪文件 `rm -rf`，必须
/// 保证删除目标拼不出仓库根（设计 §4.4 的防御性要求，不能省）。
fn validate_repo_relative(path: &str) -> Result<(), String> {
    let path = path.trim();
    let invalid = || "WSL_GIT_FAILED:invalid repository-relative path".to_string();
    if path.is_empty() || path == "." || path.contains('\0') {
        return Err(invalid());
    }
    if path.starts_with('/') || path.starts_with('\\') {
        return Err(invalid());
    }
    if path.split(['/', '\\']).any(|seg| seg == "..") {
        return Err(invalid());
    }
    Ok(())
}

fn validate_files(files: &[String]) -> Result<(), String> {
    for file in files {
        validate_repo_relative(file)?;
    }
    Ok(())
}

fn files_args(files: &[String]) -> String {
    files
        .iter()
        .map(|f| wsl_transport::sh_quote(f))
        .collect::<Vec<_>>()
        .join(" ")
}

pub async fn stage(unc: &WslUncPath, files: &[String]) -> Result<(), String> {
    if files.is_empty() {
        return Ok(());
    }
    validate_files(files)?;
    let script = format!(
        "{}{}\nexit 0\n",
        repo_prelude(&unc.linux_path),
        run_or_err(&format!("add -A -- {}", files_args(files))),
    );
    let raw = run(unc, &script).await?;
    classify(&raw, &unc.linux_path).map(|_| ())
}

pub async fn unstage(unc: &WslUncPath, files: &[String]) -> Result<(), String> {
    if files.is_empty() {
        return Ok(());
    }
    validate_files(files)?;
    // 无提交（unborn）时 `git reset HEAD` 不可用，用 `git rm --cached` 等价。
    let body = format!(
        "if git -C \"$root\" rev-parse --verify HEAD >/dev/null 2>&1; then\n\
           {}\n\
         else\n\
           {}\n\
         fi\n",
        run_or_err(&format!("reset -q HEAD -- {}", files_args(files))),
        run_or_err(&format!("rm --cached -q -- {}", files_args(files))),
    );
    let script = format!("{}{}\nexit 0\n", repo_prelude(&unc.linux_path), body);
    let raw = run(unc, &script).await?;
    classify(&raw, &unc.linux_path).map(|_| ())
}

pub async fn discard(unc: &WslUncPath, files: &[String]) -> Result<(), String> {
    if files.is_empty() {
        return Ok(());
    }
    validate_files(files)?;
    // 索引内的路径还原（已 staged 的改动保留），untracked 直接删除。
    let mut body = String::new();
    for file in files {
        let quoted = wsl_transport::sh_quote(file);
        body.push_str(&format!(
            "if git -C \"$root\" ls-files --error-unmatch -- {quoted} >/dev/null 2>&1; then\n\
               out=$(git -C \"$root\" checkout -q -- {quoted} 2>&1) || {{ printf '{SENT_ERR}%s\\n' \"$(printf '%s' \"$out\" | base64 -w0)\"; }}\n\
             else\n\
               rm -rf -- \"$root\"/{quoted} 2>/dev/null || {{ printf '{SENT_ERR}%s\\n' \"$(printf '%s' 'delete failed' | base64 -w0)\"; }}\n\
             fi\n"
        ));
    }
    body.push_str("exit 0\n");
    let script = format!("{}{}", repo_prelude(&unc.linux_path), body);
    let raw = run(unc, &script).await?;
    classify(&raw, &unc.linux_path).map(|_| ())
}

pub async fn commit(unc: &WslUncPath, message: &str) -> Result<String, String> {
    let trimmed = message.trim();
    if trimmed.is_empty() {
        return Err("empty commit message".to_string());
    }
    // 提交信息不进 argv：base64 内嵌脚本，经 stdin 喂给 `git commit -F -`。
    let script = format!(
        "{}\
         out=$(printf '%s' {b64} | base64 -d | git -C \"$root\" commit -F - 2>&1) || {{ printf '{SENT_ERR}%s\\n' \"$(printf '%s' \"$out\" | base64 -w0)\"; exit 0; }}\n\
         printf '{SENT_HEAD}%s\\n' \"$(git -C \"$root\" rev-parse HEAD 2>/dev/null | base64 -w0)\"\n\
         exit 0\n",
        repo_prelude(&unc.linux_path),
        b64 = encode_b64(trimmed),
    );
    let raw = run(unc, &script).await?;
    let raw = classify(&raw, &unc.linux_path)?;
    for line in raw.lines() {
        if let Some(b64) = line.trim_end().strip_prefix(SENT_HEAD) {
            return decode_b64(b64).ok_or_else(|| "WSL_GIT_FAILED:empty HEAD".to_string());
        }
    }
    Err("WSL_GIT_FAILED:commit produced no HEAD".to_string())
}

fn network_script(linux_path: &str, body: &str) -> String {
    format!(
        "{}\
         if git -C \"$root\" symbolic-ref -q --short HEAD >/dev/null 2>&1; then :; else printf '{SENT_ERR}%s\\n' \"$(printf '%s' 'detached HEAD' | base64 -w0)\"; exit 0; fi\n\
         branch=$(git -C \"$root\" symbolic-ref --short HEAD)\n\
         {body}\n\
         exit 0\n",
        repo_prelude(linux_path)
    )
}

pub async fn push(unc: &WslUncPath) -> Result<(), String> {
    let script = network_script(
        &unc.linux_path,
        &format!(
            "out=$(git -C \"$root\" push origin \"$branch\" 2>&1) || {{ printf '{SENT_ERR}%s\\n' \"$(printf '%s' \"$out\" | base64 -w0)\"; }}"
        ),
    );
    let transport = wsl_transport::local_transport(unc);
    // 大仓库的网络推送不套 30s 的短调用预算。
    let raw = wsl_transport::run_script_output_with_timeout(
        &transport,
        &script,
        std::time::Duration::from_secs(180),
    )
    .await?;
    classify(&raw, &unc.linux_path).map(|_| ())
}

pub async fn pull(unc: &WslUncPath) -> Result<(), String> {
    // 与主机同语义：只做 fast-forward，不自动 merge。
    let script = network_script(
        &unc.linux_path,
        &format!(
            "out=$(git -C \"$root\" fetch origin \"$branch\" 2>&1) || {{ printf '{SENT_ERR}%s\\n' \"$(printf '%s' \"$out\" | base64 -w0)\"; exit 0; }}\n\
             out=$(git -C \"$root\" merge --ff-only FETCH_HEAD 2>&1) || {{ printf '{SENT_ERR}%s\\n' \"$(printf '%s' \"$out\" | base64 -w0)\"; }}"
        ),
    );
    let transport = wsl_transport::local_transport(unc);
    let raw = wsl_transport::run_script_output_with_timeout(
        &transport,
        &script,
        std::time::Duration::from_secs(180),
    )
    .await?;
    classify(&raw, &unc.linux_path).map(|_| ())
}

pub async fn branches(unc: &WslUncPath) -> Result<Vec<BranchInfo>, String> {
    let script = format!(
        "{}\
         printf '{SENT_STATUS}%s\\n' \"$(git -C \"$root\" for-each-ref --format='%(refname:short)%09%(refname)%09%(symref)' refs/heads refs/remotes | base64 -w0)\"\n\
         exit 0\n",
        repo_prelude(&unc.linux_path),
    );
    let raw = run(unc, &script).await?;
    let raw = classify(&raw, &unc.linux_path)?;
    let mut text = String::new();
    for line in raw.lines() {
        if let Some(b64) = line.trim_end().strip_prefix(SENT_STATUS) {
            text = decode_b64(b64).unwrap_or_default();
        }
    }
    Ok(parse_branches(&text))
}

/// `for-each-ref` 输出 → 分支列表。本地在前、远端在后；跳过
/// `refs/remotes/*/HEAD` 这类符号引用（symref 非空）。
pub(crate) fn parse_branches(raw: &str) -> Vec<BranchInfo> {
    let mut local = Vec::new();
    let mut remote = Vec::new();
    for line in raw.lines() {
        let mut parts = line.split('\t');
        let (Some(short), Some(full)) = (parts.next(), parts.next()) else {
            continue;
        };
        let symref = parts.next().unwrap_or("").trim();
        if !symref.is_empty() || short.is_empty() || short == "HEAD" {
            continue;
        }
        let info = BranchInfo {
            name: short.to_string(),
            is_remote: full.starts_with("refs/remotes/"),
        };
        if info.is_remote {
            remote.push(info);
        } else {
            local.push(info);
        }
    }
    local.extend(remote);
    local
}

pub async fn checkout(unc: &WslUncPath, branch: &str) -> Result<(), String> {
    let b = wsl_transport::sh_quote(branch);
    // 与主机一致：本地分支直接切；只有远端分支时物化为本地跟踪分支
    // （同名本地已存在则切本地，不强制远端 tip）。
    let local_branch = branch.split_once('/').map(|(_, rest)| rest).unwrap_or(branch);
    let body = format!(
        "if git -C \"$root\" show-ref --verify --quiet refs/heads/{b}; then\n\
           {}\n\
         elif git -C \"$root\" show-ref --verify --quiet refs/remotes/{b}; then\n\
           if git -C \"$root\" show-ref --verify --quiet refs/heads/\"$branch_local\"; then\n\
             {}\n\
           else\n\
             {}\n\
           fi\n\
         else\n\
           printf '{SENT_ERR}%s\\n' \"$(printf '%s' 'no such branch' | base64 -w0)\"\n\
         fi\n",
        run_or_err(&format!("checkout -q {b}")),
        run_or_err("checkout -q \"$branch_local\""),
        run_or_err(&format!("checkout -q -b \"$branch_local\" --track {b}")),
    );
    let script = format!(
        "branch_local={}\n{}{}\nexit 0\n",
        wsl_transport::sh_quote(local_branch),
        repo_prelude(&unc.linux_path),
        body,
    );
    let raw = run(unc, &script).await?;
    classify(&raw, &unc.linux_path).map(|_| ())
}

pub async fn create_branch(unc: &WslUncPath, name: &str) -> Result<(), String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err("empty branch name".to_string());
    }
    let script = format!(
        "{}{}\nexit 0\n",
        repo_prelude(&unc.linux_path),
        run_or_err(&format!("checkout -q -b {}", wsl_transport::sh_quote(trimmed))),
    );
    let raw = run(unc, &script).await?;
    classify(&raw, &unc.linux_path).map(|_| ())
}

// ── 文件树装饰 ─────────────────────────────────────────────────────────────

/// 一个 level 的解析结果。
#[derive(Debug, Default)]
struct LevelInfo {
    /// 仓库根（Linux 绝对路径，空 = 不在仓库里）。
    root: String,
    /// 复用上一个 level 的 status（同仓库下的兄弟目录）。
    reused: bool,
    entries: Vec<(String, char)>, // (path, 首字符类别)
    branch: String,
    nested: Vec<(String, String, Vec<(String, char)>)>, // (name, branch, entries)
}

/// 批量脚本：每个 level 输出 `__CCGUI__LVL i`，随后 root / status / branch /
/// nested 记录。同仓库的兄弟目录复用上一条 status（`__CCGUI__REUSE`）。
fn tree_script(levels: &[(String, Vec<String>)]) -> String {
    let mut script = String::from(
        "command -v git >/dev/null 2>&1 || exit 0\n\
         last_root=''\n\
         last_status=''\n\
         last_branch=''\n",
    );
    for (index, (level, dirs)) in levels.iter().enumerate() {
        script.push_str(&format!(
            "printf '__CCGUI__LVL {index}\\n'\n\
             lvl_root=''\n\
             cd -- {} 2>/dev/null && lvl_root=$(git rev-parse --show-toplevel 2>/dev/null) || lvl_root=''\n\
             printf '__CCGUI__ROOT %s\\n' \"$(printf '%s' \"$lvl_root\" | base64 -w0)\"\n\
             if [ -n \"$lvl_root\" ]; then\n\
               if [ \"$lvl_root\" = \"$last_root\" ]; then\n\
                 printf '__CCGUI__REUSE\\n'\n\
               else\n\
                 last_root=\"$lvl_root\"\n\
                 last_status=$(git -C \"$lvl_root\" status --porcelain -z -uall 2>/dev/null | base64 -w0)\n\
                 last_branch=$(git -C \"$lvl_root\" rev-parse --abbrev-ref HEAD 2>/dev/null)\n\
                 printf '__CCGUI__STATUS %s\\n' \"$last_status\"\n\
                 printf '__CCGUI__BRANCH %s\\n' \"$(printf '%s' \"$last_branch\" | base64 -w0)\"\n\
               fi\n\
             fi\n",
            wsl_transport::sh_quote(level),
        ));
        for dir in dirs {
            let child = format!("{}/{}", level.trim_end_matches('/'), dir);
            script.push_str(&format!(
                "if [ -e {git} ]; then\n\
                   nb=$(git -C {dir} rev-parse --abbrev-ref HEAD 2>/dev/null)\n\
                   ns=$(git -C {dir} status --porcelain -z -uall 2>/dev/null | base64 -w0)\n\
                   printf '__CCGUI__NESTED %s %s %s\\n' {name_b64} \"$(printf '%s' \"$nb\" | base64 -w0)\" \"$ns\"\n\
                 fi\n",
                git = wsl_transport::sh_quote(&format!("{child}/.git")),
                dir = wsl_transport::sh_quote(&child),
                name_b64 = encode_b64(dir),
            ));
        }
    }
    script.push_str("exit 0\n");
    script
}

/// `git status --porcelain -z -uall`（v1）→ (path, 首字符)。v1 的 rename
/// 记录后跟一条原路径记录。
fn parse_porcelain_v1(raw: &str) -> Vec<(String, char)> {
    let mut out = Vec::new();
    let mut records = raw.split('\0').filter(|r| !r.is_empty());
    while let Some(record) = records.next() {
        let bytes = record.as_bytes();
        if bytes.len() < 4 {
            continue;
        }
        let x = bytes[0] as char;
        let y = bytes[1] as char;
        let path = &record[3..];
        if x == 'R' || x == 'C' {
            // 下一条是原路径。
            let _ = records.next();
        }
        // 归一：`??` → '?'; 索引新增 → 'A'; 其余 → 'M'（与主机颜色规则等价：
        // INDEX_NEW/WT_NEW 是 untracked 色，其余是 modified 色）。
        let kind = if x == '?' || y == '?' {
            '?'
        } else if x == 'A' || y == 'A' {
            'A'
        } else {
            'M'
        };
        out.push((path.to_string(), kind));
    }
    out
}

pub(crate) fn parse_tree_output(raw: &str) -> Vec<LevelInfo> {
    let mut levels: Vec<LevelInfo> = Vec::new();
    let mut current: Option<LevelInfo> = None;
    let mut last_entries: Vec<(String, char)> = Vec::new();
    let mut last_branch = String::new();
    for line in raw.lines() {
        let line = line.trim_end();
        if line.starts_with("__CCGUI__LVL ") {
            if let Some(level) = current.take() {
                levels.push(level);
            }
            current = Some(LevelInfo::default());
            continue;
        }
        let Some(level) = current.as_mut() else {
            continue;
        };
        if let Some(b64) = line.strip_prefix("__CCGUI__ROOT ") {
            level.root = decode_b64(b64).unwrap_or_default();
        } else if line == "__CCGUI__REUSE" {
            level.reused = true;
            level.entries = last_entries.clone();
            level.branch = last_branch.clone();
        } else if let Some(b64) = line.strip_prefix("__CCGUI__STATUS ") {
            let decoded = decode_b64(b64).unwrap_or_default();
            level.entries = parse_porcelain_v1(&decoded);
            last_entries = level.entries.clone();
        } else if let Some(b64) = line.strip_prefix("__CCGUI__BRANCH ") {
            level.branch = decode_b64(b64).unwrap_or_default();
            last_branch = level.branch.clone();
        } else if let Some(rest) = line.strip_prefix("__CCGUI__NESTED ") {
            let mut parts = rest.split(' ');
            let (Some(name), Some(branch), Some(status)) =
                (parts.next(), parts.next(), parts.next())
            else {
                continue;
            };
            level.nested.push((
                decode_b64(name).unwrap_or_default(),
                decode_b64(branch).unwrap_or_default(),
                parse_porcelain_v1(&decode_b64(status).unwrap_or_default()),
            ));
        }
    }
    if let Some(level) = current.take() {
        levels.push(level);
    }
    levels
}

/// 一个目录下的颜色映射：直接命中的文件/目录 + 父目录传播 + 仓库蓝标。
/// 规则与主机 `file_tree_colors_cached` 一致（modified 优先于 untracked）。
fn colors_for_level(
    level: &LevelInfo,
    level_linux: &str,
    files: &[String],
) -> HashMap<String, String> {
    let mut out: HashMap<String, String> = HashMap::new();
    let file_set: std::collections::HashSet<&str> = files.iter().map(String::as_str).collect();
    if !level.root.is_empty() {
        let prefix = level_linux
            .strip_prefix(level.root.as_str())
            .unwrap_or("")
            .trim_matches('/')
            .to_string();
        let with_prefix = if prefix.is_empty() {
            None
        } else {
            Some(format!("{prefix}/"))
        };
        for (raw_path, kind) in &level.entries {
            let rel = match &with_prefix {
                Some(p) => match raw_path.strip_prefix(p.as_str()) {
                    Some(r) => r,
                    None => continue,
                },
                None => raw_path.as_str(),
            };
            let color = if *kind == '?' || *kind == 'A' {
                "untracked"
            } else {
                "modified"
            };
            if file_set.contains(rel) {
                out.insert(rel.to_string(), color.to_string());
            }
            // 父目录传播：modified 优先。
            let mut dir = std::path::Path::new(rel);
            while let Some(parent) = dir.parent() {
                if parent.as_os_str().is_empty() {
                    break;
                }
                let key = parent.to_string_lossy().into_owned();
                if file_set.contains(key.as_str()) {
                    let next = match out.get(&key).map(String::as_str) {
                        Some("modified") => "modified",
                        _ => color,
                    };
                    out.insert(key, next.to_string());
                }
                dir = parent;
            }
        }
    }
    for (name, _, _) in &level.nested {
        out.insert(name.clone(), "repository".to_string());
    }
    out
}

fn summarize_entries(entries: &[(String, char)]) -> (usize, usize) {
    let mut changed = std::collections::HashSet::new();
    let mut untracked = std::collections::HashSet::new();
    for (path, kind) in entries {
        if *kind == '?' {
            untracked.insert(path.clone());
        } else {
            changed.insert(path.clone());
        }
    }
    (changed.len(), untracked.len())
}

/// 第一个 WSL level 的 UNC（主机路径跳过）。混合列表里首项可能是主机路径。
pub(crate) fn first_wsl_unc(levels: &[GitTreeLevel]) -> Option<WslUncPath> {
    levels
        .iter()
        .find_map(|level| crate::engine::wsl_path::parse_wsl_unc(&level.path))
}

pub async fn tree_status(levels: Vec<GitTreeLevel>) -> Result<GitTreeStatus, String> {
    // UNC → Linux 路径；无法解析的 level 保持空结果（与主机失败时的空映射一致）。
    let mut prepared: Vec<(String, Vec<String>)> = Vec::new();
    for level in &levels {
        let linux = crate::engine::wsl_path::parse_wsl_unc(&level.path)
            .map(|unc| unc.linux_path)
            .unwrap_or_default();
        prepared.push((linux, level.directories.clone()));
    }
    let mut result = GitTreeStatus::default();
    if prepared.is_empty() {
        return Ok(result);
    }
    // 用**第一个 WSL level** 的发行版：首项可能是主机路径（混合列表），
    // 取错发行版会让整批装饰静默为空。
    let Some(unc) = first_wsl_unc(&levels) else {
        return Ok(result);
    };
    let raw = run(&unc, &tree_script(&prepared)).await?;
    let infos = parse_tree_output(&raw);
    for (index, (level_linux, _)) in prepared.iter().enumerate() {
        let Some(info) = infos.get(index) else {
            continue;
        };
        let files: Vec<String> = levels[index]
            .files
            .iter()
            .filter(|name| !name.starts_with('.'))
            .cloned()
            .collect();
        let colors = colors_for_level(info, level_linux, &files);
        result
            .file_colors
            .insert(levels[index].path.clone(), colors);
        // 仓库摘要：level 自身是仓库根、以及直接子目录里的嵌套仓库。
        if !info.root.is_empty() && info.root.trim_end_matches('/') == level_linux.trim_end_matches('/') {
            let (changed, untracked) = summarize_entries(&info.entries);
            result.repositories.push(RepositorySummary {
                path: levels[index].path.clone(),
                branch: if info.branch.is_empty() {
                    "HEAD".to_string()
                } else {
                    info.branch.clone()
                },
                changed,
                untracked,
            });
        }
        for (name, branch, entries) in &info.nested {
            let (changed, untracked) = summarize_entries(entries);
            result.repositories.push(RepositorySummary {
                path: format!(
                    "{}{}{}",
                    levels[index].path.trim_end_matches(['\\', '/']),
                    if levels[index].path.contains('\\') { "\\" } else { "/" },
                    name
                ),
                branch: if branch.is_empty() {
                    "HEAD".to_string()
                } else {
                    branch.clone()
                },
                changed,
                untracked,
            });
        }
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_v2_status_buckets_and_headers() {
        let raw = "# branch.oid abc\0# branch.head main\0# branch.upstream origin/main\0# branch.ab +2 -3\0\
                   1 .M N... 100644 100644 100644 a b a.txt\0\
                   1 A. N... 000000 100644 100644 0 c c.txt\0\
                   2 R. N... 100644 100644 100644 d d R100 d.txt\0b.txt\0\
                   ? u.txt\0";
        let parsed = parse_status_v2(raw);
        assert_eq!(parsed.branch, "main");
        assert_eq!(parsed.ahead, Some(2));
        assert_eq!(parsed.behind, Some(3));
        assert_eq!(parsed.records.len(), 4);
        assert_eq!(parsed.records[0].path, "a.txt");
        assert_eq!((parsed.records[0].x, parsed.records[0].y), ('.', 'M'));
        assert_eq!(parsed.records[2].path, "d.txt");
        assert_eq!(parsed.records[3].path, "u.txt");
    }

    #[test]
    fn detached_head_and_missing_upstream() {
        let raw = "# branch.head (detached)\0";
        let parsed = parse_status_v2(raw);
        assert_eq!(parsed.branch, "HEAD");
        assert_eq!(parsed.ahead, None);
    }

    #[test]
    fn buckets_and_label_precedence() {
        let records = vec![
            StatusRecord { path: "a".into(), x: 'M', y: 'D' },
            StatusRecord { path: "b".into(), x: 'A', y: '.' },
            StatusRecord { path: "c".into(), x: '?', y: '?' },
        ];
        let (staged, unstaged, untracked) = collect_records(&records);
        assert_eq!(staged.len(), 2);
        assert_eq!(unstaged.len(), 1);
        assert_eq!(unstaged[0].status, "deleted");
        assert_eq!(staged[1].status, "added");
        assert_eq!(untracked.len(), 1);
        assert_eq!(untracked[0].status, "added");
    }

    #[test]
    fn parses_numstat_regular_rename_and_binary() {
        // 普通 / 二进制 / rename（空路径后跟 old、new）
        let raw = "5\t2\tsrc/a.rs\0-\t-\timg.png\00\t0\t\0old.txt\0new.txt\0";
        let stats = parse_numstat(raw);
        assert_eq!(stats.get("src/a.rs"), Some(&(5, 2)));
        assert_eq!(stats.get("img.png"), Some(&(0, 0)));
        assert_eq!(stats.get("new.txt"), Some(&(0, 0)));
        assert!(!stats.contains_key("old.txt"));
    }

    #[test]
    fn builds_status_from_sentinels() {
        use base64::Engine as _;
        let enc = |t: &str| base64::engine::general_purpose::STANDARD.encode(t);
        let raw = format!(
            "{SENT_STATUS}{}\n{SENT_CACHED}{}\n{SENT_WORK}{}\n{SENT_UNTRACKED}{} 7\n",
            enc("# branch.head main\0# branch.ab +1 -0\0? new.txt\0"),
            enc("3\t0\tstaged.rs\0"),
            enc("1\t1\twork.rs\0"),
            enc("new.txt"),
        );
        let status = build_status(&raw);
        assert_eq!(status.branch, "main");
        assert_eq!(status.ahead, Some(1));
        assert_eq!(status.untracked.len(), 1);
        assert_eq!(status.untracked[0].additions, Some(7));
    }

    #[test]
    fn parses_branches_local_first_and_skips_symref() {
        let raw = "main\trefs/heads/main\t\nfeat\trefs/heads/feat\t\n\
                   origin/main\trefs/remotes/origin/main\t\n\
                   origin/HEAD\trefs/remotes/origin/HEAD\trefs/remotes/origin/main\n";
        let branches = parse_branches(raw);
        assert_eq!(
            branches
                .iter()
                .map(|b| (b.name.as_str(), b.is_remote))
                .collect::<Vec<_>>(),
            vec![("main", false), ("feat", false), ("origin/main", true)]
        );
    }

    #[test]
    fn parses_porcelain_v1_with_rename_and_untracked() {
        let raw = " M a.txt\0A  c.txt\0R  d.txt\0b.txt\0?? sub/x.txt\0";
        let entries = parse_porcelain_v1(raw);
        assert_eq!(
            entries,
            vec![
                ("a.txt".to_string(), 'M'),
                ("c.txt".to_string(), 'A'),
                ("d.txt".to_string(), 'M'),
                ("sub/x.txt".to_string(), '?'),
            ]
        );
    }

    #[test]
    fn tree_colors_propagate_and_mark_nested_repos() {
        let info = LevelInfo {
            root: "/repo".into(),
            entries: vec![
                ("src/deep/b.ts".to_string(), 'M'),
                ("src/a.ts".to_string(), 'M'),
                ("new.txt".to_string(), '?'),
            ],
            nested: vec![("nested".to_string(), "main".to_string(), Vec::new())],
            ..Default::default()
        };
        // 列出 `/repo/src`：直接命中的 a.ts、deep 目录传播（事件在 src/deep/b.ts）。
        let colors = colors_for_level(&info, "/repo/src", &["a.ts".into(), "deep".into()]);
        assert_eq!(colors.get("a.ts").map(String::as_str), Some("modified"));
        assert_eq!(colors.get("deep").map(String::as_str), Some("modified"));
        // 根层：new.txt 是 untracked，嵌套仓库显示蓝标。
        let colors = colors_for_level(
            &info,
            "/repo",
            &["new.txt".into(), "nested".into(), "src".into()],
        );
        assert_eq!(colors.get("new.txt").map(String::as_str), Some("untracked"));
        assert_eq!(colors.get("src").map(String::as_str), Some("modified"));
        assert_eq!(colors.get("nested").map(String::as_str), Some("repository"));
    }

    #[test]
    fn parses_tree_output_levels_and_reuse() {
        use base64::Engine as _;
        let enc = |t: &str| base64::engine::general_purpose::STANDARD.encode(t);
        let raw = format!(
            "__CCGUI__LVL 0\n__CCGUI__ROOT {}\n__CCGUI__STATUS {}\n__CCGUI__BRANCH {}\n\
             __CCGUI__LVL 1\n__CCGUI__ROOT {}\n__CCGUI__REUSE\n",
            enc("/repo"),
            enc(" M a.txt\0"),
            enc("main"),
            enc("/repo"),
        );
        let levels = parse_tree_output(&raw);
        assert_eq!(levels.len(), 2);
        assert_eq!(levels[0].root, "/repo");
        assert_eq!(levels[0].entries.len(), 1);
        assert!(levels[1].reused);
        assert_eq!(levels[1].entries.len(), 1);
    }

    #[test]
    fn status_script_quotes_and_always_exits_zero() {
        let script = status_script("/home/me/my repo");
        assert!(script.contains("cd -- '/home/me/my repo'"));
        assert!(script.contains("command -v git"));
        assert!(script.ends_with("exit 0\n"));
        // git 的 stderr 不进脚本错误通道：状态查询的失败由哨兵缺省体现。
        assert!(script.contains("__CCGUI__GIT_STATUS"));
    }

    #[test]
    fn repo_relative_paths_reject_traversal_and_absolute() {
        for bad in ["", ".", "..", "../x", "a/../b", "/etc/passwd", r"\abs", "a\0b"] {
            assert!(validate_repo_relative(bad).is_err(), "should reject {bad:?}");
        }
        for good in ["a.txt", "src/deep/b.ts", "中文 目录/a b.txt"] {
            assert!(validate_repo_relative(good).is_ok(), "should accept {good:?}");
        }
    }

    #[test]
    fn classify_reports_missing_cwd_distinctly() {
        let err = classify("__CCGUI__GIT_CWD\n", "/home/me/gone").unwrap_err();
        assert_eq!(err, "WSL_CWD_NOT_FOUND:/home/me/gone");
        assert_eq!(classify("__CCGUI__GIT_NOT_REPO\n", "/w").unwrap_err(), "NOT_A_REPO");
        assert_eq!(classify("__CCGUI__GIT_NO_GIT\n", "/w").unwrap_err(), "WSL_GIT_MISSING");
    }

    #[test]
    fn error_mapping_separates_auth() {
        assert!(map_git_error("Permission denied (publickey).").starts_with("WSL_GIT_AUTH_FAILED:"));
        assert!(map_git_error("fatal: not a git repository").starts_with("WSL_GIT_FAILED:"));
    }

    #[test]
    fn first_wsl_unc_skips_host_levels() {
        let levels = vec![
            GitTreeLevel { path: r"C:\repo".to_string(), files: vec![], directories: vec![] },
            GitTreeLevel {
                path: r"\\wsl.localhost\Ubuntu\home\me\repo".to_string(),
                files: vec![],
                directories: vec![],
            },
        ];
        let unc = first_wsl_unc(&levels).expect("finds WSL level");
        assert_eq!(unc.distro, "Ubuntu");
        assert_eq!(unc.linux_path, "/home/me/repo");
        assert!(first_wsl_unc(&levels[..1]).is_none());
    }
}

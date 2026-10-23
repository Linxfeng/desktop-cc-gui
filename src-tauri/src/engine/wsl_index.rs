//! WSL 工作区的文件索引 —— @-mention 与文件搜索的数据源。
//!
//! 为什么不复用 UNC 遍历:实机 V23 里同一仓库 UNC 完整遍历 1397 ms,发行版内
//! `rg --files` 75 ms,差一个数量级以上。输入 `@` 就要等 1 秒以上是不可接受
//! 的,所以本机 WSL 工作区改在发行版内跑 `rg`,结果形状与
//! [`crate::files::list_file_index`] 完全一致(工作区相对路径 + `isDir`)。
//!
//! 拿不到 `rg` 时**不**在这里静默降级:返回 [`RG_MISSING`],由调用方记一条
//! 通知并回落到 UNC 遍历 —— 慢但可用,同时提示用户安装 ripgrep。

use super::{wsl_path::WslUncPath, wsl_transport};
use crate::files::FileIndexEntry;

/// 发行版内没有 `rg` 的稳定标记(没有调用 `wsl.exe`,只是脚本退出码 127)。
pub const RG_MISSING: &str = "WSL_RG_MISSING";

/// 行前缀。`run_script_output` 会剥掉 `wsl:` 开头的传输层噪声行;给每条
/// 文件名加一个哨兵前缀,既避免与噪声混淆,也避免文件名恰好以 `wsl.` 开头
/// 时被误删。
const LINE_PREFIX: &str = "__CCGUI__F ";

/// 发行版内没有 `rg` 时脚本打印的标记(写 stderr,随非零退出上抛)。
const NO_RG_MARK: &str = "__CCGUI__NO_RG";

/// 列表脚本。cwd 用 `cd --`(V6:`--cd` 失败会静默落到 `/`)。
///
/// 默认参数与 `ignore::WalkBuilder` 的既有语义对齐:跳过隐藏文件、遵守
/// `.gitignore`。`include_ignored` 打开全部过滤,但仍排除 node_modules /
/// target / __pycache__ / .git —— 与本地遍历的硬编码 prune 一致。
pub(crate) fn list_script(workspace: &str, include_ignored: bool) -> String {
    let quoted = wsl_transport::sh_quote(workspace);
    let flags = if include_ignored {
        "--no-ignore --hidden \
         --glob '!.git/**' --glob '!node_modules/**' --glob '!target/**' --glob '!__pycache__/**'"
    } else {
        ""
    };
    format!(
        // pipefail:否则 `rc=$?` 取的是 sed 的状态,rg 失败会被当成成功,
        // `@` 列表静默缺文件(§10 P1-13)。
        "set -o pipefail\n\
         cd -- {quoted} || exit 61\n\
         command -v rg >/dev/null 2>&1 || {{ echo '{NO_RG_MARK}' >&2; exit 127; }}\n\
         rg --files --no-messages {flags} | sed 's/^/{LINE_PREFIX}/'\n\
         rc=$?\n\
         [ \"$rc\" -le 1 ] || exit \"$rc\"\n\
         exit 0"
    )
}

/// 跑一次发行版内 `rg --files`。传输用缓存里的探测结果(有 PATH 才带上):
/// 这里**不**触发 2.4s 的冷探测 —— 索引是输入框的即时反馈,首次 `@` 不该
/// 等它;`rg` 通常就在默认 PATH 的 `/usr/bin` 下。
pub async fn list_files(
    unc: &WslUncPath,
    include_ignored: bool,
) -> Result<Vec<FileIndexEntry>, String> {
    let transport = wsl_transport::local_transport(unc);
    let script = list_script(&unc.linux_path, include_ignored);
    match wsl_transport::run_script_output(&transport, &script).await {
        Ok(raw) => Ok(parse_entries(&raw, crate::files::MAX_INDEX_ENTRIES)),
        Err(error) if error.contains(NO_RG_MARK) => Err(RG_MISSING.to_string()),
        Err(error) => Err(error),
    }
}

/// 解析 `rg --files` 输出并补齐目录项(纯函数)。
///
/// `rg` 只列文件,而既有索引同时包含目录(@-mention 里 `@src/` 这类前缀很
/// 常用)。目录由文件路径的各级父目录合成 —— 空目录不会出现,但对输入框
/// 而言没有可提及的内容,可接受。
pub(crate) fn parse_entries(raw: &str, cap: usize) -> Vec<FileIndexEntry> {
    let mut files: Vec<String> = Vec::new();
    let mut dirs: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
    for line in raw.lines() {
        let Some(rel) = line.strip_prefix(LINE_PREFIX) else {
            continue;
        };
        let rel = rel.trim_end_matches('\r');
        if rel.is_empty()
            || rel.starts_with('/')
            || rel.contains('\0')
            || rel.split('/').any(|seg| seg == "..")
        {
            continue;
        }
        let rel = rel.trim_end_matches('/');
        if rel.is_empty() {
            continue;
        }
        let mut end = rel.len();
        while let Some(slash) = rel[..end].rfind('/') {
            dirs.insert(rel[..slash].to_string());
            end = slash;
        }
        files.push(rel.to_string());
        if files.len() >= cap {
            break;
        }
    }
    files.sort();
    let mut out: Vec<FileIndexEntry> = Vec::with_capacity(files.len() + dirs.len());
    out.extend(dirs.into_iter().map(|rel| FileIndexEntry { rel, is_dir: true }));
    out.extend(files.into_iter().map(|rel| FileIndexEntry {
        rel,
        is_dir: false,
    }));
    out.truncate(cap);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_files_and_synthesizes_parent_dirs() {
        let raw = "__CCGUI__F src/a.ts\n__CCGUI__F src/deep/b.ts\n__CCGUI__F README.md\n";
        let entries = parse_entries(raw, 100);
        let rels: Vec<(&str, bool)> = entries
            .iter()
            .map(|e| (e.rel.as_str(), e.is_dir))
            .collect();
        assert!(rels.contains(&("src", true)));
        assert!(rels.contains(&("src/deep", true)));
        assert!(rels.contains(&("src/a.ts", false)));
        assert!(rels.contains(&("README.md", false)));
        // 目录只出现一次,且不把文件当目录。
        assert_eq!(rels.iter().filter(|(r, _)| *r == "src").count(), 1);
    }

    #[test]
    fn ignores_transport_noise_and_rejects_escaping_paths() {
        let raw = "wsl: 本地化提示\n\
                   random output\n\
                   __CCGUI__F ../escape.ts\n\
                   __CCGUI__F /abs/path.ts\n\
                   __CCGUI__F ok/file.ts\n";
        let entries = parse_entries(raw, 100);
        let files: Vec<&str> = entries
            .iter()
            .filter(|e| !e.is_dir)
            .map(|e| e.rel.as_str())
            .collect();
        assert_eq!(files, vec!["ok/file.ts"]);
        assert!(entries.iter().all(|e| !e.rel.starts_with("..")));
    }

    #[test]
    fn caps_entries_at_the_index_limit() {
        let raw: String = (0..50)
            .map(|i| format!("__CCGUI__F f{i}.txt\n"))
            .collect();
        assert_eq!(parse_entries(&raw, 10).len(), 10);
    }

    #[test]
    fn script_cds_before_running_and_quotes_the_workspace() {
        let script = list_script("/home/me/my repo", false);
        // 首行是 pipefail(§10 P1-13),`cd` 紧随其后。
        assert!(script.starts_with("set -o pipefail\ncd -- '/home/me/my repo' || exit 61\n"));
        assert!(script.contains("command -v rg"));
        // include_ignored 关掉过滤,但仍排除构建产物与 .git。
        let all = list_script("/w", true);
        assert!(all.contains("--no-ignore --hidden"));
        assert!(all.contains("!node_modules/**"));
        assert!(all.contains("!target/**"));
    }
}

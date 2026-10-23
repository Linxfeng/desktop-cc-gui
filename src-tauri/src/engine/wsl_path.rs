//! WSL UNC 路径解析 —— 本机 WSL 工作区的标识层。
//!
//! 系统文件夹选择器对 WSL 目录返回 `\\wsl.localhost\<distro>\<linux path>`
//! (旧别名 `\\wsl$\…`);`canonicalize` 之后还会带上 `\\?\UNC\` 前缀
//! (实机 V18)。本模块把这些拼写统一成一个工作区标识,供
//! [`super::wsl_transport`] 选择本机 `wsl.exe` 后端,并让已授权目录 /
//! Claude 项目目录匹配在 UNC 下继续工作。
//!
//! 纯函数、跨平台可测:只有真正调用 `wsl.exe` 的地方才 `#[cfg(windows)]`,
//! 因此 `cargo test wsl_path` 可以在任意 CI 平台上跑。

/// 一个 WSL 工作区标识:发行版名 + 发行版内绝对路径。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WslUncPath {
    pub distro: String,
    /// 发行版内绝对路径,`/` 分隔、无尾部斜杠(根为 `/`)。
    pub linux_path: String,
}

/// WSL 的 UNC 主机名(大小写不敏感)。`wsl$` 是旧别名,与新名等价。
const WSL_HOSTS: [&str; 2] = ["wsl.localhost", "wsl$"];

/// 发行版名:会被拼进 `wsl.exe -d <distro>` 的 argv 与 pidfile 名。只放行
/// 字母数字与 `._- `(与 `wsl_transport` 旧白名单一致);这是纵深防御 ——
/// `wsl.exe` 收到的是独立 argv 元素,不经 shell。
pub(crate) fn is_safe_distro(distro: &str) -> bool {
    !distro.is_empty()
        // `.` / `..` 会经 `to_wsl_unc` 拼出带路径段的 UNC(写启动器/删缓存),
        // 纯空格同样不是合法发行版名(§10 P2-1)。
        && distro.trim() == distro
        && distro != "."
        && distro != ".."
        && distro
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-' | ' '))
}

/// 大小写不敏感地剥掉 `\\?\UNC\` 前缀(Windows canonicalize 的产物)。
fn strip_verbatim_unc(path: &str) -> Option<&str> {
    const PREFIX: &str = r"\\?\UNC\";
    let head = path.get(..PREFIX.len())?;
    head.eq_ignore_ascii_case(PREFIX)
        .then(|| path.get(PREFIX.len()..))
        .flatten()
}

fn is_wsl_host(host: &str) -> bool {
    WSL_HOSTS.iter().any(|h| host.eq_ignore_ascii_case(h))
}

/// 解析 WSL UNC 路径。接受 `\\wsl.localhost\D\a`、`\\wsl$\D\a`、
/// `//wsl.localhost/D/a`、`\\?\UNC\wsl.localhost\D\a`、`\\?\UNC\wsl$\D\a`
/// (实机 V18);主机名大小写不敏感。
///
/// 拒绝:非 WSL 主机的 UNC、空发行版名、发行版名不过 [`is_safe_distro`]、
/// 含 `..` 段的路径(拼脚本/拼接时逃逸)、含 NUL。
///
/// Linux 路径本身不限字符集:本机后端经 `--exec` 的 argv 传 cwd(V1 实测
/// 空格、引号、中文、emoji 均逐字到达),不需要 shell 白名单。
pub fn parse_wsl_unc(path: &str) -> Option<WslUncPath> {
    let trimmed = path.trim();
    if trimmed.is_empty() || trimmed.contains('\0') {
        return None;
    }
    // `\\?\UNC\server\share` 剥前缀后只剩 `server\share` —— 前面的 `\\`
    // 编码在 `UNC` 里,补回来才和普通 UNC 同形。
    let rest = match strip_verbatim_unc(trimmed) {
        Some(tail) => std::borrow::Cow::Owned(format!(r"\\{tail}")),
        None => std::borrow::Cow::Borrowed(trimmed),
    };
    // 两种分隔符混写也接受;统一成正斜杠后按 UNC 形状切分。
    let unified = rest.replace('\\', "/");
    let after_slashes = unified.strip_prefix("//")?;
    let mut host_and_tail = after_slashes.splitn(2, '/');
    let host = host_and_tail.next()?;
    if !is_wsl_host(host) {
        return None;
    }
    let tail = host_and_tail.next().unwrap_or("");
    let mut distro_and_path = tail.splitn(2, '/');
    let distro = distro_and_path.next().unwrap_or("").trim();
    if !is_safe_distro(distro) {
        return None;
    }
    let linux_tail = distro_and_path.next().unwrap_or("");
    // `..` 段在 Linux 侧会被 `cd` 解释,而工作区标识要能与会话 cwd 比较,
    // 不做归一化就只能靠调用方猜 —— 直接拒绝,让用户用规范路径重选。
    if linux_tail.split('/').any(|seg| seg == "..") {
        return None;
    }
    let trimmed_tail = linux_tail.trim_matches('/');
    let linux_path = if trimmed_tail.is_empty() {
        "/".to_string()
    } else {
        format!("/{trimmed_tail}")
    };
    Some(WslUncPath {
        distro: distro.to_string(),
        linux_path,
    })
}

/// 统一成 `\\wsl.localhost\<规范发行版名>\…`:`known_distros`(来自
/// `wsl.exe -l -q`)非空时按大小写不敏感匹配,未命中返回 `None`(发行版
/// 已卸载/拼错,不静默造一个不存在的标识);为空(查询失败或尚未探测)时
/// 保留输入拼写。
pub fn normalize_wsl_unc(path: &str, known_distros: &[String]) -> Option<String> {
    let parsed = parse_wsl_unc(path)?;
    let distro = if known_distros.is_empty() {
        parsed.distro
    } else {
        known_distros
            .iter()
            .find(|d| d.eq_ignore_ascii_case(&parsed.distro))?
            .clone()
    };
    Some(to_wsl_unc(&distro, &parsed.linux_path))
}

/// Linux 路径 → UNC(会话 cwd 映射回工作区)。
pub fn to_wsl_unc(distro: &str, linux_path: &str) -> String {
    let trimmed = linux_path.trim_matches('/');
    if trimmed.is_empty() {
        format!(r"\\wsl.localhost\{distro}")
    } else {
        let windows_tail = trimmed.replace('/', r"\");
        format!(r"\\wsl.localhost\{distro}\{windows_tail}")
    }
}

/// 工作区路径是否为 WSL UNC(不做发行版存在性校验,只做形状判断)。
pub fn is_wsl_unc(path: &str) -> bool {
    parse_wsl_unc(path).is_some()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parsed(path: &str) -> (String, String) {
        let p = parse_wsl_unc(path).expect("should parse");
        (p.distro, p.linux_path)
    }

    #[test]
    fn accepts_both_hosts_and_both_separators() {
        for path in [
            r"\\wsl.localhost\Ubuntu\home\me\repo",
            r"\\wsl$\Ubuntu\home\me\repo",
            "//wsl.localhost/Ubuntu/home/me/repo",
            "//wsl$/Ubuntu/home/me/repo",
            r"\\WSL.LOCALHOST\Ubuntu\home\me\repo",
        ] {
            assert_eq!(
                parsed(path),
                ("Ubuntu".to_string(), "/home/me/repo".to_string()),
                "path: {path}"
            );
        }
    }

    #[test]
    fn accepts_verbatim_unc_prefix() {
        for path in [
            r"\\?\UNC\wsl.localhost\Ubuntu\home\me\repo",
            r"\\?\UNC\wsl$\Ubuntu\home\me\repo",
            r"\\?\unc\wsl.localhost\Ubuntu\home\me\repo",
        ] {
            assert_eq!(
                parsed(path),
                ("Ubuntu".to_string(), "/home/me/repo".to_string()),
                "path: {path}"
            );
        }
    }

    #[test]
    fn rejects_foreign_unc_and_bad_shapes() {
        for path in [
            r"\\server\share\repo",
            r"\\wsl.localhost\\home\me",
            r"\\wsl.localhost",
            "",
            "C:/Users/me/repo",
            r"\\wsl.localhost\Ubuntu$(id)\home",
            r"\\wsl.localhost\Ubuntu\home\..\etc",
        ] {
            assert!(parse_wsl_unc(path).is_none(), "path: {path}");
        }
    }

    #[test]
    fn keeps_trailing_slash_and_root_canonical() {
        assert_eq!(parsed(r"\\wsl.localhost\Ubuntu\home\me\repo\").1, "/home/me/repo");
        assert_eq!(parsed(r"\\wsl.localhost\Ubuntu").1, "/");
        assert_eq!(parsed(r"\\wsl.localhost\Ubuntu\").1, "/");
    }

    #[test]
    fn keeps_non_ascii_workspace_paths() {
        // V7:发行版内中文/空格目录正常;路径经 argv 传递,不受 shell 白名单限制
        assert_eq!(
            parsed(r"\\wsl.localhost\Ubuntu\home\me\项目 目录").1,
            "/home/me/项目 目录"
        );
    }

    #[test]
    fn normalizes_to_canonical_distro_spelling() {
        let known = vec!["Ubuntu-24.04".to_string(), "Debian".to_string()];
        assert_eq!(
            normalize_wsl_unc(r"\\wsl$\ubuntu-24.04\home\me\repo", &known).as_deref(),
            Some(r"\\wsl.localhost\Ubuntu-24.04\home\me\repo")
        );
        // 未知发行版:不造标识
        assert!(normalize_wsl_unc(r"\\wsl$\Ghost\home", &known).is_none());
        // 尚未探测:保留输入拼写
        assert_eq!(
            normalize_wsl_unc(r"\\wsl$\ubuntu\home", &[]).as_deref(),
            Some(r"\\wsl.localhost\ubuntu\home")
        );
    }

    #[test]
    fn linux_path_round_trips_through_unc() {
        let unc = to_wsl_unc("Ubuntu", "/home/me/repo");
        assert_eq!(unc, r"\\wsl.localhost\Ubuntu\home\me\repo");
        assert_eq!(
            parse_wsl_unc(&unc),
            Some(WslUncPath {
                distro: "Ubuntu".into(),
                linux_path: "/home/me/repo".into(),
            })
        );
        assert_eq!(to_wsl_unc("Ubuntu", "/"), r"\\wsl.localhost\Ubuntu");
        assert_eq!(to_wsl_unc("Ubuntu", "/home/me/"), r"\\wsl.localhost\Ubuntu\home\me");
    }

    #[test]
    fn is_wsl_unc_matches_parse() {
        assert!(is_wsl_unc(r"\\wsl.localhost\Ubuntu\home"));
        assert!(!is_wsl_unc(r"\\server\share"));
        assert!(!is_wsl_unc("/home/me"));
    }
}

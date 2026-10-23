//! WSL 发行版内 CLI 探测与缓存 —— 本机 WSL 后端的"发行版内事实"来源。
//!
//! 探测为什么不能省:
//! - 裸命令名不可用:实测 `wsl.exe --exec claude` 在 nvm 环境下失败
//!   (`execvpe(claude) failed`,退出码 1 而不是 127,V2);
//! - 非登录 PATH 不含 nvm/`~/.local/bin`:nvm 的注入写在 `.bashrc` 的
//!   "非交互直接返回"判断之后(V3、V4),所以用 `bash -lc` 也探不到;
//! - 必须用 `bash -ic`,并过滤 `/mnt/…` 下的 Windows 同名程序 —— 用户
//!   Windows 侧装了 codex 时会解析到 `/mnt/c/Users/.../codex`(V4)。
//!
//! 一次探测约 2.4s(V5),结果按发行版缓存在进程内;命中缓存时不产生任何
//! `wsl.exe` 调用。

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

/// 缓存有效期:CLI 被卸载/改路径后最多这么久重新探测一次。用户也可以经
/// 设置页的"重新检测"立即失效。
const PROBE_TTL: Duration = Duration::from_secs(5 * 60);

/// 探测/发行版启动的全局 deadline(冷启动发行版可能十几秒)。
const PROBE_TIMEOUT: Duration = Duration::from_secs(30);

/// 单次探测的结果。
#[derive(Debug, Clone)]
pub struct WslProbe {
    pub home: String,
    /// 交互登录 shell 的 PATH(含 nvm、`~/.local/bin`),经 `CCGUI_WSL_PATH`
    /// 传给启动器与短调用脚本。
    pub path: String,
    /// `$CODEX_HOME`(未设置时为空,脚本侧回退 `$HOME/.codex`)。
    pub codex_home: String,
    /// `$CLAUDE_CONFIG_DIR`(未设置时为空,脚本侧回退 `$HOME/.claude`)。
    /// 历史扫描、回放授权与 CLI 必须看同一个目录(§10 P2-7)。
    pub claude_home: String,
    /// 发行版内核标识(`/proc/sys/kernel/osrelease`)。用于显式拒绝 WSL1:
    /// WSL1 没有真实 Linux 会话,进程回收与 UNC 语义都不同(§10 D7)。
    pub kernel: String,
    /// `$KIMI_CODE_HOME`(未设置时为空,脚本侧回退 `$HOME/.kimi-code`)。
    pub kimi_home: String,
    /// `$PI_CODING_AGENT_DIR`(未设置时为空,脚本侧回退 `$HOME/.pi/agent`)。
    pub pi_agent_dir: String,
    /// 命令名 → 发行版内绝对路径(已过滤 `/mnt/` 下的 Windows 程序)。
    pub bins: BTreeMap<String, String>,
    /// 命令名 → `--version` 的第一行(已规整成版本号;取不到的没有条目)。
    /// 只用于设置页展示,发送路径不消费。
    pub versions: BTreeMap<String, String>,
    probed_at: Instant,
}

impl WslProbe {
    pub fn bin(&self, name: &str) -> Option<&str> {
        self.bins.get(name).map(String::as_str)
    }

    fn is_fresh(&self) -> bool {
        self.probed_at.elapsed() < PROBE_TTL
    }
}

/// 探测失败的分类(错误串前缀稳定,前端按前缀映射 i18n)。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProbeError {
    /// 本机没有 `%SystemRoot%\System32\wsl.exe`。
    WslNotInstalled,
    /// `wsl.exe` 报告发行版不存在(`WSL_E_DISTRO_NOT_FOUND`,V15)。
    DistroNotFound,
    /// 探测/启动超过 [`PROBE_TIMEOUT`](冷启动也可能如此,提示用户重试)。
    StartTimeout,
    /// 其他失败(发行版起不来、bash 不可用、输出无法解析)。
    Failed(String),
}

impl ProbeError {
    /// 稳定的错误标记:前端 `errorText` 按前缀替换成 i18n 文案。
    pub fn code(&self) -> String {
        match self {
            ProbeError::WslNotInstalled => "WSL_NOT_INSTALLED".to_string(),
            ProbeError::DistroNotFound => "WSL_DISTRO_NOT_FOUND".to_string(),
            ProbeError::StartTimeout => "WSL_START_TIMEOUT".to_string(),
            ProbeError::Failed(detail) => format!("WSL_PROBE_FAILED:{detail}"),
        }
    }
}

impl std::fmt::Display for ProbeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // 兜底文案(前端会优先按 code 前缀本地化);保留可诊断的上下文。
        match self {
            ProbeError::WslNotInstalled => write!(f, "WSL 未安装:找不到 wsl.exe"),
            ProbeError::DistroNotFound => write!(f, "WSL 发行版不存在"),
            ProbeError::StartTimeout => write!(
                f,
                "WSL 发行版启动超时({}s)",
                PROBE_TIMEOUT.as_secs()
            ),
            ProbeError::Failed(detail) => write!(f, "WSL 发行版探测失败: {detail}"),
        }
    }
}

fn cache() -> &'static Mutex<BTreeMap<String, Arc<WslProbe>>> {
    static CACHE: OnceLock<Mutex<BTreeMap<String, Arc<WslProbe>>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(BTreeMap::new()))
}

/// 失败结果短缓存:发行版关停时并发调用不该反复付 30s 超时(§10 P1-17)。
fn negative_cache() -> &'static Mutex<BTreeMap<String, (ProbeError, Instant)>> {
    static NEGATIVE: OnceLock<Mutex<BTreeMap<String, (ProbeError, Instant)>>> =
        OnceLock::new();
    NEGATIVE.get_or_init(|| Mutex::new(BTreeMap::new()))
}

/// 同一发行版同时只允许一次探测:发送、可用性、会话列表、设置页会并发调用。
fn inflight() -> &'static Mutex<BTreeMap<String, Arc<tokio::sync::Mutex<()>>>> {
    static INFLIGHT: OnceLock<Mutex<BTreeMap<String, Arc<tokio::sync::Mutex<()>>>>> =
        OnceLock::new();
    INFLIGHT.get_or_init(|| Mutex::new(BTreeMap::new()))
}

const NEGATIVE_TTL: std::time::Duration = std::time::Duration::from_secs(10);

/// 缓存命中的探测结果(同步,供 [`super::wsl_transport`] 构造传输描述)。
/// 过期条目仍在:调用方拿到旧值先跑,后台/下一次 ensure 会刷新 —— 与
/// "探测未完成阻塞发送"的设计相比,宁可让用户先发出去。
pub fn cached(distro: &str) -> Option<Arc<WslProbe>> {
    cache().lock().ok()?.get(distro).cloned()
}

/// 当前缓存距上次探测的时长(发送前预检据此决定是否值得再跑一次短调用)。
pub fn probe_age(distro: &str) -> Option<std::time::Duration> {
    cached(distro).map(|probe| probe.probed_at.elapsed())
}

/// 丢弃某发行版的缓存(设置页"重新检测"、启动器 127/126 后重试)。
pub fn invalidate(distro: &str) {
    if let Ok(mut map) = cache().lock() {
        map.remove(distro);
    }
    if let Ok(mut map) = negative_cache().lock() {
        map.remove(distro);
    }
}

/// 探测脚本。只输出 `__CCGUI__` 哨兵行,profile/motd 的噪声一律丢弃。
///
/// `type -ap` 逐个列出候选(含 alias/function 之外的路径),第一个不在
/// `/mnt/` 下的即可用项胜出;用 `while read` 而不是 `$(…)` 迭代,带空格的
/// 路径不会被拆开。
pub const PROBE_SCRIPT: &str = r#"printf '\n__CCGUI__HOME=%s\n__CCGUI__PATH=%s\n__CCGUI__CODEX_HOME=%s\n__CCGUI__CLAUDE_HOME=%s\n__CCGUI__KIMI_HOME=%s\n__CCGUI__PI_AGENT_DIR=%s\n__CCGUI__KERNEL=%s\n' "$HOME" "$PATH" "${CODEX_HOME:-}" "${CLAUDE_CONFIG_DIR:-}" "${KIMI_CODE_HOME:-}" "${PI_CODING_AGENT_DIR:-}" "$(cat /proc/sys/kernel/osrelease 2>/dev/null)"
for c in claude codex kimi grok mcode pi rg git; do
  type -ap "$c" 2>/dev/null | while IFS= read -r p; do
    case "$p" in /mnt/*) continue ;; esac
    printf '__CCGUI__BIN %s=%s\n' "$c" "$p"
    case "$c" in
      rg|git) ;;
      *)
        v=$(timeout 3 "$p" --version 2>/dev/null | head -n 1)
        if [ -n "$v" ]; then printf '__CCGUI__VER %s=%s\n' "$c" "$v"; fi
        ;;
    esac
    break
  done
done"#;

/// 解析探测脚本的输出(纯函数,便于用 V4/V5 的真实噪声做单测)。
///
/// 接受任意前置噪声(登录脚本的 `echo hello`、motd、nvm 提示),只认
/// `__CCGUI__HOME=`、`__CCGUI__PATH=`、`__CCGUI__CODEX_HOME=` 与
/// `__CCGUI__BIN <name>=<path>`。同一命令名以**首次**出现为准。
pub fn parse_probe_output(raw: &str) -> Result<WslProbe, String> {
    let mut home = None;
    let mut path = None;
    let mut codex_home = String::new();
    let mut claude_home = String::new();
    let mut kimi_home = String::new();
    let mut pi_agent_dir = String::new();
    let mut kernel = String::new();
    let mut bins = BTreeMap::new();
    let mut versions = BTreeMap::new();
    for line in raw.lines() {
        let line = line.trim_end_matches('\r');
        if let Some(rest) = line.strip_prefix("__CCGUI__HOME=") {
            home = Some(rest.to_string());
        } else if let Some(rest) = line.strip_prefix("__CCGUI__PATH=") {
            path = Some(rest.to_string());
        } else if let Some(rest) = line.strip_prefix("__CCGUI__CODEX_HOME=") {
            codex_home = rest.to_string();
        } else if let Some(rest) = line.strip_prefix("__CCGUI__CLAUDE_HOME=") {
            claude_home = rest.to_string();
        } else if let Some(rest) = line.strip_prefix("__CCGUI__KIMI_HOME=") {
            kimi_home = rest.to_string();
        } else if let Some(rest) = line.strip_prefix("__CCGUI__PI_AGENT_DIR=") {
            pi_agent_dir = rest.to_string();
        } else if let Some(rest) = line.strip_prefix("__CCGUI__KERNEL=") {
            kernel = rest.to_string();
        } else if let Some(rest) = line.strip_prefix("__CCGUI__BIN ") {
            let Some((name, value)) = rest.split_once('=') else {
                continue;
            };
            let (name, value) = (name.trim(), value.trim());
            if name.is_empty() || !value.starts_with('/') || value.starts_with("/mnt/") {
                continue;
            }
            bins.entry(name.to_string()).or_insert_with(|| value.to_string());
        } else if let Some(rest) = line.strip_prefix("__CCGUI__VER ") {
            let Some((name, value)) = rest.split_once('=') else {
                continue;
            };
            let name = name.trim();
            let version = normalize_version(value);
            if !name.is_empty() && !version.is_empty() {
                versions.entry(name.to_string()).or_insert(version);
            }
        }
    }
    let home = home.filter(|h| !h.trim().is_empty()).ok_or_else(|| {
        // 哨兵行缺失 = 脚本没跑起来(发行版启动失败 / bash 不可用)。
        format!("发行版内探测脚本没有输出(原始输出前 200 字: {})", truncate(raw, 200))
    })?;
    let path = path.filter(|p| !p.trim().is_empty()).ok_or_else(|| {
        format!("发行版内 PATH 为空(原始输出前 200 字: {})", truncate(raw, 200))
    })?;
    Ok(WslProbe {
        home,
        path,
        codex_home,
        claude_home,
        kernel,
        kimi_home,
        pi_agent_dir,
        bins,
        versions,
        probed_at: Instant::now(),
    })
}

/// `--version` 的第一行 → 设置页要显示的版本号。
///
/// 各 CLI 的格式不统一(`2.1.280 (Claude Code)`、`codex-cli 0.156.0`、
/// `v1.2`),页面上只需要数字部分,所以取第一个 `x.y.z`;没有三段号就原样
/// 保留(截断后)——`v1.2` 这种仍然比空着有信息。只有空输出会被丢弃。
/// 长度也在这里截断:这是外部程序的输出,不该决定页面的宽度。
fn normalize_version(raw: &str) -> String {
    let raw = raw.trim();
    if raw.is_empty() {
        return String::new();
    }
    if let Some(token) = version_token(raw) {
        return token.to_string();
    }
    raw.chars().take(40).collect()
}

/// 第一个形如 `数字.数字.数字` 的连续片段(允许更多段,但至少两个点)。
fn version_token(text: &str) -> Option<&str> {
    let bytes = text.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if !bytes[i].is_ascii_digit() {
            i += 1;
            continue;
        }
        let start = i;
        let mut dots = 0;
        let mut j = i;
        while j < bytes.len() && (bytes[j].is_ascii_digit() || bytes[j] == b'.') {
            if bytes[j] == b'.' {
                dots += 1;
            }
            j += 1;
        }
        // 至少两段点号,且不以点结尾(`1.2.` 是半截)。
        if dots >= 2 && bytes[j - 1] != b'.' {
            return Some(&text[start..j]);
        }
        i = j.max(i + 1);
    }
    None
}

fn truncate(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_string();
    }
    text.chars().take(max).collect::<String>() + "…"
}

/// 探测一个发行版(带缓存 + single-flight + 失败短缓存)。
pub async fn ensure(distro: &str) -> Result<Arc<WslProbe>, ProbeError> {
    if !super::wsl_path::is_safe_distro(distro) {
        return Err(ProbeError::DistroNotFound);
    }
    if let Some(probe) = cached(distro) {
        if probe.is_fresh() {
            return Ok(probe);
        }
    }
    if let Some(error) = fresh_negative(distro) {
        return Err(error);
    }
    // 同一发行版串行探测:后来者在锁上等待,拿到锁后先看别人是否已经
    // 填好缓存,避免并发重复跑 2.4s 的交互 shell(§10 P1-17)。
    let lock = {
        let mut map = inflight().lock().unwrap_or_else(|e| e.into_inner());
        Arc::clone(
            map.entry(distro.to_string())
                .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(()))),
        )
    };
    let _guard = lock.lock().await;
    if let Some(probe) = cached(distro) {
        if probe.is_fresh() {
            return Ok(probe);
        }
    }
    if let Some(error) = fresh_negative(distro) {
        return Err(error);
    }
    match probe_distro(distro).await {
        Ok(probe) => {
            let probe = Arc::new(probe);
            if let Ok(mut map) = cache().lock() {
                map.insert(distro.to_string(), Arc::clone(&probe));
            }
            if let Ok(mut map) = negative_cache().lock() {
                map.remove(distro);
            }
            Ok(probe)
        }
        Err(error) => {
            if let Ok(mut map) = negative_cache().lock() {
                map.insert(distro.to_string(), (error.clone(), Instant::now()));
            }
            Err(error)
        }
    }
}

fn fresh_negative(distro: &str) -> Option<ProbeError> {
    let mut map = negative_cache().lock().ok()?;
    match map.get(distro) {
        Some((error, at)) if at.elapsed() < NEGATIVE_TTL => Some(error.clone()),
        Some(_) => {
            map.remove(distro);
            None
        }
        None => None,
    }
}

/// `%SystemRoot%\System32\wsl.exe`。不从 PATH 解析,避免同名程序劫持。
pub(crate) fn wsl_exe() -> Result<std::path::PathBuf, ProbeError> {
    let root = std::env::var_os("SystemRoot")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| std::path::PathBuf::from(r"C:\Windows"));
    let path = root.join("System32").join("wsl.exe");
    if path.is_file() {
        Ok(path)
    } else {
        Err(ProbeError::WslNotInstalled)
    }
}

#[cfg(not(windows))]
pub(crate) fn wsl_exe() -> Result<std::path::PathBuf, ProbeError> {
    Err(ProbeError::WslNotInstalled)
}

/// `WSL_UTF8=1` 让 `wsl.exe` 输出 UTF-8(V16);旧版 WSL 忽略它并继续输出
/// UTF-16LE,所以读取侧仍保留解码兜底。
pub(crate) fn apply_wsl_env(command: &mut tokio::process::Command) {
    command.env("WSL_UTF8", "1");
    #[cfg(windows)]
    super::hide_console(command);
}

/// `wsl.exe` 的输出解码:先按 UTF-8 试,出现 NUL 或非法序列则按 UTF-16LE
/// 解码(旧版 WSL、无 `WSL_UTF8` 支持时的方言,V15/V16)。
pub fn decode_wsl_output(raw: &[u8]) -> String {
    let utf8 = String::from_utf8_lossy(raw).to_string();
    if !utf8.contains('\0') {
        return utf8;
    }
    let units: Vec<u16> = raw
        .chunks_exact(2)
        .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
        .collect();
    String::from_utf16_lossy(&units).replace('\0', "")
}

/// 从 `wsl.exe` 的错误输出里识别稳定错误码(不匹配本地化文案,V15)。
pub fn classify_wsl_error(text: &str) -> Option<ProbeError> {
    if text.contains("WSL_E_DISTRO_NOT_FOUND") {
        return Some(ProbeError::DistroNotFound);
    }
    None
}

#[cfg(windows)]
async fn probe_distro(distro: &str) -> Result<WslProbe, ProbeError> {
    use std::process::Stdio;

    let exe = wsl_exe()?;
    let mut command = tokio::process::Command::new(exe);
    command
        .arg("-d")
        .arg(distro)
        .arg("--exec")
        .arg("/bin/bash")
        .arg("-ic")
        .arg(PROBE_SCRIPT);
    apply_wsl_env(&mut command);
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let output = match tokio::time::timeout(PROBE_TIMEOUT, command.output()).await {
        Ok(result) => result.map_err(|e| ProbeError::Failed(e.to_string()))?,
        Err(_) => return Err(ProbeError::StartTimeout),
    };
    let stdout = decode_wsl_output(&output.stdout);
    let stderr = decode_wsl_output(&output.stderr);
    // 发行版不存在时错误码在 stdout(本地化提示),Linux 侧失败在 stderr。
    if let Some(error) = classify_wsl_error(&stdout).or_else(|| classify_wsl_error(&stderr)) {
        return Err(error);
    }
    let probe = parse_probe_output(&stdout).map_err(|detail| {
        let tail = stderr.trim();
        if tail.is_empty() {
            ProbeError::Failed(detail)
        } else {
            ProbeError::Failed(format!("{detail}; stderr: {}", truncate(tail, 200)))
        }
    })?;
    // WSL1 没有真实 Linux 会话:进程回收与 UNC 语义都和本方案不同,静默按
    // WSL2 处理会制造更难查的问题,显式拒绝(§10 D7)。
    if looks_like_wsl1(&probe.kernel) {
        return Err(ProbeError::Failed(
            "WSL1 发行版暂不支持,请在 WSL2 发行版中打开该工作区".to_string(),
        ));
    }
    Ok(probe)
}

/// WSL1 内核形如 `4.4.0-19041-Microsoft`;WSL2 含
/// `microsoft-standard`(小写,可能带 `-WSL2` 后缀)。
fn looks_like_wsl1(kernel: &str) -> bool {
    let lower = kernel.to_ascii_lowercase();
    lower.contains("microsoft") && !lower.contains("microsoft-standard")
}

#[cfg(not(windows))]
async fn probe_distro(_distro: &str) -> Result<WslProbe, ProbeError> {
    // 非 Windows 主机没有本机 WSL(SSH 远程 WSL 走 Ssh 后端,不经过这里)。
    Err(ProbeError::WslNotInstalled)
}

/// 列出已安装发行版(`wsl.exe -l -q`)。失败返回空表 —— 调用方把"未知"
/// 当作"不做发行版名校验"处理,而不是拒绝所有 WSL 工作区。
pub async fn list_distros() -> Vec<String> {
    list_distros_result().await.unwrap_or_default()
}

/// 与 [`list_distros`] 相同,但保留失败原因:「未安装 WSL」「列表读取超时」
/// 「没有发行版」在设置页需要三种不同文案(§10 P2-6)。
pub async fn list_distros_result() -> Result<Vec<String>, ProbeError> {
    #[cfg(windows)]
    {
        use std::process::Stdio;
        let exe = wsl_exe()?;
        let mut command = tokio::process::Command::new(exe);
        command.arg("-l").arg("-q");
        apply_wsl_env(&mut command);
        command
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        let output = tokio::time::timeout(PROBE_TIMEOUT, command.output())
            .await
            .map_err(|_| ProbeError::StartTimeout)?
            .map_err(|e| ProbeError::Failed(format!("wsl.exe -l -q: {e}")))?;
        if !output.status.success() {
            let detail = decode_wsl_output(&output.stderr);
            let detail = if detail.trim().is_empty() {
                format!("wsl.exe -l -q 退出码 {:?}", output.status.code())
            } else {
                detail.trim().to_string()
            };
            return Err(ProbeError::Failed(detail));
        }
        Ok(decode_wsl_output(&output.stdout)
            .lines()
            .map(str::trim)
            .filter(|line| !line.is_empty())
            .map(str::to_string)
            .collect())
    }
    #[cfg(not(windows))]
    {
        Err(ProbeError::WslNotInstalled)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// V4/V5 的真实噪声:profile 里的 echo、nvm 提示、Windows 侧同名程序。
    #[test]
    fn parses_pi_agent_dir_sentinel() {
        let probe = parse_probe_output(
            "__CCGUI__HOME=/home/me\n__CCGUI__PATH=/bin\n__CCGUI__PI_AGENT_DIR=/data/pi\n",
        )
        .unwrap();
        assert_eq!(probe.pi_agent_dir, "/data/pi");
    }

    #[test]
    fn parses_kimi_home_sentinel() {
        let probe = parse_probe_output(
            "__CCGUI__HOME=/home/me\n__CCGUI__PATH=/bin\n__CCGUI__KIMI_HOME=/data/kimi\n",
        )
        .unwrap();
        assert_eq!(probe.kimi_home, "/data/kimi");
    }

    #[test]
    fn wsl1_kernels_are_rejected_before_use() {
        assert!(looks_like_wsl1("4.4.0-19041-Microsoft"));
        assert!(!looks_like_wsl1("5.15.153.1-microsoft-standard-WSL2"));
        assert!(!looks_like_wsl1("6.6.0-generic"));
    }

    #[test]
    fn parses_sentinels_out_of_profile_noise() {
        let raw = "hello\n\
nvm: node 24.17.0 active\n\
\n\
__CCGUI__HOME=/home/lintao\n\
__CCGUI__PATH=/home/lintao/.nvm/versions/node/v24.17.0/bin:/usr/bin:/bin:/mnt/c/Windows\n\
__CCGUI__CODEX_HOME=/home/lintao/.codex-alt\n\
__CCGUI__BIN claude=/home/lintao/.nvm/versions/node/v24.17.0/bin/claude\n\
__CCGUI__BIN codex=/mnt/c/Users/lintao/AppData/Roaming/npm/codex\n\
__CCGUI__BIN codex=/usr/local/bin/codex\n\
__CCGUI__BIN rg=/usr/bin/rg\n";
        let probe = parse_probe_output(raw).unwrap();
        assert_eq!(probe.home, "/home/lintao");
        assert!(probe.path.contains(".nvm"));
        assert_eq!(probe.codex_home, "/home/lintao/.codex-alt");
        assert_eq!(
            probe.bin("claude"),
            Some("/home/lintao/.nvm/versions/node/v24.17.0/bin/claude")
        );
        // `/mnt/` 下的 Windows 程序被跳过,取本机那一项
        assert_eq!(probe.bin("codex"), Some("/usr/local/bin/codex"));
        assert_eq!(probe.bin("rg"), Some("/usr/bin/rg"));
        assert_eq!(probe.bin("grok"), None);
    }

    #[test]
    fn first_bin_wins_and_crlf_is_tolerated() {
        let raw = "__CCGUI__HOME=/home/me\r\n\
__CCGUI__PATH=/usr/bin\r\n\
__CCGUI__BIN claude=/usr/local/bin/claude\r\n\
__CCGUI__BIN claude=/opt/claude\r\n";
        let probe = parse_probe_output(raw).unwrap();
        assert_eq!(probe.bin("claude"), Some("/usr/local/bin/claude"));
    }

    /// 设置页要显示"装了什么版本"(§5.9)。各 CLI 的 `--version` 格式不同:
    /// 只保留版本号本身,整行原文不进徽标。
    #[test]
    fn versions_are_reduced_to_the_number() {
        let raw = "__CCGUI__HOME=/home/me\n\
__CCGUI__PATH=/usr/bin\n\
__CCGUI__BIN claude=/usr/bin/claude\n\
__CCGUI__VER claude=2.1.280 (Claude Code)\n\
__CCGUI__BIN codex=/usr/bin/codex\n\
__CCGUI__VER codex=codex-cli 0.156.0\n\
__CCGUI__BIN kimi=/usr/bin/kimi\n\
__CCGUI__VER kimi=v1.2\n\
__CCGUI__BIN grok=/usr/bin/grok\n\
__CCGUI__VER grok=\n";
        let probe = parse_probe_output(raw).unwrap();
        assert_eq!(probe.versions.get("claude").map(String::as_str), Some("2.1.280"));
        assert_eq!(probe.versions.get("codex").map(String::as_str), Some("0.156.0"));
        // 没有三段数字就不硬凑:原样(截断后)展示,空行直接丢弃。
        assert_eq!(probe.versions.get("kimi").map(String::as_str), Some("v1.2"));
        assert_eq!(probe.versions.get("grok"), None);
    }

    #[test]
    fn version_token_skips_partial_numbers() {
        assert_eq!(normalize_version("1.2.3-beta.4"), "1.2.3");
        assert_eq!(normalize_version("build 42, version 3.4.5"), "3.4.5");
        // 半截点号不算版本(否则 `1.2.` 会被当成版本号截出来)。
        assert_eq!(normalize_version("1.2."), "1.2.");
        assert_eq!(normalize_version("   "), "");
    }

    #[test]
    fn missing_home_sentinel_is_an_error() {
        let err = parse_probe_output("bash: /bin/bash: No such file\n").unwrap_err();
        assert!(err.contains("没有输出"), "{err}");
    }

    #[test]
    fn rejects_relative_and_mnt_bins() {
        let raw = "__CCGUI__HOME=/h\n__CCGUI__PATH=/bin\n\
__CCGUI__BIN claude=claude\n\
__CCGUI__BIN codex=/mnt/c/x/codex\n";
        let probe = parse_probe_output(raw).unwrap();
        assert!(probe.bins.is_empty());
    }

    #[test]
    fn decodes_utf16le_without_bom() {
        // V16:`wsl.exe -l -q` 在无 WSL_UTF8 时输出 UTF-16LE(无 BOM)。
        let text = "Ubuntu-24.04\r\nDebian\r\n";
        let raw: Vec<u8> = text
            .encode_utf16()
            .flat_map(|unit| unit.to_le_bytes())
            .collect();
        assert_eq!(decode_wsl_output(&raw), text);
    }

    #[test]
    fn keeps_utf8_untouched() {
        let raw = "Ubuntu-24.04\r\ndelete 发行版\r\n".as_bytes();
        assert_eq!(decode_wsl_output(raw), "Ubuntu-24.04\r\ndelete 发行版\r\n");
    }

    #[test]
    fn classifies_stable_error_markers() {
        assert_eq!(
            classify_wsl_error("错误代码: Wsl/Service/WSL_E_DISTRO_NOT_FOUND"),
            Some(ProbeError::DistroNotFound)
        );
        assert_eq!(classify_wsl_error("其他错误"), None);
    }

    #[test]
    fn error_codes_are_stable_prefixes() {
        assert_eq!(ProbeError::WslNotInstalled.code(), "WSL_NOT_INSTALLED");
        assert_eq!(ProbeError::DistroNotFound.code(), "WSL_DISTRO_NOT_FOUND");
        assert_eq!(ProbeError::StartTimeout.code(), "WSL_START_TIMEOUT");
        assert!(ProbeError::Failed("x".into()).code().starts_with("WSL_PROBE_FAILED:"));
    }
}

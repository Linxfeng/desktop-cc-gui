//! WSL 发行版内的 CLI 管理状态 —— 只读。
//!
//! 数据源是 [`super::wsl_probe`] 的探测缓存与 `AppSettings.wsl_engine_paths`
//! 的路径覆盖；本模块不直接调用 `wsl.exe`（探测一律经 `wsl_probe::ensure`，
//! 正缓存/失败负缓存/single-flight 都在那里），也不读写发行版内文件。后续的
//! 白名单文件服务会在这里增量扩展，而不是另起一套探测。

use crate::engine::{cli_binary_name, wsl_path, wsl_probe, wsl_transport};

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum WslCliSource {
    Probe,
    Override,
    Missing,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WslCliStatus {
    pub engine: String,
    pub distro: String,
    /// 发行版内绝对路径；覆盖优先，其次探测；都没有时为 None。
    pub bin: Option<String>,
    /// 只有 `source = probe` 才有值；覆盖路径不借用探测版本。
    pub version: Option<String>,
    pub source: WslCliSource,
    /// 发行版内官方配置文件的绝对路径（只读展示）。未知引擎为 None。
    pub config_path: Option<String>,
    /// 本次读到的探测缓存年龄（秒）。刚探测为 0；`ensure` 成功后正常总有值，
    /// `None` 只兜底并发 `invalidate`（例如同时点了「重新检测」）的竞态。
    pub probed_ago_secs: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WslCliCapabilities {
    /// 当前后端能在 WSL 中运行的引擎 id，按 `config::ENGINES` 顺序。
    pub engines: Vec<String>,
    /// 发行版内官方配置可编辑的引擎（有白名单文件：claude/codex/kimi）。
    pub editable_engines: Vec<String>,
    /// 发行版内供应商认证可管理的引擎（pi 的 auth/models 白名单）。
    pub auth_engines: Vec<String>,
}

/// 本次真正能在本机 WSL 里跑的引擎：Child 传输、无 Windows staging 文件。
/// 可用性菜单与 CLI 管理共用这一份判定，避免两处白名单漂移。
pub(crate) fn supported_engine(id: &str) -> bool {
    matches!(id, "claude" | "codex" | "kimi" | "minimax" | "pi")
}

pub(crate) fn supported_engines() -> Vec<String> {
    crate::config::ENGINES
        .iter()
        .filter(|id| supported_engine(id))
        .map(|id| (*id).to_string())
        .collect()
}

/// 后端声明哪些引擎能在 WSL 中运行。纯静态数据，不探测、不读设置。
#[tauri::command]
pub fn wsl_cli_capabilities() -> WslCliCapabilities {
    WslCliCapabilities {
        engines: supported_engines(),
        editable_engines: editable_engines(),
        auth_engines: auth_engines(),
    }
}

/// 发行版内官方配置可编辑的引擎。与 [`config_targets`] 的白名单一致。
pub(crate) fn editable_engines() -> Vec<String> {
    vec!["claude".into(), "codex".into(), "kimi".into()]
}

/// 发行版内供应商认证可管理的引擎。与 [`pi_targets`] 一致；omp 不在 WSL
/// 可运行引擎里，不出现。
pub(crate) fn auth_engines() -> Vec<String> {
    vec!["pi".into()]
}

/// 某个发行版内受支持引擎的 CLI 状态。
///
/// 复用 `wsl_probe::ensure` 的缓存与 single-flight，不新增 `wsl.exe` 调用；
/// 设置文件损坏时只丢覆盖，不让探测结果一起消失。
#[tauri::command]
pub async fn wsl_cli_status(distro: String) -> Result<Vec<WslCliStatus>, String> {
    // 先转成 owned String：发行版名要跨 await 使用，owned 值不把借用
    // 生命周期带进异步状态机。
    let distro = checked_distro(&distro)?.to_string();
    let probe = wsl_probe::ensure(&distro).await.map_err(|e| e.code())?;
    let overrides = overrides_or_empty(crate::settings::read_settings(), &distro);
    let probed_ago_secs = wsl_probe::probe_age(&distro).map(|age| age.as_secs());
    Ok(statuses(&distro, &probe, &overrides, probed_ago_secs))
}

fn checked_distro(distro: &str) -> Result<&str, String> {
    let distro = distro.trim();
    if !wsl_path::is_safe_distro(distro) {
        return Err("WSL_DISTRO_NOT_FOUND".to_string());
    }
    Ok(distro)
}

/// 设置文件损坏时返回空覆盖并留下原因：CLI 状态只丢「手工指定」这一层，
/// 探测结果仍可展示。独立成函数是为了让错误分支可单测。
fn overrides_or_empty(
    settings: Result<crate::settings::AppSettings, String>,
    distro: &str,
) -> Vec<(String, String)> {
    match settings {
        Ok(settings) => crate::settings::wsl_engine_overrides(&settings, distro),
        Err(error) => {
            eprintln!("[wsl] cli status: settings unreadable: {error}");
            Vec::new()
        }
    }
}

/// 探测结果 + 覆盖 → 每个受支持引擎一行（按 `config::ENGINES` 顺序）。
fn statuses(
    distro: &str,
    probe: &wsl_probe::WslProbe,
    overrides: &[(String, String)],
    probed_ago_secs: Option<u64>,
) -> Vec<WslCliStatus> {
    let overrides: std::collections::HashMap<&str, &str> = overrides
        .iter()
        .map(|(engine, path)| (engine.as_str(), path.as_str()))
        .collect();

    supported_engines()
        .into_iter()
        .map(|engine| {
            // 先把借用的结果取成 owned 值，再移动 engine 进结构体：
            // `cli_binary_name` 返回的 &str 借自 engine，字段初始化顺序会让
            // “先移动、后借用”编译失败。
            let bin_name = cli_binary_name(&engine);
            let probed_bin = probe.bin(bin_name).map(str::to_string);
            let probed_version = probe.versions.get(bin_name).cloned();
            let config_path = official_config_path(&engine, probe);
            if let Some(path) = overrides.get(engine.as_str()) {
                WslCliStatus {
                    engine,
                    distro: distro.to_string(),
                    bin: Some((*path).to_string()),
                    version: None,
                    source: WslCliSource::Override,
                    config_path,
                    probed_ago_secs,
                }
            } else if let Some(path) = probed_bin {
                WslCliStatus {
                    engine,
                    distro: distro.to_string(),
                    bin: Some(path),
                    version: probed_version,
                    source: WslCliSource::Probe,
                    config_path,
                    probed_ago_secs,
                }
            } else {
                WslCliStatus {
                    engine,
                    distro: distro.to_string(),
                    bin: None,
                    version: None,
                    source: WslCliSource::Missing,
                    config_path,
                    probed_ago_secs,
                }
            }
        })
        .collect()
}

/// 官方配置文件的发行版内绝对路径。只用于展示；不证明文件存在，也不读写。
fn official_config_path(engine: &str, probe: &wsl_probe::WslProbe) -> Option<String> {
    let dir = |configured: &str, fallback: &str| {
        let raw = if configured.trim().is_empty() {
            format!("{}/{}", probe.home.trim_end_matches('/'), fallback)
        } else {
            configured.trim().to_string()
        };
        raw.trim_end_matches('/').to_string()
    };
    let (dir, file) = match engine {
        "claude" => (dir(&probe.claude_home, ".claude"), "settings.json"),
        "codex" => (dir(&probe.codex_home, ".codex"), "config.toml"),
        "kimi" => (dir(&probe.kimi_home, ".kimi-code"), "config.toml"),
        "pi" => (dir(&probe.pi_agent_dir, ".pi/agent"), "models.json"),
        _ => return None,
    };
    Some(format!("{dir}/{file}"))
}

// ── 官方配置读写（白名单文件） ─────────────────────────────
//
// 只碰白名单内的固定文件；前端永远不能传任意路径。内容经 base64 随脚本走
// stdin，不进 argv、不进日志；secret 文件写入 0600。写入前先在后端校验
// JSON/TOML，再按 `expectedHash` 做冲突检测，失败保留原文件。

/// 单个配置文件的大小上限；超过则拒绝读入 webview。
const MAX_CONFIG_BYTES: u64 = 256 * 1024;

struct ConfigTarget {
    key: &'static str,
    dir: String,
    file: &'static str,
    format: &'static str,
    secret: bool,
}

impl ConfigTarget {
    fn path(&self) -> String {
        format!("{}/{}", self.dir.trim_end_matches('/'), self.file)
    }
}

fn config_targets(engine: &str, probe: &wsl_probe::WslProbe) -> Vec<ConfigTarget> {
    let dir = |configured: &str, fallback: &str| {
        let raw = if configured.trim().is_empty() {
            format!("{}/{}", probe.home.trim_end_matches('/'), fallback)
        } else {
            configured.trim().to_string()
        };
        raw.trim_end_matches('/').to_string()
    };
    match engine {
        "claude" => vec![ConfigTarget {
            key: "settings",
            dir: dir(&probe.claude_home, ".claude"),
            file: "settings.json",
            format: "json",
            secret: false,
        }],
        "codex" => vec![
            ConfigTarget {
                key: "config",
                dir: dir(&probe.codex_home, ".codex"),
                file: "config.toml",
                format: "toml",
                secret: false,
            },
            ConfigTarget {
                key: "auth",
                dir: dir(&probe.codex_home, ".codex"),
                file: "auth.json",
                format: "json",
                secret: true,
            },
        ],
        "kimi" => vec![ConfigTarget {
            key: "config",
            dir: dir(&probe.kimi_home, ".kimi-code"),
            file: "config.toml",
            format: "toml",
            secret: false,
        }],
        _ => Vec::new(),
    }
}

/// 编辑器的一个文件页签。
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WslCliConfigFile {
    pub key: String,
    pub path: String,
    pub format: String,
    pub secret: bool,
    pub exists: bool,
    /// 超过 [`MAX_CONFIG_BYTES`] 时不带内容，编辑器只展示提示。
    pub too_large: bool,
    pub content: String,
    /// 读时的 sha256（十六进制），写回时用于冲突检测；不存在/过大为 None。
    pub hash: Option<String>,
}

/// 写回的草稿。`key` 命中白名单才允许写；`expectedHash` 与读时的 sha256
/// 不一致时按冲突拒绝，不覆盖发行版里刚改的内容。
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WslCliConfigDraft {
    pub key: String,
    pub content: String,
    #[serde(default)]
    pub expected_hash: Option<String>,
}

fn local_transport(distro: &str) -> wsl_transport::WslTransport {
    wsl_transport::WslTransport {
        backend: wsl_transport::WslBackend::Local,
        distro: distro.to_string(),
        engine_paths: std::collections::HashMap::new(),
        workspace: None,
        shell_path: None,
        codex_home: None,
        claude_home: None,
        pi_agent_dir: None,
    }
}

/// 读取发行版内某引擎的白名单配置文件。
#[tauri::command]
pub async fn wsl_cli_config_read(
    distro: String,
    engine: String,
) -> Result<Vec<WslCliConfigFile>, String> {
    let distro = checked_distro(&distro)?.to_string();
    let probe = wsl_probe::ensure(&distro).await.map_err(|e| e.code())?;
    let targets = config_targets(&engine, &probe);
    if targets.is_empty() {
        return Err(format!("WSL_CLI_CONFIG_UNSUPPORTED:{engine}"));
    }
    let transport = local_transport(&distro);
    let raw =
        wsl_transport::run_script_output(&transport, &config_read_script(&targets)).await?;
    parse_config_read(&raw, &targets)
}

/// 写回发行版内某引擎的白名单配置文件。
#[tauri::command]
pub async fn wsl_cli_config_write(
    distro: String,
    engine: String,
    files: Vec<WslCliConfigDraft>,
) -> Result<(), String> {
    let distro = checked_distro(&distro)?.to_string();
    let probe = wsl_probe::ensure(&distro).await.map_err(|e| e.code())?;
    let targets = config_targets(&engine, &probe);
    if targets.is_empty() {
        return Err(format!("WSL_CLI_CONFIG_UNSUPPORTED:{engine}"));
    }
    // 先全部校验,再写:任一文件非法/超限都不落盘。
    let mut resolved = Vec::with_capacity(files.len());
    for draft in &files {
        let target = targets
            .iter()
            .find(|t| t.key == draft.key)
            .ok_or_else(|| format!("WSL_CLI_CONFIG_UNSUPPORTED:{engine}:{}", draft.key))?;
        validate_config_content(target.format, &draft.key, &draft.content)?;
        if draft.content.len() as u64 > MAX_CONFIG_BYTES {
            return Err(format!("WSL_CLI_FILE_TOO_LARGE:{}", draft.key));
        }
        resolved.push(target);
    }
    if resolved.is_empty() {
        return Ok(());
    }
    let transport = local_transport(&distro);
    let raw =
        wsl_transport::run_script_output(&transport, &config_write_script(&resolved, &files))
            .await?;
    parse_config_write(&raw, resolved.len())
}

/// JSON 必须是对象;TOML 必须能解析。错误码是稳定前缀,前端按前缀本地化。
fn validate_config_content(format: &str, key: &str, content: &str) -> Result<(), String> {
    match format {
        "toml" => {
            content
                .parse::<toml_edit::DocumentMut>()
                .map_err(|e| format!("WSL_CLI_CONFIG_INVALID_TOML:{key}: {e}"))?;
        }
        _ => {
            let value: serde_json::Value = serde_json::from_str(content)
                .map_err(|e| format!("WSL_CLI_CONFIG_INVALID_JSON:{key}: {e}"))?;
            if !value.is_object() {
                return Err(format!("WSL_CLI_CONFIG_INVALID_JSON:{key}: 必须是 JSON 对象"));
            }
        }
    }
    Ok(())
}

/// 读取脚本:每个白名单文件一个 BEGIN/END 块;不存在 → MISSING;超限 →
/// TOO_LARGE(不再读内容,避免把大文件灌进 IPC)。
fn config_read_script(targets: &[ConfigTarget]) -> String {
    let mut script = format!(
        "set -u\n\
cfg_read() {{\n\
  local key=\"$1\" path=\"$2\"\n\
  printf '__CCGUI__CFG_BEGIN %s\\n' \"$key\"\n\
  if [ -f \"$path\" ]; then\n\
    printf '__CCGUI__CFG_EXISTS\\n'\n\
    if [ \"$(wc -c < \"$path\")\" -gt {max} ]; then\n\
      printf '__CCGUI__CFG_TOO_LARGE\\n'\n\
    else\n\
      sha256sum \"$path\" | awk '{{printf \"__CCGUI__CFG_HASH %s\\n\", $1}}'\n\
      base64 -w0 \"$path\"\n\
      printf '\\n'\n\
    fi\n\
  else\n\
    printf '__CCGUI__CFG_MISSING\\n'\n\
  fi\n\
  printf '__CCGUI__CFG_END\\n'\n\
}}\n",
        max = MAX_CONFIG_BYTES,
    );
    for target in targets {
        script.push_str(&format!(
            "cfg_read {} {}\n",
            wsl_transport::sh_quote(target.key),
            wsl_transport::sh_quote(&target.path()),
        ));
    }
    script.push_str("exit 0\n");
    script
}

/// 写入脚本:先全量冲突检查,再逐个原子写。脚本永远 `exit 0`,结果走 stdout
/// 哨兵 —— 非零退出会被传输层统一成 `WSL_SHORT_CALL_FAILED`,丢冲突信息。
fn config_write_script(targets: &[&ConfigTarget], drafts: &[WslCliConfigDraft]) -> String {
    let mut script = String::from(
        "set -u\n\
umask 077\n\
conflict=0\n\
cfg_check() {\n\
  local key=\"$1\" path=\"$2\" expected=\"$3\"\n\
  if [ -n \"$expected\" ]; then\n\
    if [ ! -f \"$path\" ]; then\n\
      printf '__CCGUI__CFG_CONFLICT %s\\n' \"$key\"\n\
      conflict=1\n\
      return\n\
    fi\n\
    local current\n\
    current=$(sha256sum \"$path\" | awk '{print $1}')\n\
    if [ \"$current\" != \"$expected\" ]; then\n\
      printf '__CCGUI__CFG_CONFLICT %s\\n' \"$key\"\n\
      conflict=1\n\
    fi\n\
  fi\n\
}\n",
    );
    for draft in drafts {
        let target = targets
            .iter()
            .find(|t| t.key == draft.key)
            .expect("validated before script");
        script.push_str(&format!(
            "cfg_check {} {} {}\n",
            wsl_transport::sh_quote(target.key),
            wsl_transport::sh_quote(&target.path()),
            wsl_transport::sh_quote(draft.expected_hash.as_deref().unwrap_or("")),
        ));
    }
    script.push_str("if [ \"$conflict\" -eq 0 ]; then\n");
    script.push_str(
        "cfg_write() {\n\
  local key=\"$1\" path=\"$2\" secret=\"$3\" b64=\"$4\"\n\
  local dir\n\
  dir=$(dirname \"$path\")\n\
  mkdir -p -m 700 \"$dir\" 2>/dev/null || true\n\
  # 非 secret 沿用原文件权限,缺失/secret 一律 600;mv 保留临时文件的权限位。\n\
  local mode\n\
  if [ \"$secret\" = \"1\" ]; then\n\
    mode=600\n\
  elif [ -f \"$path\" ]; then\n\
    mode=$(stat -c '%a' \"$path\" 2>/dev/null)\n\
    mode=${mode:-600}\n\
  else\n\
    mode=600\n\
  fi\n\
  local tmp=\"$path.ccgui-tmp-$$\"\n\
  if ! printf '%s' \"$b64\" | base64 -d > \"$tmp\" 2>/dev/null; then\n\
    rm -f \"$tmp\"\n\
    printf '__CCGUI__CFG_WRITE_FAIL %s\\n' \"$key\"\n\
    return\n\
  fi\n\
  chmod \"$mode\" \"$tmp\" 2>/dev/null\n\
  if mv -f \"$tmp\" \"$path\" 2>/dev/null; then\n\
    printf '__CCGUI__CFG_WRITTEN %s\\n' \"$key\"\n\
  else\n\
    rm -f \"$tmp\"\n\
    printf '__CCGUI__CFG_WRITE_FAIL %s\\n' \"$key\"\n\
  fi\n\
}\n",
    );
    for draft in drafts {
        let target = targets
            .iter()
            .find(|t| t.key == draft.key)
            .expect("validated before script");
        // base64 只含字母数字 + / + =,不含引号/空白,可以裸写在脚本里。
        let b64 = base64::Engine::encode(
            &base64::engine::general_purpose::STANDARD,
            draft.content.as_bytes(),
        );
        script.push_str(&format!(
            "cfg_write {} {} {} {}\n",
            wsl_transport::sh_quote(target.key),
            wsl_transport::sh_quote(&target.path()),
            if target.secret { "1" } else { "0" },
            b64,
        ));
    }
    script.push_str("fi\nexit 0\n");
    script
}

fn parse_config_read(
    raw: &str,
    targets: &[ConfigTarget],
) -> Result<Vec<WslCliConfigFile>, String> {
    use base64::Engine as _;
    let mut out = Vec::with_capacity(targets.len());
    let mut lines = raw.lines();
    while let Some(line) = lines.next() {
        let Some(key) = line.trim().strip_prefix("__CCGUI__CFG_BEGIN ") else {
            continue;
        };
        let key = key.trim();
        let target = targets
            .iter()
            .find(|t| t.key == key)
            .ok_or_else(|| format!("WSL_CLI_CONFIG_READ_FAILED:unknown key {key}"))?;
        let mut exists = false;
        let mut too_large = false;
        let mut hash = None;
        let mut b64 = String::new();
        for line in lines.by_ref() {
            let line = line.trim_end();
            if line == "__CCGUI__CFG_END" {
                break;
            } else if line == "__CCGUI__CFG_EXISTS" {
                exists = true;
            } else if line == "__CCGUI__CFG_MISSING" {
                exists = false;
            } else if line == "__CCGUI__CFG_TOO_LARGE" {
                too_large = true;
            } else if let Some(value) = line.strip_prefix("__CCGUI__CFG_HASH ") {
                hash = Some(value.trim().to_string());
            } else if !line.is_empty() {
                b64.push_str(line);
            }
        }
        let content = if exists && !too_large {
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(&b64)
                .map_err(|e| format!("WSL_CLI_CONFIG_READ_FAILED:{key}: {e}"))?;
            String::from_utf8(bytes)
                .map_err(|_| format!("WSL_CLI_CONFIG_READ_FAILED:{key}: 不是 UTF-8 文本"))?
        } else {
            String::new()
        };
        out.push(WslCliConfigFile {
            key: key.to_string(),
            path: target.path(),
            format: target.format.to_string(),
            secret: target.secret,
            exists,
            too_large,
            content,
            hash,
        });
    }
    // 每个目标都要有 BEGIN/END,否则按读取失败处理(不静默丢文件页签)。
    if out.len() != targets.len() {
        return Err("WSL_CLI_CONFIG_READ_FAILED:输出不完整".to_string());
    }
    Ok(out)
}

fn parse_config_write(raw: &str, expected_writes: usize) -> Result<(), String> {
    let mut conflicts = Vec::new();
    let mut failures = Vec::new();
    let mut written = 0usize;
    for line in raw.lines() {
        let line = line.trim();
        if let Some(key) = line.strip_prefix("__CCGUI__CFG_CONFLICT ") {
            conflicts.push(key.trim().to_string());
        } else if let Some(key) = line.strip_prefix("__CCGUI__CFG_WRITE_FAIL ") {
            failures.push(key.trim().to_string());
        } else if line.starts_with("__CCGUI__CFG_WRITTEN ") {
            written += 1;
        }
    }
    if let Some(key) = conflicts.first() {
        return Err(format!("WSL_CLI_CONFIG_CONFLICT:{key}"));
    }
    if let Some(key) = failures.first() {
        return Err(format!("WSL_CLI_CONFIG_WRITE_FAILED:{key}"));
    }
    if written != expected_writes {
        return Err(format!(
            "WSL_CLI_CONFIG_WRITE_FAILED:expected {expected_writes}, wrote {written}"
        ));
    }
    Ok(())
}

// ── pi 供应商认证（发行版内 auth.json / models.json） ────────
//
// 不走通用 `wsl_cli_config_read/write`：auth.json 的 key 明文不能进
// webview（列表只回传掩码），所以 pi 有专用命令；掩码/校验/合并逻辑与主机
// 共用 `pi_family_auth` 的纯函数。auth 的写是「读-改-写」：读时记下
// sha256，写回带 expectedHash 冲突检测，窗口期发行版侧的修改不会被覆盖。

fn pi_targets(probe: &wsl_probe::WslProbe) -> Vec<ConfigTarget> {
    let dir = if probe.pi_agent_dir.trim().is_empty() {
        format!("{}/.pi/agent", probe.home.trim_end_matches('/'))
    } else {
        probe.pi_agent_dir.trim().trim_end_matches('/').to_string()
    };
    vec![
        ConfigTarget {
            key: "auth",
            dir: dir.clone(),
            file: "auth.json",
            format: "json",
            secret: true,
        },
        ConfigTarget {
            key: "models",
            dir,
            file: "models.json",
            format: "jsonc",
            secret: false,
        },
    ]
}

fn pi_target<'a>(targets: &'a [ConfigTarget], key: &str) -> Result<&'a ConfigTarget, String> {
    targets
        .iter()
        .find(|t| t.key == key)
        .ok_or_else(|| "WSL_CLI_CONFIG_READ_FAILED:missing pi target".to_string())
}

/// 从发行版读一个 pi 文件的原始文本。缺失 → Ok(None)；损坏/超限等沿用
/// config read 的错误契约。
async fn read_pi_file(
    distro: &str,
    target: &ConfigTarget,
) -> Result<Option<String>, String> {
    let transport = local_transport(distro);
    let targets = std::slice::from_ref(target);
    let raw = wsl_transport::run_script_output(&transport, &config_read_script(targets)).await?;
    let files = parse_config_read(&raw, targets)?;
    let file = &files[0];
    if !file.exists || file.too_large {
        if file.too_large {
            return Err(format!("WSL_CLI_FILE_TOO_LARGE:{}", target.key));
        }
        return Ok(None);
    }
    Ok(Some(file.content.clone()))
}

/// 把一段文本原子写回发行版内的 pi 文件。`expected_hash` 做冲突检测。
async fn write_pi_file(
    distro: &str,
    target: &ConfigTarget,
    content: &str,
    expected_hash: Option<&str>,
) -> Result<(), String> {
    let draft = WslCliConfigDraft {
        key: target.key.to_string(),
        content: content.to_string(),
        expected_hash: expected_hash.map(str::to_string),
    };
    let transport = local_transport(distro);
    let raw = wsl_transport::run_script_output(
        &transport,
        &config_write_script(&[target], &[draft]),
    )
    .await?;
    parse_config_write(&raw, 1)
}

/// 列出发行版内 pi 的 provider 认证状态。key 只以掩码跨 IPC。
#[tauri::command]
pub async fn wsl_pi_auth_list(distro: String) -> Result<super::pi_family_auth::AuthListResult, String> {
    let distro = checked_distro(&distro)?.to_string();
    let probe = wsl_probe::ensure(&distro).await.map_err(|e| e.code())?;
    let targets = pi_targets(&probe);
    let target = pi_target(&targets, "auth")?;
    let path = target.path();
    let text = read_pi_file(&distro, target).await?;
    let Some(text) = text else {
        // 缺失 = 空店：全部 none，与主机 `pi_family_auth_list` 的语义一致。
        let (providers, oauth_providers) = super::pi_family_auth::auth_snapshots(&Default::default());
        return Ok(super::pi_family_auth::AuthListResult {
            store: super::pi_family_auth::AuthStoreInfo {
                path,
                kind: "authJson".to_string(),
                exists: false,
            },
            providers,
            oauth_providers,
        });
    };
    let map = super::pi_family_auth::parse_auth_store(&text, &path)?;
    let (providers, oauth_providers) = super::pi_family_auth::auth_snapshots(&map);
    Ok(super::pi_family_auth::AuthListResult {
        store: super::pi_family_auth::AuthStoreInfo {
            path,
            kind: "authJson".to_string(),
            exists: true,
        },
        providers,
        oauth_providers,
    })
}

/// 设置/替换发行版内 pi 的一个 API key。读-改-写，冲突不覆盖。
#[tauri::command]
pub async fn wsl_pi_auth_set_key(
    distro: String,
    provider_id: String,
    key: String,
) -> Result<(), String> {
    let distro = checked_distro(&distro)?.to_string();
    let probe = wsl_probe::ensure(&distro).await.map_err(|e| e.code())?;
    let targets = pi_targets(&probe);
    let target = pi_target(&targets, "auth")?;
    // key 校验在前（不发起任何 wsl.exe 调用），错误串与主机一致。
    let mut probe_map: serde_json::Map<String, serde_json::Value> = Default::default();
    super::pi_family_auth::apply_set_api_key(&mut probe_map, &provider_id, &key)?;
    let path = target.path();
    let text = read_pi_file(&distro, target).await?;
    let hash = match &text {
        Some(text) => Some(sha256_hex(text.as_bytes())),
        None => None,
    };
    let mut map = match &text {
        Some(text) => super::pi_family_auth::parse_auth_store(text, &path)?,
        None => Default::default(),
    };
    super::pi_family_auth::apply_set_api_key(&mut map, &provider_id, &key)?;
    let content = serde_json::to_string_pretty(&serde_json::Value::Object(map))
        .map_err(|e| format!("[PI_FAMILY_AUTH_WRITE] serialize: {e}"))?;
    write_pi_file(&distro, target, &format!("{content}\n"), hash.as_deref()).await
}

/// 删除发行版内 pi 的一个 api_key 凭据。oauth 凭据拒删。
#[tauri::command]
pub async fn wsl_pi_auth_delete(distro: String, provider_id: String) -> Result<(), String> {
    let distro = checked_distro(&distro)?.to_string();
    let probe = wsl_probe::ensure(&distro).await.map_err(|e| e.code())?;
    let targets = pi_targets(&probe);
    let target = pi_target(&targets, "auth")?;
    let text = read_pi_file(&distro, target).await?;
    let Some(text) = text else {
        return Ok(()); // nothing to delete
    };
    let path = target.path();
    let hash = sha256_hex(text.as_bytes());
    let mut map = super::pi_family_auth::parse_auth_store(&text, &path)?;
    super::pi_family_auth::apply_delete_credential(&mut map, &provider_id)?;
    let content = serde_json::to_string_pretty(&serde_json::Value::Object(map))
        .map_err(|e| format!("[PI_FAMILY_AUTH_WRITE] serialize: {e}"))?;
    write_pi_file(&distro, target, &format!("{content}\n"), Some(&hash)).await
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WslPiModelsRead {
    pub path: String,
    pub exists: bool,
    /// 原样文本（JSONC 注释保留）；缺失/空文件为 None。
    pub text: Option<String>,
    /// 编辑器初始草稿：缺失时给示例模板。
    pub template: String,
    pub providers: Vec<super::pi_family_auth::CustomProviderSummary>,
    pub parse_error: Option<String>,
    /// 读时的 sha256，写回时做冲突检测。
    pub hash: Option<String>,
}

/// 读发行版内 pi 的 models.json：原样文本 + provider 摘要 + 解析错误。
#[tauri::command]
pub async fn wsl_pi_models_read(distro: String) -> Result<WslPiModelsRead, String> {
    let distro = checked_distro(&distro)?.to_string();
    let probe = wsl_probe::ensure(&distro).await.map_err(|e| e.code())?;
    let targets = pi_targets(&probe);
    let target = pi_target(&targets, "models")?;
    let text = read_pi_file(&distro, target).await?;
    let template = super::pi_family_auth::MODELS_TEMPLATE_JSON.to_string();
    let Some(text) = text else {
        return Ok(WslPiModelsRead {
            path: target.path(),
            exists: false,
            text: None,
            template,
            providers: Vec::new(),
            parse_error: None,
            hash: None,
        });
    };
    let hash = sha256_hex(text.as_bytes());
    let (providers, parse_error) = if text.trim().is_empty() {
        (Vec::new(), None)
    } else {
        match super::pi_family_auth::validate_models_config_text("pi", &text) {
            Ok(value) => (super::pi_family_auth::summarize_providers(&value), None),
            Err(error) => (Vec::new(), Some(error)),
        }
    };
    Ok(WslPiModelsRead {
        path: target.path(),
        exists: true,
        text: Some(text),
        template,
        providers,
        parse_error,
        hash: Some(hash),
    })
}

/// 写发行版内 pi 的 models.json：先在后端做松散结构校验（不合法不落盘），
/// 再带冲突检测原子写。文本 verbatim 保存，注释与字段顺序保留。
#[tauri::command]
pub async fn wsl_pi_models_write(
    distro: String,
    text: String,
    expected_hash: Option<String>,
) -> Result<(), String> {
    let distro = checked_distro(&distro)?.to_string();
    let probe = wsl_probe::ensure(&distro).await.map_err(|e| e.code())?;
    // 校验在前（不发起 wsl.exe 调用）；错误串与主机 `pi_family_models_config_write` 一致。
    super::pi_family_auth::validate_models_config_text("pi", &text)?;
    let targets = pi_targets(&probe);
    let target = pi_target(&targets, "models")?;
    write_pi_file(&distro, target, &text, expected_hash.as_deref()).await
}

/// sha256 十六进制。与 config_read_script 里 `sha256sum` 的输出一致。
fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::Digest as _;
    sha2::Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn probe(raw: &str) -> wsl_probe::WslProbe {
        wsl_probe::parse_probe_output(raw).expect("probe parses")
    }

    fn row<'a>(rows: &'a [WslCliStatus], engine: &str) -> &'a WslCliStatus {
        rows.iter()
            .find(|row| row.engine == engine)
            .unwrap_or_else(|| panic!("missing row for {engine}"))
    }

    #[test]
    fn supported_engines_follow_config_order() {
        assert_eq!(
            supported_engines(),
            vec!["claude", "kimi", "codex", "pi", "minimax"]
        );
    }

    #[test]
    fn statuses_include_supported_engines_even_when_missing() {
        let probe = probe(
            "__CCGUI__HOME=/home/me\n__CCGUI__PATH=/usr/bin\n\
             __CCGUI__BIN claude=/usr/bin/claude\n",
        );
        let rows = statuses("Ubuntu-24.04", &probe, &[], Some(0));
        assert_eq!(rows.len(), 5);
        assert_eq!(row(&rows, "claude").source, WslCliSource::Probe);
        for engine in ["kimi", "codex", "pi", "minimax"] {
            let row = row(&rows, engine);
            assert_eq!(row.source, WslCliSource::Missing, "{engine}");
            assert_eq!(row.bin, None, "{engine}");
            assert_eq!(row.version, None, "{engine}");
        }
    }

    /// MiniMax 的 CLI 叫 `mcode`，探测表按命令名建键。
    #[test]
    fn probe_source_maps_mcode_to_minimax() {
        let probe = probe(
            "__CCGUI__HOME=/home/me\n__CCGUI__PATH=/usr/bin\n\
             __CCGUI__BIN mcode=/usr/local/bin/mcode\n\
             __CCGUI__VER mcode=0.4.2\n",
        );
        let rows = statuses("Ubuntu-24.04", &probe, &[], Some(12));
        let row = row(&rows, "minimax");
        assert_eq!(row.source, WslCliSource::Probe);
        assert_eq!(row.bin.as_deref(), Some("/usr/local/bin/mcode"));
        assert_eq!(row.version.as_deref(), Some("0.4.2"));
    }

    #[test]
    fn override_wins_without_borrowing_probe_version() {
        let probe = probe(
            "__CCGUI__HOME=/home/me\n__CCGUI__PATH=/usr/bin\n\
             __CCGUI__BIN claude=/usr/bin/claude\n\
             __CCGUI__VER claude=2.1.280\n",
        );
        let overrides = vec![("claude".to_string(), "/opt/claude".to_string())];
        let rows = statuses("Ubuntu-24.04", &probe, &overrides, Some(5));
        let row = row(&rows, "claude");
        assert_eq!(row.source, WslCliSource::Override);
        assert_eq!(row.bin.as_deref(), Some("/opt/claude"));
        assert_eq!(row.version, None);
    }

    #[test]
    fn missing_rows_have_no_bin_or_version() {
        let probe = probe("__CCGUI__HOME=/home/me\n__CCGUI__PATH=/usr/bin\n");
        let rows = statuses("Ubuntu-24.04", &probe, &[], Some(0));
        for row in &rows {
            assert_eq!(row.source, WslCliSource::Missing);
            assert!(row.bin.is_none());
            assert!(row.version.is_none());
        }
    }

    #[test]
    fn config_paths_default_to_home_dirs() {
        let probe = probe("__CCGUI__HOME=/home/me\n__CCGUI__PATH=/bin\n");
        let rows = statuses("Ubuntu-24.04", &probe, &[], Some(0));
        assert_eq!(
            row(&rows, "claude").config_path.as_deref(),
            Some("/home/me/.claude/settings.json")
        );
        assert_eq!(
            row(&rows, "codex").config_path.as_deref(),
            Some("/home/me/.codex/config.toml")
        );
        assert_eq!(
            row(&rows, "kimi").config_path.as_deref(),
            Some("/home/me/.kimi-code/config.toml")
        );
        assert_eq!(
            row(&rows, "pi").config_path.as_deref(),
            Some("/home/me/.pi/agent/models.json")
        );
        assert_eq!(row(&rows, "minimax").config_path, None);
    }

    #[test]
    fn config_paths_follow_distro_env() {
        let probe = probe(
            "__CCGUI__HOME=/home/me\n__CCGUI__PATH=/bin\n\
             __CCGUI__CLAUDE_HOME=/data/claude/\n\
             __CCGUI__CODEX_HOME=/data/codex\n\
             __CCGUI__KIMI_HOME=/data/kimi\n\
             __CCGUI__PI_AGENT_DIR=/data/pi\n",
        );
        let rows = statuses("Ubuntu-24.04", &probe, &[], Some(0));
        assert_eq!(
            row(&rows, "claude").config_path.as_deref(),
            Some("/data/claude/settings.json")
        );
        assert_eq!(
            row(&rows, "codex").config_path.as_deref(),
            Some("/data/codex/config.toml")
        );
        assert_eq!(
            row(&rows, "kimi").config_path.as_deref(),
            Some("/data/kimi/config.toml")
        );
        assert_eq!(
            row(&rows, "pi").config_path.as_deref(),
            Some("/data/pi/models.json")
        );
    }

    #[test]
    fn probe_age_is_carried_to_every_row() {
        let probe = probe("__CCGUI__HOME=/home/me\n__CCGUI__PATH=/usr/bin\n");
        let rows = statuses("Ubuntu-24.04", &probe, &[], Some(42));
        assert!(rows.iter().all(|row| row.probed_ago_secs == Some(42)));
    }

    #[test]
    fn invalid_distro_is_rejected_before_probing() {
        assert_eq!(checked_distro("..").unwrap_err(), "WSL_DISTRO_NOT_FOUND");
        assert_eq!(checked_distro("   ").unwrap_err(), "WSL_DISTRO_NOT_FOUND");
        assert_eq!(checked_distro(" . ").unwrap_err(), "WSL_DISTRO_NOT_FOUND");
        assert_eq!(
            checked_distro(" Ubuntu-24.04 ").unwrap(),
            "Ubuntu-24.04"
        );
    }

    /// 设置文件损坏只丢覆盖，探测结果仍能出行。
    #[test]
    fn settings_error_yields_no_overrides() {
        let overrides = overrides_or_empty(Err("broken settings".to_string()), "Ubuntu-24.04");
        assert!(overrides.is_empty());
        let probe = probe(
            "__CCGUI__HOME=/home/me\n__CCGUI__PATH=/usr/bin\n\
             __CCGUI__BIN claude=/usr/bin/claude\n",
        );
        let rows = statuses("Ubuntu-24.04", &probe, &overrides, Some(1));
        assert_eq!(row(&rows, "claude").source, WslCliSource::Probe);
    }

    #[test]
    fn capabilities_match_supported_engines() {
        let caps = wsl_cli_capabilities();
        assert_eq!(caps.engines, vec!["claude", "kimi", "codex", "pi", "minimax"]);
        assert_eq!(caps.editable_engines, vec!["claude", "codex", "kimi"]);
        assert_eq!(caps.auth_engines, vec!["pi"]);
    }

    // ── 官方配置读写 ───────────────────────────────────────────

    fn probe_with_dirs(raw: &str) -> wsl_probe::WslProbe {
        wsl_probe::parse_probe_output(raw).expect("probe parses")
    }

    #[test]
    fn config_targets_follow_whitelist_and_env() {
        let probe = probe_with_dirs(
            "__CCGUI__HOME=/home/me\n__CCGUI__PATH=/bin\n\
             __CCGUI__CLAUDE_HOME=/data/claude\n\
             __CCGUI__CODEX_HOME=/data/codex\n",
        );
        let claude = config_targets("claude", &probe);
        assert_eq!(claude.len(), 1);
        assert_eq!(claude[0].path(), "/data/claude/settings.json");

        let codex = config_targets("codex", &probe);
        assert_eq!(codex.len(), 2);
        assert_eq!(codex[1].key, "auth");
        assert!(codex[1].secret);
        assert_eq!(codex[1].path(), "/data/codex/auth.json");

        let kimi = config_targets("kimi", &probe);
        assert_eq!(kimi.len(), 1);
        assert_eq!(kimi[0].path(), "/home/me/.kimi-code/config.toml");

        assert!(config_targets("pi", &probe).is_empty());
        assert!(config_targets("minimax", &probe).is_empty());
    }

    #[test]
    fn validate_rejects_malformed_content() {
        assert!(validate_config_content("json", "settings", "{}").is_ok());
        assert!(validate_config_content("json", "settings", "{\"a\":1}").is_ok());
        assert!(validate_config_content("json", "settings", "not json").is_err());
        assert!(validate_config_content("json", "settings", "[1,2]").is_err());
        assert!(validate_config_content("toml", "config", "a = 1").is_ok());
        assert!(validate_config_content("toml", "config", "a = = 1").is_err());
    }

    /// 读脚本的哨兵 → 结构体:存在 / 缺失 / 超限都要正确落到字段上。
    #[test]
    fn parse_config_read_roundtrip() {
        let probe = probe_with_dirs("__CCGUI__HOME=/home/me\n__CCGUI__PATH=/bin\n");
        let targets = config_targets("codex", &probe);
        let raw = concat!(
            "noise before\n",
            "__CCGUI__CFG_BEGIN config\n",
            "__CCGUI__CFG_EXISTS\n",
            "__CCGUI__CFG_HASH abc123\n",
            "YSA9IDE=\n", // "a = 1"
            "__CCGUI__CFG_END\n",
            "__CCGUI__CFG_BEGIN auth\n",
            "__CCGUI__CFG_MISSING\n",
            "__CCGUI__CFG_END\n",
        );
        let files = parse_config_read(raw, &targets).unwrap();
        assert_eq!(files.len(), 2);
        assert!(files[0].exists);
        assert_eq!(files[0].content, "a = 1");
        assert_eq!(files[0].hash.as_deref(), Some("abc123"));
        assert!(!files[0].secret);
        assert!(!files[1].exists);
        assert!(files[1].secret);
        assert_eq!(files[1].content, "");
    }

    #[test]
    fn parse_config_read_marks_too_large() {
        let probe = probe_with_dirs("__CCGUI__HOME=/home/me\n__CCGUI__PATH=/bin\n");
        let targets = config_targets("claude", &probe);
        let raw = concat!(
            "__CCGUI__CFG_BEGIN settings\n",
            "__CCGUI__CFG_EXISTS\n",
            "__CCGUI__CFG_TOO_LARGE\n",
            "__CCGUI__CFG_END\n",
        );
        let files = parse_config_read(raw, &targets).unwrap();
        assert!(files[0].too_large);
        assert_eq!(files[0].content, "");
        assert_eq!(files[0].hash, None);
    }

    #[test]
    fn parse_config_read_rejects_incomplete_output() {
        let probe = probe_with_dirs("__CCGUI__HOME=/home/me\n__CCGUI__PATH=/bin\n");
        let targets = config_targets("codex", &probe);
        let raw = concat!(
            "__CCGUI__CFG_BEGIN config\n",
            "__CCGUI__CFG_EXISTS\n",
            "__CCGUI__CFG_HASH abc\n",
            "e30K\n",
            "__CCGUI__CFG_END\n",
        );
        assert!(parse_config_read(raw, &targets).is_err());
    }

    #[test]
    fn write_script_checks_conflicts_before_writing() {
        let probe = probe_with_dirs("__CCGUI__HOME=/home/me\n__CCGUI__PATH=/bin\n");
        let targets = config_targets("codex", &probe);
        let refs: Vec<&ConfigTarget> = targets.iter().collect();
        let drafts = vec![
            WslCliConfigDraft {
                key: "config".to_string(),
                content: "a = 1".to_string(),
                expected_hash: Some("abc".to_string()),
            },
            WslCliConfigDraft {
                key: "auth".to_string(),
                content: "{\"k\":\"v\"}".to_string(),
                expected_hash: None,
            },
        ];
        let script = config_write_script(&refs, &drafts);
        let check_pos = script.find("cfg_check 'config'").unwrap();
        let write_pos = script.find("cfg_write 'config'").unwrap();
        assert!(check_pos < write_pos);
        // base64 内容在脚本里,secret 标记为 1
        assert!(script.contains("cfg_write 'auth' '/home/me/.codex/auth.json' 1 eyJrIjoidiJ9"));
        // 脚本永远 exit 0,冲突/失败走 stdout 哨兵
        assert!(script.ends_with("exit 0\n"));
    }

    #[test]
    fn parse_config_write_reports_conflict_first() {
        let raw = "__CCGUI__CFG_CONFLICT config\n";
        assert_eq!(
            parse_config_write(raw, 1).unwrap_err(),
            "WSL_CLI_CONFIG_CONFLICT:config"
        );
        assert!(parse_config_write("__CCGUI__CFG_WRITE_FAIL auth\n", 1)
            .unwrap_err()
            .starts_with("WSL_CLI_CONFIG_WRITE_FAILED:"));
        assert!(parse_config_write("__CCGUI__CFG_WRITTEN config\n", 1).is_ok());
        assert!(parse_config_write("", 1).is_err());
    }

    // ── pi 供应商认证 ──────────────────────────────────────────

    #[test]
    fn pi_targets_follow_agent_dir() {
        let probe = probe_with_dirs(
            "__CCGUI__HOME=/home/me\n__CCGUI__PATH=/bin\n\
             __CCGUI__PI_AGENT_DIR=/data/pi/\n",
        );
        let targets = pi_targets(&probe);
        assert_eq!(targets.len(), 2);
        assert_eq!(targets[0].key, "auth");
        assert!(targets[0].secret);
        assert_eq!(targets[0].path(), "/data/pi/auth.json");
        assert_eq!(targets[1].key, "models");
        assert!(!targets[1].secret);
        assert_eq!(targets[1].path(), "/data/pi/models.json");

        // 未配置环境变量时回退 $HOME/.pi/agent。
        let probe = probe_with_dirs("__CCGUI__HOME=/home/me\n__CCGUI__PATH=/bin\n");
        let targets = pi_targets(&probe);
        assert_eq!(targets[0].path(), "/home/me/.pi/agent/auth.json");
        assert_eq!(targets[1].path(), "/home/me/.pi/agent/models.json");
    }

    /// 通用编辑器对 pi 保持关闭：auth.json 明文不允许进 webview。
    #[test]
    fn generic_config_targets_stay_closed_for_pi() {
        let probe = probe_with_dirs("__CCGUI__HOME=/home/me\n__CCGUI__PATH=/bin\n");
        assert!(config_targets("pi", &probe).is_empty());
    }

    #[test]
    fn pi_auth_snapshots_mask_keys_and_keep_oauth() {
        let text = r#"{"openai-codex": {"type": "oauth", "refresh": "r"},
                        "anthropic": {"type": "api_key", "key": "sk-ant-1234567890abcd"},
                        "custom-x": {"type": "api_key", "key": "keepme", "env": {"A": "B"}}}"#;
        let map = super::super::pi_family_auth::parse_auth_store(text, "auth.json").unwrap();
        let (providers, oauth) = super::super::pi_family_auth::auth_snapshots(&map);
        let anthropic = providers.iter().find(|p| p.id == "anthropic").unwrap();
        assert_eq!(anthropic.state, "configured");
        let masked = anthropic.masked_key.as_deref().unwrap();
        assert!(masked.starts_with("sk-ant"));
        assert!(masked.ends_with("abcd"));
        assert!(!masked.contains("123456"));
        assert_eq!(oauth, vec!["openai-codex".to_string()]);
    }

    #[test]
    fn pi_auth_apply_set_and_delete_rules() {
        use super::super::pi_family_auth::{apply_delete_credential, apply_set_api_key};
        let mut map = serde_json::Map::new();
        map.insert(
            "openai-codex".to_string(),
            serde_json::json!({"type": "oauth", "refresh": "r"}),
        );

        // oauth-only provider 拒写、空 key 拒收。
        assert!(apply_set_api_key(&mut map, "github-copilot", "x").is_err());
        assert!(apply_set_api_key(&mut map, "anthropic", "  \n ").is_err());
        // oauth 条目拒删。
        assert!(apply_delete_credential(&mut map, "openai-codex").is_err());
        // 正常设置 + 删除。
        apply_set_api_key(&mut map, "anthropic", "sk-ant-test-123456").unwrap();
        assert_eq!(
            map["anthropic"]["key"],
            serde_json::json!("sk-ant-test-123456")
        );
        assert!(apply_delete_credential(&mut map, "anthropic").unwrap());
        assert!(!map.contains_key("anthropic"));
        // 不存在的条目删除 = 无事可做。
        assert!(!apply_delete_credential(&mut map, "anthropic").unwrap());
        // oauth 与未知条目在写入后原样保留。
        apply_set_api_key(&mut map, "openai", "sk-test-openai-1").unwrap();
        assert_eq!(map["openai-codex"]["type"], "oauth");
    }

    #[test]
    fn pi_models_read_reports_parse_error_and_summary() {
        // JSONC 注释 + 非法结构分别走 summary 与 parse_error 分支。
        let ok = "{\n  // relay\n  \"providers\": {\"r\": {\"baseUrl\": \"https://x/v1\", \"models\": [{\"id\": \"m1\"}]}}\n}";
        let value = super::super::pi_family_auth::validate_models_config_text("pi", ok).unwrap();
        let summaries = super::super::pi_family_auth::summarize_providers(&value);
        assert_eq!(summaries.len(), 1);
        assert_eq!(summaries[0].model_count, 1);

        assert!(super::super::pi_family_auth::validate_models_config_text("pi", "{bad").is_err());
        assert!(
            super::super::pi_family_auth::validate_models_config_text(
                "pi",
                "{\"providers\": {\"r\": {\"models\": [{}]}}}"
            )
            .is_err()
        );
    }
}

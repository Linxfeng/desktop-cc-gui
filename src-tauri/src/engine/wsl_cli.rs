//! WSL 发行版内的 CLI 管理状态 —— 只读。
//!
//! 数据源是 [`super::wsl_probe`] 的探测缓存与 `AppSettings.wsl_engine_paths`
//! 的路径覆盖；本模块不直接调用 `wsl.exe`（探测一律经 `wsl_probe::ensure`，
//! 正缓存/失败负缓存/single-flight 都在那里），也不读写发行版内文件。后续的
//! 白名单文件服务会在这里增量扩展，而不是另起一套探测。

use crate::engine::{cli_binary_name, wsl_path, wsl_probe};

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
    }
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
        assert_eq!(
            wsl_cli_capabilities().engines,
            vec!["claude", "kimi", "codex", "pi", "minimax"]
        );
    }
}

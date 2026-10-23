//! WSL 发行版内的引擎模型目录:经 wsl_transport 远程跑各 CLI 的模型命令
//! (bin = 插件探针写进 meta 的发行版内绝对路径),解析复用本机同名解析器。
//! 所有远程 catalog 都带 remote 旗标:即使为空,前端也不得掺本机配置。

use super::{pi, EngineCatalog, EngineModel};

use crate::engine::wsl_transport::WslTransport;

pub(super) async fn pi_family_catalog_remote(
    engine: &str,
    transport: &WslTransport,
) -> EngineCatalog {
    let (Some(bin), Some(cwd)) = (bin_for(transport, engine), remote_cwd(transport)) else {
        return EngineCatalog::authoritative_remote(Vec::new());
    };
    let script = format!("cd {} 2>/dev/null; {} models --json", cwd, bin);
    let discovered = match crate::engine::wsl_transport::run_script_output(transport, &script).await
    {
        Ok(stdout) => pi::parse_models_json(&stdout).unwrap_or_default(),
        Err(_) => Vec::new(),
    };
    if !discovered.is_empty() {
        return EngineCatalog::authoritative_remote(discovered);
    }
    // pi 1.4 的 `models` 子命令还不支持 `--json`(输出是表格)。回退到读
    // 发行版内的 `models.json`,与本机 `configured_models` 同一套解析,
    // 否则 WSL 里的 pi 模型菜单会永远为空。
    let config_script =
        r#"cat "${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/models.json" 2>/dev/null"#.to_string();
    let config = crate::engine::wsl_transport::run_script_output(transport, &config_script)
        .await
        .unwrap_or_default();
    EngineCatalog::authoritative_remote(pi::models_from_config_text(engine, &config))
}

/// Codex 远程目录:`<bin> debug models`(与本机 codex_catalog 同一命令),
/// 失败/为空时回退发行版 `$CODEX_HOME/config.toml` 的 model= 单条。
pub(super) async fn codex_catalog_remote(transport: &WslTransport) -> EngineCatalog {
    let (Some(bin), Some(cwd)) = (bin_for(transport, "codex"), remote_cwd(transport)) else {
        return EngineCatalog::authoritative_remote(Vec::new());
    };
    let script = format!("cd {cwd} 2>/dev/null; {bin} debug models 2>/dev/null");
    if let Ok(stdout) = crate::engine::wsl_transport::run_script_output(transport, &script).await {
        if let Ok(models) = super::codex::parse_codex_models_json(&stdout) {
            if !models.is_empty() {
                return EngineCatalog::authoritative_remote(super::with_default_first(
                    models,
                    codex_config_model_remote(transport).await,
                ));
            }
        }
    }
    EngineCatalog::authoritative_remote(
        codex_config_model_remote(transport)
            .await
            .into_iter()
            .collect(),
    )
}

/// Kimi 远程目录:`<bin> provider list --json`(与本机同命令)。
pub(super) async fn kimi_catalog_remote(transport: &WslTransport) -> EngineCatalog {
    let (Some(bin), Some(cwd)) = (bin_for(transport, "kimi"), remote_cwd(transport)) else {
        return EngineCatalog::authoritative_remote(Vec::new());
    };
    let script = format!("cd {cwd} 2>/dev/null; {bin} provider list --json 2>/dev/null");
    let default = kimi_config_model_remote(transport).await;
    if let Ok(stdout) = crate::engine::wsl_transport::run_script_output(transport, &script).await {
        let models = super::kimi::parse_kimi_provider_list(&stdout);
        if !models.is_empty() {
            // 与本机 kimi_catalog 同语义:配置默认置顶(pick 重置以首项为
            // "CLI 实际默认",字母序兜底会重置到任意条目)。
            return EngineCatalog::authoritative_remote(super::with_default_first(models, default));
        }
    }
    EngineCatalog::authoritative_remote(default.into_iter().collect())
}

/// 发行版内 `$KIMI_CODE_HOME/config.toml`(默认 ~/.kimi-code)的顶层
/// `default_model = "…"`:provider list 失败时唯一可跑的条目。
async fn kimi_config_model_remote(transport: &WslTransport) -> Option<EngineModel> {
    let script = r#"cat "${KIMI_CODE_HOME:-$HOME/.kimi-code}/config.toml" 2>/dev/null"#;
    let content = crate::engine::wsl_transport::run_script_output(transport, script)
        .await
        .ok()?;
    let model = super::parse_top_level_toml_string(&content, "default_model")?;
    Some(EngineModel {
        id: model,
        name: None,
        description: None,
        provider: "kimi".to_string(),
        context_window: None,
    })
}

/// Claude 远程目录:CLI 别名是内置常量,逐字段合并发行版
/// `$CLAUDE_CONFIG_DIR` 的 settings.json / settings.local.json(与本机
/// read_cli_config_from 同一合并语义),复现 distro 自己的 /model 菜单。
pub(super) async fn claude_catalog_remote(transport: &WslTransport) -> EngineCatalog {
    // 随机分隔符:固定串可能出现在 settings 内容里(env 值等),split_once
    // 取首次出现会把 user settings 后半截当 local 合并,优先级错乱。
    let sep = format!("=CCGUI_SEP_{}=", uuid::Uuid::new_v4().simple());
    let script = format!(
        r#"d="${{CLAUDE_CONFIG_DIR:-$HOME/.claude}}"; cat "$d/settings.json" 2>/dev/null; echo "{sep}"; cat "$d/settings.local.json" 2>/dev/null"#
    );
    let out = crate::engine::wsl_transport::run_script_output(transport, &script)
        .await
        .unwrap_or_default();
    let (user, local) = match out.split_once(&sep) {
        Some((u, l)) => (u, l),
        None => (out.as_str(), ""),
    };
    EngineCatalog::authoritative_remote(super::claude::claude_models_remote(user, local))
}
fn bin_for(transport: &WslTransport, engine: &str) -> Option<String> {
    let bin = transport.engine_paths.get(engine)?;
    if transport.is_local() {
        // 本机后端的覆盖路径允许空格/中文(与设置页校验一致,§10 D9):
        // 按 shell 引号包裹而不是拒绝,否则模型菜单会静默为空。
        if bin.is_empty() || bin.chars().any(char::is_control) {
            return None;
        }
        return Some(crate::engine::wsl_transport::sh_quote(bin));
    }
    // SSH 后端沿用历史白名单:插件登记的远端路径不做引号处理。
    let safe = shell_safe_bin(bin);
    (!safe.is_empty()).then_some(safe)
}

/// 发行版内 `$CODEX_HOME/config.toml`(默认 ~/.codex)的顶层 model=。
async fn codex_config_model_remote(transport: &WslTransport) -> Option<EngineModel> {
    let script = r#"cat "${CODEX_HOME:-$HOME/.codex}/config.toml" 2>/dev/null"#;
    let content = crate::engine::wsl_transport::run_script_output(transport, script)
        .await
        .ok()?;
    let model = super::parse_top_level_toml_string(&content, "model")?;
    Some(EngineModel {
        id: model,
        name: None,
        description: None,
        provider: "codex".to_string(),
        context_window: None,
    })
}

/// 发行版内 `cd` 目标(已按 shell 规则引号包裹,可直接拼进脚本)。
///
/// `Local` 后端的 workspace 来自 UNC 解析,允许空格/中文/引号(实机 V1),
/// 所以一律 `sh_quote`;`Ssh` 后端沿用既有字符白名单 —— 插件登记的远端路径
/// 不做引号处理是历史形态,改它会改变既有可用行为。
fn remote_cwd(transport: &WslTransport) -> Option<String> {
    match &transport.workspace {
        Some(ws) if transport.is_local() => Some(crate::engine::wsl_transport::sh_quote(ws)),
        Some(ws) => crate::engine::wsl_transport::is_safe_workspace(ws).then(|| ws.clone()),
        None => Some("~".to_string()),
    }
}

/// 探针写入的路径来自 `command -v` 输出(发行版内绝对路径),再过一遍
/// 白名单防御:仅 `[A-Za-z0-9_./~-]`,违例返回空串让命令失败而非注入。
fn shell_safe_bin(bin: &str) -> String {
    if bin.is_empty()
        || bin
            .chars()
            .any(|c| !(c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '/' | '-' | '~')))
    {
        return String::new();
    }
    bin.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bin_allowlist_rejects_injection() {
        assert_eq!(
            shell_safe_bin("/home/u/.local/bin/omp"),
            "/home/u/.local/bin/omp"
        );
        assert_eq!(shell_safe_bin("/x; rm -rf /"), "");
        assert_eq!(shell_safe_bin("/a b/c"), "");
        assert_eq!(shell_safe_bin(""), "");
    }

    fn tp(workspace: Option<&str>) -> WslTransport {
        WslTransport {
            backend: crate::engine::wsl_transport::WslBackend::Ssh {
                host: "10.0.0.2".into(),
                port: 22,
                user: "dev".into(),
                control_path: None,
            },
            distro: "Ubuntu".into(),
            engine_paths: Default::default(),
            workspace: workspace.map(str::to_string),
            shell_path: None,
            codex_home: None,
            claude_home: None,
            pi_agent_dir: None,
        }
    }

    /// 本机后端的覆盖路径允许空格/中文,消费侧必须用同一套规则:
    /// 引号包裹而不是静默丢弃(§10 D9)。
    #[test]
    fn local_bin_quotes_paths_the_settings_page_accepts() {
        let mut t = tp(None);
        t.backend = crate::engine::wsl_transport::WslBackend::Local;
        t.engine_paths
            .insert("omp".into(), "/home/u/my bin/omp".into());
        assert_eq!(bin_for(&t, "omp").as_deref(), Some("'/home/u/my bin/omp'"));
        t.engine_paths
            .insert("omp".into(), "/home/u/我的/bin/omp".into());
        assert_eq!(bin_for(&t, "omp").as_deref(), Some("'/home/u/我的/bin/omp'"));
    }

    #[test]
    fn remote_cwd_rejects_injection_shaped_workspace() {
        // catalog 脚本直排 `cd <cwd>`,违例 workspace 必须拿不到 cwd
        // (空 catalog),而不是拼进脚本(catalog 路径曾与 build_script
        // 白名单脱节,是注入面)。
        assert_eq!(
            remote_cwd(&tp(Some("/home/dev/proj"))).as_deref(),
            Some("/home/dev/proj")
        );
        assert_eq!(remote_cwd(&tp(None)).as_deref(), Some("~"));
        assert!(remote_cwd(&tp(Some("/home/dev/my proj"))).is_none());
        assert!(remote_cwd(&tp(Some("/x;id"))).is_none());
        assert!(remote_cwd(&tp(Some("/x$(id)"))).is_none());
    }

    /// 本机后端的 workspace 来自 UNC(空格、中文都合法,V1):按 shell 引号
    /// 包裹而不是拒绝,否则这类工作区的模型菜单永远是空的。
    #[test]
    fn local_cwd_quotes_whatever_unc_allows() {
        let mut t = tp(Some("/home/dev/我的 项目"));
        t.backend = crate::engine::wsl_transport::WslBackend::Local;
        assert_eq!(remote_cwd(&t).as_deref(), Some("'/home/dev/我的 项目'"));
        // 单引号本身也被转义,不会闭合引号。
        let mut quoted = tp(Some("/home/dev/it's"));
        quoted.backend = crate::engine::wsl_transport::WslBackend::Local;
        assert_eq!(remote_cwd(&quoted).as_deref(), Some(r"'/home/dev/it'\''s'"));
    }
}

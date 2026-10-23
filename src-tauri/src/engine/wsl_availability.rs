//! 本机 WSL 的引擎可用性、发行版列表与"重新检测"入口。
//!
//! 前端 composer 的引擎菜单用 [`wsl_engine_availability`] 代替本机 CLI 探测:
//! 本机 Windows 侧没装 CLI **不得**隐藏引擎 —— 发行版里装着就能用。判断
//! 依据是 [`super::wsl_probe`] 在发行版内 `bash -ic` 探到的绝对路径
//! (本机探针看不到 nvm/`~/.local/bin` 里的 CLI,实机 V4/V5)。
//!
//! 设置页用 [`wsl_distros`] 列出已安装发行版,用 [`wsl_reprobe`] 在用户改了
//! CLI 之后立即失效缓存并重新探测(不必重启应用)。

use crate::engine::{wsl_path, wsl_probe, wsl_transport};

/// 该工作区在发行版内可用的引擎 id 列表(按 `config::ENGINES` 的顺序)。
///
/// 非 WSL 工作区返回空表:调用方只在 `wsl_path::parse_wsl_unc` 命中时才用它,
/// 空表 = 不覆盖本机探测。
#[tauri::command]
pub async fn wsl_engine_availability(
    state: tauri::State<'_, crate::AppState>,
    workspace_path: String,
) -> Result<Vec<String>, String> {
    // 与发送/回放同一判定:meta.wsl 优先,UNC 只在没有显式 meta 时才算本机。
    wsl_transport::transport_for_workspace(&state.db, &workspace_path)?
        .filter(|tp| tp.is_local())
        .ok_or_else(|| format!("不是本机 WSL 工作区: {workspace_path}"))?;
    let unc = wsl_path::parse_wsl_unc(&workspace_path)
        .ok_or_else(|| format!("不是 WSL 工作区: {workspace_path}"))?;
    let probe = wsl_probe::ensure(&unc.distro)
        .await
        .map_err(|e| e.code())?;
    Ok(available_engines(&unc.distro, &probe))
}

/// 探测结果 + 设置里的发行版内 CLI 覆盖 → 可用引擎 id(按 `config::ENGINES`
/// 顺序)。覆盖也是"发行版内有这个 CLI"的证据,所以与探测结果合并,而不是
/// 只认探测 —— 否则手工指定的 CLI 在菜单里仍然不可见。
fn available_engines(distro: &str, probe: &wsl_probe::WslProbe) -> Vec<String> {
    let overridden: std::collections::HashSet<String> =
        crate::settings::read_settings()
            .map(|settings| {
                crate::settings::wsl_engine_overrides(&settings, distro)
                    .into_iter()
                    .map(|(engine, _)| engine)
                    .collect()
            })
            .unwrap_or_default();
    crate::config::ENGINES
        .iter()
        .filter(|id| super::wsl_cli::supported_engine(id))
        .filter(|id| {
            // 探测表按**命令名**建键(minimax 的 CLI 叫 mcode),不是引擎 id。
            probe.bin(crate::engine::cli_binary_name(id)).is_some() || overridden.contains(**id)
        })
        .map(|id| id.to_string())
        .collect()
}

/// 已安装发行版(`wsl.exe -l -q`)。`WSL_UTF8=1` 之外的旧版输出按 UTF-16LE
/// 兜底解码(实机 V16);查不到时返回空表,界面据此提示"未检测到 WSL"。
#[tauri::command]
pub async fn wsl_distros() -> Result<Vec<String>, String> {
    wsl_probe::list_distros_result().await.map_err(|e| e.code())
}

/// 用户点"重新检测":丢弃该发行版(或全部)的探测缓存,再探测一次。
/// 返回探测成功时的引擎 id 列表;失败返回稳定错误码(前端映射 i18n)。
///
/// 发行版列表在界面上是一行一个的探测结果,所以返回每个发行版各有哪些
/// CLI(空表 = 列表读不到;单个发行版探测失败按"该发行版没有可用 CLI"
/// 处理,并在控制台留下原因,不因为一个发行版起不来让整页报错)。
#[tauri::command]
pub async fn wsl_reprobe(distro: Option<String>) -> Result<Vec<WslDistroEngines>, String> {
    match distro.as_deref().map(str::trim).filter(|d| !d.is_empty()) {
        Some(distro) => {
            wsl_probe::invalidate(distro);
            let probe = wsl_probe::ensure(distro).await.map_err(|e| e.code())?;
            Ok(vec![WslDistroEngines {
                distro: distro.to_string(),
                engines: available_engines(distro, &probe),
                versions: engine_versions(&probe),
            }])
        }
        None => Ok(probe_distros(true).await),
    }
}

/// 设置页挂载时读取当前探测结果:**不失效缓存**,只对没有缓存的发行版
/// 补一次探测。否则每次打开设置页都会清掉 composer 正在用的探测结果,
/// 让「缓存」与「重新检测」失去语义差别(§10 P1-20)。
#[tauri::command]
pub async fn wsl_probe_snapshot() -> Vec<WslDistroEngines> {
    probe_distros(false).await
}

/// 按发行版并行探测;`force` 为真时先失效缓存。发行版之间互不依赖,
/// 串行会把 N 个 30s 超时叠起来(§10 P1-20)。
async fn probe_distros(force: bool) -> Vec<WslDistroEngines> {
    let distros = wsl_probe::list_distros().await;
    let mut set = tokio::task::JoinSet::new();
    for (index, distro) in distros.iter().cloned().enumerate() {
        set.spawn(async move {
            if force {
                wsl_probe::invalidate(&distro);
            }
            // 探测失败的发行版按"没有可用 CLI"处理:版本也为空,不是整页报错。
            let row = match wsl_probe::ensure(&distro).await {
                Ok(probe) => WslDistroEngines {
                    distro: distro.clone(),
                    engines: available_engines(&distro, &probe),
                    versions: engine_versions(&probe),
                },
                Err(error) => {
                    eprintln!(
                        "[wsl] re-probe failed (distro={distro}): {}",
                        error.code()
                    );
                    WslDistroEngines {
                        distro: distro.clone(),
                        engines: Vec::new(),
                        versions: Default::default(),
                    }
                }
            };
            (index, row)
        });
    }
    let mut rows = Vec::with_capacity(distros.len());
    while let Some(result) = set.join_next().await {
        if let Ok(row) = result {
            rows.push(row);
        }
    }
    rows.sort_by_key(|(index, _)| *index);
    rows.into_iter().map(|(_, row)| row).collect()
}

/// 引擎 id → 发行版内 CLI 版本(设置页每个发行版的徽标上展示)。
///
/// 探测表按命令名建键(`minimax` → `mcode`),这里换回引擎 id;手工覆盖的
/// 引擎不在探测结果里,自然没有版本 —— 不为了补一行版本再跑一次 CLI。
fn engine_versions(probe: &wsl_probe::WslProbe) -> std::collections::BTreeMap<String, String> {
    crate::config::ENGINES
        .iter()
        .filter_map(|id| {
            probe
                .versions
                .get(crate::engine::cli_binary_name(id))
                .map(|version| (id.to_string(), version.clone()))
        })
        .collect()
}

/// 设置页"重新检测"的结果行:发行版 + 该发行版内可用的引擎 id。
#[derive(Debug, Clone, serde::Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WslDistroEngines {
    pub distro: String,
    pub engines: Vec<String>,
    /// 引擎 id → 版本号;没有探测到版本的引擎不出现在这里。
    pub versions: std::collections::BTreeMap<String, String>,
}

/// 启动兜底:对已知发行版回收上次运行残留的 Linux 会话(§5.7 第 4 条)。
///
/// 与「重新检测」不同,它没有 UI 反馈,只能在启动时后台跑一次 —— 上次进程
/// 是被强杀/崩溃带走的,用户不会知道有没有残留。发行版起不来只记日志:
/// 启动路径不该因为 WSL 状态阻塞窗口创建。
/// 退出时的同步清扫:窗口 `Destroyed` 回调没有 Tokio 上下文,不能在调用点
/// 直接 `block_on(timeout(...))` —— `tokio::time::timeout` 会在构造时读取
/// 当前时间,那时还没有 reactor,退出会 panic。这里自建 current-thread
/// runtime,并在 `block_on` 的异步块**内部**构造 timeout。
pub fn reclaim_all_on_exit_blocking() {
    let Ok(runtime) = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
    else {
        return;
    };
    let _ = runtime.block_on(async {
        let _ = tokio::time::timeout(std::time::Duration::from_secs(5), async {
            for distro in wsl_probe::list_distros().await {
                let _ = super::wsl_transport::reclaim_startup_runs(&distro).await;
            }
        })
        .await;
    });
}

pub async fn reclaim_startup_sessions() {
    for distro in wsl_probe::list_distros().await {
        if let Err(error) = super::wsl_transport::reclaim_startup_runs(&distro).await {
            eprintln!(
                "[wsl] 启动兜底回收失败(distro={distro}): {error}; 发行版内可能有残留进程"
            );
            super::wsl_notice::record_unproven(&distro, "startup");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn non_wsl_paths_are_rejected_before_probing() {
        // 纯函数路径:非 UNC 直接报错,不会触发任何 wsl.exe 调用。
        assert!(wsl_path::parse_wsl_unc(r"C:\Users\me\repo").is_none());
        assert!(wsl_path::parse_wsl_unc(r"\\server\share").is_none());
    }

    /// 回归:退出清扫在没有 Tokio 上下文的普通线程里也必须能建 reactor;
    /// timeout 构造顺序写反会在窗口关闭时 panic。
    #[test]
    fn exit_reclaim_builds_its_own_reactor() {
        std::thread::spawn(reclaim_all_on_exit_blocking)
            .join()
            .expect("exit reclaim must not panic");
    }

    #[test]
    fn menu_hides_engines_this_backend_cannot_run() {
        // pi 是 Child 传输,当前支持;grok/omp 即使装着也会在发送时被
        // Own/staging 门禁拒绝,菜单不应先列出来。
        assert!(super::super::wsl_cli::supported_engine("pi"));
        assert!(super::super::wsl_cli::supported_engine("claude"));
        assert!(!super::super::wsl_cli::supported_engine("grok"));
        assert!(!super::super::wsl_cli::supported_engine("omp"));
    }

    #[test]
    fn engine_list_follows_probe_results() {
        // 探测表按名字过滤;顺序以 ENGINES 为准(菜单顺序稳定)。
        let probe = wsl_probe::parse_probe_output(
            "__CCGUI__HOME=/home/me\n__CCGUI__PATH=/usr/bin\n__CCGUI__BIN codex=/usr/bin/codex\n__CCGUI__BIN claude=/usr/bin/claude\n",
        )
        .expect("probe parses");
        let available = available_engines("Ubuntu-test", &probe);
        assert_eq!(available.len(), 2);
        assert!(available.contains(&"claude".to_string()) && available.contains(&"codex".to_string()));
    }

    /// MiniMax 的 CLI 叫 `mcode`:探测表按命令名建键,引擎 id 与它不同。
    /// 按 id 查表会让发行版里装着的 mcode 在菜单里永远不出现(§5.6
    /// 明确支持 MiniMax 的 Child 路径)。
    #[test]
    fn engine_ids_are_mapped_to_their_cli_binary_names() {
        let probe = wsl_probe::parse_probe_output(
            "__CCGUI__HOME=/home/me\n__CCGUI__PATH=/usr/bin\n__CCGUI__BIN mcode=/usr/local/bin/mcode\n",
        )
        .expect("probe parses");
        assert_eq!(available_engines("Ubuntu-test", &probe), vec!["minimax"]);
    }

    /// 版本表同样按引擎 id 交给前端:探测表里是命令名 `mcode`,界面认的是
    /// `minimax`(与 `available_engines` 同一套映射)。
    #[test]
    fn versions_follow_engine_ids_not_binary_names() {
        let probe = wsl_probe::parse_probe_output(
            "__CCGUI__HOME=/home/me\n__CCGUI__PATH=/usr/bin\n__CCGUI__BIN mcode=/usr/local/bin/mcode\n__CCGUI__VER mcode=0.4.2\n",
        )
        .expect("probe parses");
        let versions = engine_versions(&probe);
        assert_eq!(versions.get("minimax").map(String::as_str), Some("0.4.2"));
        assert!(!versions.contains_key("mcode"));
    }

    /// 设置里的发行版内覆盖也是"发行版里有这个 CLI"的证据:只认探测结果会
    /// 让手工指定的 CLI 在 composer 菜单里永远不可见。
    #[test]
    fn settings_overrides_are_read_per_distro() {
        let _ = wsl_probe::parse_probe_output(
            "__CCGUI__HOME=/home/me\n__CCGUI__PATH=/usr/bin\n",
        )
        .expect("probe parses");
        let mut settings = crate::settings::AppSettings::default();
        settings
            .wsl_engine_paths
            .insert("Ubuntu-override:omp".into(), "/opt/omp/bin/omp".into());
        // 只统计属于该发行版的键(同名 CLI 在别的发行版里不算)。
        settings
            .wsl_engine_paths
            .insert("Debian-other:grok".into(), "/opt/grok".into());
        let overrides = crate::settings::wsl_engine_overrides(&settings, "Ubuntu-override");
        assert_eq!(
            overrides,
            vec![("omp".to_string(), "/opt/omp/bin/omp".to_string())]
        );
    }
}

//! WSL 远程 spawn 通道 —— 把本机构造的引擎命令包装成 `ssh → wsl.exe` 或本机
//! `wsl.exe` 执行。
//!
//! 两种后端共用同一套调用方(send / models / history 三条链路都已收口到
//! 本模块),差别只在 [`WslBackend`]:
//!
//! - [`WslBackend::Ssh`]:插件 `ccgui-plugin-wsl` 在 `meta.wsl` 里登记的远程
//!   Windows 宿主 —— `ssh <host> "wsl.exe -d <distro> -- …"`,脚本先经 stdin
//!   写到远端 `/tmp`。这是既有行为,除 §探测解析修复外保持不变。
//! - [`WslBackend::Local`]:本机工作区直接是 `\\wsl.localhost\<distro>\…`
//!   (系统文件夹选择器选出来的 UNC 路径),不需要插件、不出站。命令直接以
//!   `wsl.exe -d <distro> --exec …` 启动,argv 逐字到达(实机 V1),密钥
//!   经 `WSLENV` 传递(V9),不落盘。
//!
//! 本机后端的两个实机约束决定了命令形状:
//! - `--cd` 在不存在的目录上会打印错误却**在 `/` 下继续执行且退出码为 0**
//!   (V6),所以 cwd 交给启动器 `cd … || exit 61`;
//! - 裸命令名在 nvm 环境里找不到(V2),所以 CLI 传探测缓存的绝对路径
//!   ([`super::wsl_probe`])。
//!
//! 中断:杀本地 `wsl.exe` 会让 Linux 会话收到 SIGHUP(V12),但忽略 HUP 的
//! 进程(nohup 起的 dev server)会存活(V13),所以启动器写 pidfile
//! (内容即会话 id),中断时再按会话 `pkill -s` 回收(见
//! [`kill_run_script`])。启动器与 pidfile 都放在发行版 `/tmp`:`/run/user`
//! 在 `--exec` 起的非登录会话里常常不存在(见 [`LOCAL_LAUNCHER`])。

use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Stdio;
use std::time::Duration;

use tokio::process::Command;

use super::wsl_path::{self, is_safe_distro};

/// 远程短调用(脚本上传/模型目录/历史回放拉取)的全局 deadline。
/// ssh_options 的 ConnectTimeout 只覆盖 TCP 建连;远端建连后挂起(wsl.exe
/// 无响应/管道写满)没有它会让 tauri 命令 future 永不 resolve,前端无
/// 取消路径,发送/模型选择/历史翻页全部卡死到 app 重启。引擎会话本体
/// (wrap 出的长驻 run 命令)不在此列——它的存活期就是 turn 的存活期。
const REMOTE_CALL_TIMEOUT: Duration = Duration::from_secs(30);

/// 本机后端转录本直传的 deadline。512 MiB 上限按实测约 20 MB/s(V22)约
/// 26s,留足余量;常规会话(几十 MB)远在 30s 以内,单独放宽只影响回放。
const LOCAL_TRANSCRIPT_TIMEOUT: Duration = Duration::from_secs(180);

/// 本机启动器的退出码约定(§4.3 / V14):61 = 工作目录不存在,127 = CLI
/// 不存在,126 = CLI 不可执行。`wsl.exe` 自己失败时退出码是 1 且错误在
/// stdout/stderr(V2/V15),两套语义不能混。
pub(crate) const LAUNCH_CWD_MISSING: i32 = 61;
pub(crate) const LAUNCH_CLI_MISSING: i32 = 127;
pub(crate) const LAUNCH_CLI_NOT_EXECUTABLE: i32 = 126;

/// 稳定错误前缀:CLI 在发行版内不可用。前端 `errorText` 依赖它(与
/// `WSL_PROBE_FAILED:` 同源,细节只是给日志/排障看)。
pub(crate) const CLI_NOT_FOUND_PREFIX: &str = "WSL_CLI_NOT_FOUND:";
/// 稳定错误前缀:启动器 `cd` 失败(工作区目录在发行版内不存在,V14 退出码
/// 61)。绝不能退回在 `/` 下跑 CLI(V6)。
pub(crate) const CWD_NOT_FOUND_PREFIX: &str = "WSL_CWD_NOT_FOUND:";
/// 稳定错误前缀:CLI 存在但不可执行(启动器退出码 126)。
pub(crate) const CLI_NOT_EXECUTABLE_PREFIX: &str = "WSL_CLI_NOT_EXECUTABLE:";

/// 本机后端的启动器。编译期常量,**不拼接任何运行时数据**:
/// `$1` = run id(也是 pidfile 名),`$2` = 发行版内 cwd,其后是 CLI 绝对
/// 路径与 argv。`--exec` 起的进程已是会话组长(V11),不要再套 `setsid`;
/// 启动器由 `/bin/sh <path>` 执行(不读 profile,`echo hello` 不会混进
/// NDJSON)。
///
/// pidfile 写在**启动器脚本同目录**(`$0` 的 dirname),不用
/// `${XDG_RUNTIME_DIR:-/tmp}`:WSLENV 会把 Windows 侧的 `XDG_RUNTIME_DIR`
/// 带进发行版,而发行版里的 `/run/user/<uid>` 在非登录会话下常常不存在或
/// 不可写。实测该写法 `echo $$ > …` 失败后 `pkill -s` 读不到 pidfile,
/// 回收静默失效 —— 正是 V13(nohup 进程存活)要防的场景。
pub(crate) const LOCAL_LAUNCHER: &str = r#"[ -n "$CCGUI_WSL_PATH" ] && export PATH="$CCGUI_WSL_PATH"
echo "$$ $(awk '{print $22}' "/proc/$$/stat" 2>/dev/null)" > "$(dirname "$0")/ccgui-run-${CCGUI_WSL_INSTANCE}-$1.pid"
cd -- "$2" || exit 61
shift 2
exec "$@""#;

/// 中断/正常结束时的会话回收脚本(经 `bash -s` stdin 送入,run id 作为
/// 位置参数,不拼进脚本文本)。`pkill -s` 按会话 id 回收整个 Linux 会话,
/// 包括忽略 SIGHUP 的后台进程(V13);只处理本应用写的 pidfile(与启动器
/// 同目录,见 [`unix_launcher_path`])。
pub(crate) fn kill_run_script(hard: bool) -> String {
    if hard {
        // 退出码语义:0/1 = 已确认(或目标已不存在),2 = 无凭证,
        // 3 = sid 已被复用,4 = pkill 未能证明(§5.7)。
        "f=\"$(dirname \"$2\")/ccgui-run-${CCGUI_WSL_INSTANCE}-$1.pid\"\n\
[ -r \"$f\" ] || exit 2\n\
read -r s start < \"$f\" || exit 2\n\
now=$(awk '{print $22}' \"/proc/$s/stat\" 2>/dev/null) || { rm -f \"$f\"; rm -f -- \"$2\"; exit 0; }\n\
[ \"$now\" = \"$start\" ] || exit 3\n\
pkill -TERM -s \"$s\" 2>/dev/null\n\
sleep 1\n\
pkill -KILL -s \"$s\" 2>/dev/null\n\
rc=$?\n\
rm -f \"$f\"\n\
rm -f -- \"$2\"\n\
[ \"$rc\" -le 1 ] || exit 4\n\
exit 0"
            .to_string()
    } else {
        // 正常结束:只删启动器脚本。pidfile 保留到应用退出/下次启动清扫,
        // 否则 CLI 用 nohup 拉起的 dev server 在关闭 GUI 时失去唯一句柄
        // (§5.7 第 3 条)。
        "rm -f -- \"$2\"\nexit 0".to_string()
    }
}

/// 后端:远程 `meta.wsl`(ssh)还是本机 WSL 发行版。
#[derive(Debug, Clone)]
pub enum WslBackend {
    /// 现有:ssh → 远程 Windows → wsl.exe(插件 meta.wsl)
    Ssh {
        host: String,
        port: u16,
        user: String,
        control_path: Option<String>,
    },
    /// 新增:本机 wsl.exe(工作区是 `\\wsl.localhost\…` UNC 路径)
    Local,
}

/// 一次 WSL 传输的描述。
#[derive(Debug, Clone)]
pub struct WslTransport {
    pub backend: WslBackend,
    /// 发行版名(wsl.exe -d)。
    pub distro: String,
    /// 引擎 bin 在发行版内的绝对路径(bin 名 → 路径)。
    ///
    /// `Ssh` 后端来自插件探针写入的 `enginePaths`;`Local` 后端来自
    /// [`super::wsl_probe`] 的探测缓存。
    pub engine_paths: HashMap<String, String>,
    /// 工作区在发行版内的路径(`cd` 目标;缺省 = 发行版默认 cwd)。
    pub workspace: Option<String>,
    /// `Local` 后端探测到的交互 shell PATH(`CCGUI_WSL_PATH`);`Ssh` 为空。
    pub shell_path: Option<String>,
    /// `Local` 后端的 `$CODEX_HOME`(未设置时为空,脚本侧回退默认值)。
    pub codex_home: Option<String>,
    /// `Local` 后端的 `$CLAUDE_CONFIG_DIR`(未设置时为空,脚本侧回退
    /// `$HOME/.claude`)。历史扫描、回放授权与 CLI 必须看同一个目录。
    pub claude_home: Option<String>,
    /// `Local` 后端的 `$PI_CODING_AGENT_DIR`(未设置时为空,脚本侧回退
    /// `$HOME/.pi/agent`)。pi 的会话与模型配置都在这个目录下。
    pub pi_agent_dir: Option<String>,
}

impl WslTransport {
    pub fn is_local(&self) -> bool {
        matches!(self.backend, WslBackend::Local)
    }

    /// ssh 后端的连接参数(本机后端返回 None)。
    fn ssh(&self) -> Option<(&str, u16, &str, Option<&str>)> {
        match &self.backend {
            WslBackend::Ssh {
                host,
                port,
                user,
                control_path,
            } => Some((host, *port, user, control_path.as_deref())),
            WslBackend::Local => None,
        }
    }
}

/// 从工作区 `meta` JSON 提取 ssh 传输描述;形状不符 = None(按本地工作区跑)。
pub fn from_workspace_meta(meta: &serde_json::Value) -> Option<WslTransport> {
    let wsl = meta.get("wsl")?;
    let host = wsl.get("host")?.as_str()?.trim().to_string();
    if !is_safe_host(&host) {
        return None;
    }
    let user = wsl.get("user")?.as_str()?.trim().to_string();
    if !is_safe_user(&user) {
        return None;
    }
    let distro = wsl.get("distro")?.as_str()?.trim().to_string();
    if !is_safe_distro(&distro) {
        return None;
    }
    let engine_paths = wsl
        .get("enginePaths")
        .and_then(|v| v.as_object())
        .map(|o| {
            o.iter()
                .filter_map(|(k, v)| {
                    let path = v.as_str()?.trim();
                    (!path.is_empty()).then(|| (k.clone(), path.to_string()))
                })
                .collect()
        })
        .unwrap_or_default();
    Some(WslTransport {
        backend: WslBackend::Ssh {
            host,
            port: match wsl.get("port") {
                Some(v) => v.as_u64()?.try_into().ok()?,
                None => 22,
            },
            user,
            control_path: wsl
                .get("controlPath")
                .and_then(|v| v.as_str())
                .map(str::to_string)
                .filter(|s| !s.trim().is_empty()),
        },
        distro,
        engine_paths,
        workspace: wsl
            .get("workspace")
            .and_then(|v| v.as_str())
            .map(str::to_string)
            .filter(|s| !s.trim().is_empty()),
        shell_path: None,
        codex_home: None,
        claude_home: None,
        pi_agent_dir: None,
    })
}

/// 本机 WSL 传输描述:工作区 UNC → `Local` 后端。探测缓存命中时带上
/// 发行版内的 CLI 路径与 PATH;未命中(尚未探测)留空,调用方经
/// [`ensure_local_probe`] 补齐。
pub fn local_transport(unc: &wsl_path::WslUncPath) -> WslTransport {
    let probe = super::wsl_probe::cached(&unc.distro);
    let mut engine_paths: HashMap<String, String> = probe
        .as_ref()
        .map(|p| {
            p.bins
                .iter()
                .map(|(k, v)| (k.clone(), v.clone()))
                .collect()
        })
        .unwrap_or_default();
    merge_engine_overrides(&mut engine_paths, &unc.distro);
    WslTransport {
        backend: WslBackend::Local,
        distro: unc.distro.clone(),
        engine_paths,
        workspace: Some(unc.linux_path.clone()),
        shell_path: probe.as_ref().map(|p| p.path.clone()),
        codex_home: probe
            .as_ref()
            .map(|p| p.codex_home.clone())
            .filter(|c| !c.is_empty()),
        claude_home: probe
            .as_ref()
            .map(|p| p.claude_home.clone())
            .filter(|c| !c.is_empty()),
        pi_agent_dir: probe
            .as_ref()
            .map(|p| p.pi_agent_dir.clone())
            .filter(|c| !c.is_empty()),
    }
}

/// 单次读取本机设置里的发行版内 CLI 覆盖(`wsl:distro:engine` → 绝对路径)。
/// 设置文件很小,而传输描述的构造发生在每次发送 / 模型目录 / 会话扫描前;
/// 失败(文件损坏、正在被写)按"没有覆盖"处理,不影响既有探测结果。
fn local_engine_overrides(distro: &str) -> Vec<(String, String)> {
    let Ok(settings) = crate::settings::read_settings() else {
        return Vec::new();
    };
    crate::settings::wsl_engine_overrides(&settings, distro)
}

/// 把设置里的覆盖并进 `engine_paths`。发送路径按**命令名**查表
/// (`mcode`),设置页按**引擎 id** 存(`minimax`),两个键都要登记 ——
/// 否则给 minimax 指定的路径永远轮不到发送路径看见。
fn merge_engine_overrides(engine_paths: &mut HashMap<String, String>, distro: &str) {
    for (engine, path) in local_engine_overrides(distro) {
        engine_paths.insert(super::cli_binary_name(&engine).to_string(), path.clone());
        engine_paths.insert(engine, path);
    }
}

/// 确保 `Local` 传输携带探测结果(缓存未命中/已过期时跑一次探测)。
/// send 路径在 spawn 前 await 它;短调用路径由调用方决定是否等待。
///
/// 设置里的发行版内 CLI 覆盖优先于探测结果(用户显式指定的路径不能被
/// `command -v` 找到的旧版本盖掉)。
pub async fn ensure_local_probe(
    transport: &mut WslTransport,
) -> Result<std::sync::Arc<super::wsl_probe::WslProbe>, String> {
    let probe = super::wsl_probe::ensure(&transport.distro)
        .await
        .map_err(|e| e.code())?;
    apply_probe(transport, &probe);
    Ok(probe)
}

/// 丢弃某发行版的探测缓存(§5.4:CLI 路径已失效时下一次发送必须重新探测)。
pub fn invalidate_local_probe(transport: &WslTransport) {
    super::wsl_probe::invalidate(&transport.distro);
}

/// 发送前的 CLI 预检(§5.4「失效 → 重探测一次后重试一次」的另一半)。
///
/// 为什么放在 spawn 之前:启动器只在**跑完**之后才能报 127/126,那时读取
/// 任务已结束、事件流已收敛,重跑要重建整条链路;而探测缓存有 5 分钟 TTL,
/// 期间 CLI 可能被卸载/改名/去掉执行位。这里在进程尚未起来时花一次短调用
/// 确认探测到的路径仍然可用,失败即清缓存由调用方重探测再试一次。
///
/// 返回的错误串沿用启动器的稳定前缀(127 → `WSL_CLI_NOT_FOUND:`,126 →
/// `WSL_CLI_NOT_EXECUTABLE:`),前端文案与"跑到一半才发现"完全一致。
pub async fn verify_local_cli(transport: &WslTransport, engine: &str) -> Result<(), String> {
    // 引擎 id 与 CLI 命令名可能不同(minimax → mcode):探测表按命令名建键。
    let bin = super::cli_binary_name(engine);
    let Some(cli) = resolve_local_program(bin, transport).ok() else {
        return Err(format!("{CLI_NOT_FOUND_PREFIX}{bin}"));
    };
    // 脚本始终以 0 退出并打印哨兵:`exec_local_exit` 对非零退出直接返回
    // Err,靠退出码 126/127 区分会变成不可达分支(§10 P1-5)。
    // `test -x` 之外还要确认它是文件:目录同样可能"可进入"。
    let script = format!(
        "p={}\n\
         if [ ! -f \"$p\" ]; then echo __CCGUI_CLI_MISSING__; exit 0; fi\n\
         if [ ! -x \"$p\" ]; then echo __CCGUI_CLI_NOT_EXEC__; exit 0; fi\n\
         echo __CCGUI_CLI_OK__",
        sh_quote(&cli)
    );
    let output = exec_local(transport, &script, REMOTE_CALL_TIMEOUT).await?;
    let text = String::from_utf8_lossy(&output);
    if text.contains("__CCGUI_CLI_MISSING__") {
        Err(format!("{CLI_NOT_FOUND_PREFIX}{bin}"))
    } else if text.contains("__CCGUI_CLI_NOT_EXEC__") {
        Err(format!("{CLI_NOT_EXECUTABLE_PREFIX}{bin}"))
    } else if text.contains("__CCGUI_CLI_OK__") {
        Ok(())
    } else {
        Err(format!(
            "WSL_SHORT_CALL_FAILED:预检没有返回可识别结果: {}",
            text.trim()
        ))
    }
}

/// 把探测结果并进传输描述(CLI 绝对路径、交互 PATH、`$CODEX_HOME`)。设置里
/// 的发行版内 CLI 覆盖优先于探测结果(用户显式指定的路径不能被 `command -v`
/// 找到的旧版本盖掉)。
pub fn apply_probe(transport: &mut WslTransport, probe: &super::wsl_probe::WslProbe) {
    transport.engine_paths = probe
        .bins
        .iter()
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect();
    merge_engine_overrides(&mut transport.engine_paths, &transport.distro);
    transport.shell_path = Some(probe.path.clone());
    transport.codex_home = Some(probe.codex_home.clone()).filter(|c| !c.is_empty());
    transport.claude_home = Some(probe.claude_home.clone()).filter(|c| !c.is_empty());
    transport.pi_agent_dir = Some(probe.pi_agent_dir.clone()).filter(|c| !c.is_empty());
}

/// meta.wsl 字段字符白名单 —— 这些值来自插件/IPC 写入的 db 行,之后会拼进
/// 本机 ssh argv 与远端 Windows 命令串,解析入口统一收口,违例整体按 None
/// (本地工作区)处理,fail-closed。

/// ssh 登录名:Linux 用户名字符集,且不得以 `-` 开头 —— 否则 `user@host`
/// 整体会被 ssh 的 getopt 当成选项吞掉(`-oProxyCommand=…` → 本机命令执行)。
fn is_safe_user(user: &str) -> bool {
    !user.is_empty()
        && !user.starts_with('-')
        && user
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
}

/// 主机地址:IP/主机名/IPv6,同样不得以 `-` 开头(getopt 选项注入)。
fn is_safe_host(host: &str) -> bool {
    !host.is_empty()
        && !host.starts_with('-')
        && host
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-' | ':'))
}

/// 发行版内工作区路径白名单(ssh 脚本内不加引号直排 `cd <ws>`:bash 对行首
/// `~` 原生 tilde 展开;空格/`$`/`;` 等一律拒绝)。send 路径的
/// build_script 与 catalog 路径的 models/wsl.rs 共用同一规则。
///
/// 本机后端不走这条规则:它的 cwd 是 `--exec` 的 argv(V1 证明空格/引号/
/// 中文都逐字到达),由启动器 `cd -- "$2"` 接收。
pub(crate) fn is_safe_workspace(ws: &str) -> bool {
    !ws.is_empty()
        && ws
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '/' | '_' | '.' | '-' | '~'))
}

/// 单个 argv 元素的 POSIX 单引号包裹(bash 脚本内)。
pub(crate) fn sh_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', r"'\''"))
}

/// 从 tokio Command 抽取 program + args + 显式 env(构造点都在本 crate 内,
/// get_envs 只含 build_command 显式设置的项,不含继承环境)。env 经脚本头
/// `export` 跨机传递(MAX_THINKING_TOKENS 等;值一律 sh_quote)。
fn program_args_env(command: &Command) -> (String, Vec<String>, Vec<(String, String)>) {
    let std_cmd = command.as_std();
    let program = std_cmd.get_program().to_string_lossy().into_owned();
    let args = std_cmd
        .get_args()
        .map(|a| a.to_string_lossy().into_owned())
        .collect();
    let envs = std_cmd
        .get_envs()
        .filter_map(|(k, v)| {
            let key = k.to_string_lossy().into_owned();
            let value = v?.to_string_lossy().into_owned();
            valid_env_key(&key).then(|| (key, value))
        })
        .collect();
    (program, args, envs)
}

/// env 键必须是合法 shell 标识符,否则宁可丢掉也不进脚本 / WSLENV。
fn valid_env_key(key: &str) -> bool {
    key.starts_with(|c: char| c.is_ascii_alphabetic() || c == '_')
        && key.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// ssh 公共选项(key 认证 BatchMode;ControlMaster 存在则复用免密)。
fn ssh_options(transport: &WslTransport) -> Vec<String> {
    let (_, port, _, control_path) = transport.ssh().expect("ssh backend");
    let mut opts = vec![
        "-o".to_string(),
        // 首连信任(TOFU):已知主机之后的改动仍会拦,但首次连接不验指纹 ——
        // LAN 上首连可被 MITM 而无感知。可用性权衡:首次接入提示交给插件
        // 连接流程;若后续要硬约束,可让 meta 携带已知主机指纹。
        "StrictHostKeyChecking=accept-new".to_string(),
        "-o".to_string(),
        "ConnectTimeout=10".to_string(),
        "-p".to_string(),
        port.to_string(),
    ];
    match control_path {
        // Master connection exists → no password prompt will occur; BatchMode
        // keeps a dead master from hanging the spawn waiting on input.
        Some(cp) => {
            opts.push("-o".to_string());
            opts.push(format!("ControlPath={cp}"));
            opts.push("-o".to_string());
            opts.push("BatchMode=yes".to_string());
        }
        None => {
            opts.push("-o".to_string());
            opts.push("BatchMode=yes".to_string());
        }
    }
    opts
}

fn ssh_target(transport: &WslTransport) -> String {
    let (host, _, user, _) = transport.ssh().expect("ssh backend");
    format!("{user}@{host}")
}

/// 公共 ssh 命令骨架:选项 + `--` + destination。`--` 终结 getopt 解析,
/// destination 永远不被当成选项(user/host 另有白名单,这里是纵深防御)。
fn base_ssh_command(transport: &WslTransport) -> Command {
    let mut command = Command::new("ssh");
    for opt in ssh_options(transport) {
        command.arg(opt);
    }
    command.arg("--");
    command.arg(ssh_target(transport));
    command
}

fn wsl_command_string(transport: &WslTransport, remote_argv: &[&str]) -> String {
    let distro = transport.distro.replace('"', "");
    let joined = remote_argv
        .iter()
        .map(|a| {
            // Windows-side quoting for the string the remote DefaultShell will
            // hand to wsl.exe: double quotes, no $ / backtick / | inside (the
            // caller guarantees the safe charset: tee/bash 与 UUID 路径是固定词,
            // distro 在 from_workspace_meta 已过白名单,replace 只是纵深防御).
            format!("\"{a}\"")
        })
        .collect::<Vec<_>>()
        .join(" ");
    format!("wsl.exe -d \"{distro}\" -- {joined}")
}

/// 本机 `wsl.exe` 的绝对路径(`%SystemRoot%\System32\wsl.exe`)。不从 PATH
/// 解析,避免同名程序劫持。
fn local_wsl_exe() -> Result<PathBuf, String> {
    super::wsl_probe::wsl_exe().map_err(|e| e.code())
}

/// 本机后端短调用骨架:`wsl.exe -d <distro> --exec /bin/bash -s`,脚本经
/// stdin 送入(V25,单次约 0.6–0.9s)。
fn local_short_call(distro: &str) -> Result<Command, String> {
    let mut command = Command::new(local_wsl_exe()?);
    command
        .arg("-d")
        .arg(distro)
        .arg("--exec")
        .arg("/bin/bash")
        .arg("-s");
    super::wsl_probe::apply_wsl_env(&mut command);
    Ok(command)
}

/// 本机 Windows 侧的 CLI 往往是 npm 的 `.cmd` / `.ps1` 包装:
/// [`crate::engine::resolve::command_for_binary`] 会把它们变成 `cmd /c <path>`
/// 或 `powershell … -File <path>`。发行版里没有 `cmd`,要的是 CLI 自己的
/// 名字,所以先把包装拆开、再去掉 Windows 可执行扩展名。
///
/// 两种后端共用:ssh 后端同样只在发行版内按命令名解析(V4),Windows 路径
/// 对它也没有意义。返回逻辑 CLI 名与需要从 argv 里丢掉的包装参数个数。
pub(crate) fn logical_cli(program: &str, args: &[String]) -> (String, usize) {
    let lower = program.to_ascii_lowercase();
    let (real, skip) = if matches!(lower.as_str(), "cmd" | "cmd.exe") {
        match args {
            [flag, path, ..] if flag.eq_ignore_ascii_case("/c") => (path.clone(), 2),
            _ => (program.to_string(), 0),
        }
    } else if matches!(
        lower.as_str(),
        "powershell" | "powershell.exe" | "pwsh" | "pwsh.exe"
    ) {
        match args
            .iter()
            .position(|a| a.eq_ignore_ascii_case("-file"))
            .and_then(|pos| args.get(pos + 1).map(|path| (path.clone(), pos + 2)))
        {
            Some(unwrapped) => unwrapped,
            None => (program.to_string(), 0),
        }
    } else {
        (program.to_string(), 0)
    };
    (strip_windows_exe_ext(&real), skip)
}

/// 去掉 Windows 可执行扩展名(`claude.cmd` → `claude`):发行版内的 CLI 没有
/// 这些后缀,探测表也按命令名建键。
fn strip_windows_exe_ext(path: &str) -> String {
    let trimmed = path.trim();
    let lower = trimmed.to_ascii_lowercase();
    for ext in [".cmd", ".exe", ".bat", ".com", ".ps1"] {
        if lower.ends_with(ext) && trimmed.len() > ext.len() {
            return trimmed[..trimmed.len() - ext.len()].to_string();
        }
    }
    trimmed.to_string()
}

/// 在 `engine_paths` 里按命令名查表:先按传入的 program 全等,再按 basename,
/// 最后做一次大小写不敏感匹配(Windows 上的 `Claude.CMD` 与探测到的
/// `claude` 是同一个命令)。
/// 命令名(basename,去掉 Windows 可执行扩展名)。查探测表与报错文案都用它:
/// 用户认的是 `claude`,不是 `C:\…\claude.cmd`。
fn logical_base(program: &str) -> String {
    strip_windows_exe_ext(
        &PathBuf::from(program)
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| program.to_string()),
    )
}

/// 在 `engine_paths` 里按命令名查表:先按传入的 program 全等,再按 basename,
/// 最后做一次大小写不敏感匹配(Windows 上的 `Claude.CMD` 与探测到的
/// `claude` 是同一个命令)。
fn lookup_engine_path(transport: &WslTransport, program: &str) -> Option<String> {
    let base = logical_base(program);
    transport
        .engine_paths
        .get(program)
        .or_else(|| transport.engine_paths.get(&base))
        .or_else(|| {
            transport
                .engine_paths
                .iter()
                .find(|(key, _)| key.eq_ignore_ascii_case(&base))
                .map(|(_, value)| value)
        })
        .cloned()
}

/// 把本机 argv[0] 解析成发行版内的可执行路径:
/// 1. `enginePaths` 表命中(program 的 basename 或全等 program);
/// 2. 否则交给脚本内 `command -v` 兜底解析(远端 PATH 语义)。
fn resolve_remote_program(program: &str, transport: &WslTransport) -> String {
    if let Some(path) = lookup_engine_path(transport, program) {
        return path;
    }
    let base = logical_base(program);
    format!("__RESOLVE__{base}")
}

/// 发行版内解析 CLI 绝对路径的脚本片段(SSH 后端兜底)。
///
/// 实机 V4:`bash -lc 'command -v claude'` 在 nvm 环境里找不到 —— nvm 的
/// PATH 注入写在 `.bashrc` 的"非交互直接返回"判断之后,而登录 shell 不读
/// `.bashrc` 的交互分支。改走 `bash -ic`(V5),并过滤 `/mnt/` 下的 Windows
/// 同名程序(V4:Windows 侧装过 codex 时会解析到 `/mnt/c/...`)。
///
/// 交互 shell 会把 profile 的 echo/motd 混进 stdout,所以用哨兵行标注答案,
/// 再按行剥出;`type -ap` 逐个列出候选,第一个可用项胜出。
fn resolve_bin_script(base: &str) -> String {
    // base 来自本机 argv[0] 的文件名,不保证字符集:不合规直接让调用方按
    // "找不到"处理,绝不拼进 shell 代码。
    let safe = !base.is_empty()
        && base
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-' | '~'));
    if !safe {
        return "echo 'engine 命令名不受支持' >&2; exit 62\n".to_string();
    }
    let probe = format!(
        "printf \"\\n__CCGUI__BIN %s\\n\" \"$(for p in $(type -ap {base} 2>/dev/null); do case \"$p\" in /mnt/*) continue ;; esac; printf '%s' \"$p\"; break; done)\""
    );
    format!(
        "raw=$(timeout 30 bash -ic {} 2>/dev/null) || exit 62\n\
         bin=$(printf '%s\\n' \"$raw\" | sed -n 's/^__CCGUI__BIN //p' | head -n1)\n\
         [ -n \"$bin\" ] || exit 62\n",
        sh_quote(&probe)
    )
}

/// 生成 ssh 后端发行版内执行的脚本文本。workspace 路径来自插件登记
/// (白名单见 is_safe_workspace),**不加引号**直排 —— bash 对行首 `~` 原生
/// tilde 展开(tmd 2026-09-13 真机验证形态;引号内 `~` 不展开,手动 `$HOME`
/// 拼接是 Fragile 的)。
fn build_script(
    program: &str,
    args: &[String],
    envs: &[(String, String)],
    transport: &WslTransport,
) -> String {
    let mut script = String::new();
    script.push_str("set -e\n");
    // 脚本落盘即删:bash 对已打开的 fd 继续读取不受 unlink 影响(exec 替换
    // 进程镜像也能删,EXIT trap 在 exec 下不会触发,故不用 trap)。
    script.push_str("rm -f \"$0\"\n");
    // build_command 显式设置的 env 跨机传递(键已限 shell 标识符,值一律
    // 单引号包裹):MAX_THINKING_TOKENS / GROK_DISABLE_AUTOUPDATER 等。
    for (key, value) in envs {
        script.push_str(&format!("export {key}={}\n", sh_quote(value)));
    }
    if let Some(ws) = &transport.workspace {
        if !is_safe_workspace(ws) {
            return format!("echo 'workspace 路径含不支持的字符' >&2; exit 60\n");
        }
        script.push_str(&format!("cd {ws} || exit 61\n"));
    }
    let resolved = resolve_remote_program(program, transport);
    if let Some(base) = resolved.strip_prefix("__RESOLVE__") {
        script.push_str(&resolve_bin_script(base));
        script.push_str("exec \"$bin\"");
    } else {
        script.push_str("exec ");
        script.push_str(&sh_quote(&resolved));
    }
    for a in args {
        script.push(' ');
        script.push_str(&sh_quote(a));
    }
    script.push('\n');
    script
}

/// 把脚本经 ssh stdin 直写发行版 `tee`(脚本内容全程不进命令串,零转义
/// 需求;命令串只有固定词)。任何失败返回 Err(spawn 前失败,turn 直接报错)。
async fn upload_script(
    transport: &WslTransport,
    script_body: &str,
    remote_path: &str,
) -> Result<(), String> {
    let mut command = base_ssh_command(transport);
    command.arg(wsl_command_string(transport, &["tee", remote_path]));
    // stderr 直接丢弃:从不读取却 piped 会在远端写满管缓冲时与 wait 互等
    // 死锁;错误细节本就不进报错文案(下面是固定提示)。
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    let mut child = command
        .spawn()
        .map_err(|e| format!("ssh 脚本上传失败: {e}"))?;
    let wrote = if let Some(mut stdin) = child.stdin.take() {
        use tokio::io::AsyncWriteExt;
        let result = stdin.write_all(script_body.as_bytes()).await;
        stdin.shutdown().await.ok();
        drop(stdin);
        result
    } else {
        Ok(())
    };
    wrote.map_err(|e| format!("ssh 脚本写入失败: {e}"))?;
    // 全局 deadline:远端挂起时管道写满会让 wait 与 write 互等,没有超时
    // 这个 future 永不 resolve(调用链上UI 无取消路径)。超时即 kill,
    // 不留半写的远端脚本与孤儿 ssh。
    let status = match tokio::time::timeout(REMOTE_CALL_TIMEOUT, child.wait()).await {
        Ok(result) => result.map_err(|e| format!("ssh 脚本上传等待失败: {e}"))?,
        Err(_) => {
            let _ = child.start_kill();
            return Err(format!(
                "wsl 脚本上传超时({}s,检查远程主机 wsl.exe 是否无响应)",
                REMOTE_CALL_TIMEOUT.as_secs()
            ));
        }
    };
    if !status.success() {
        return Err("wsl 脚本上传失败(检查远程主机连接/认证;ControlMaster 可能已过期,请在 WSL 主机设置重新连接)".to_string());
    }
    Ok(())
}

/// 本机 WSL 运行的身份:回收 Linux 会话时同时需要发行版与 run id。
/// 用具名字段而不是元组:两者的顺序一旦在生产者/消费者之间写反,
/// 停止按钮会去 `wsl.exe -d <run_id>` 里找一个不存在的发行版(见 §10 P0-1)。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WslRun {
    pub distro: String,
    pub run_id: String,
}

/// 包装结果:重造后的命令 + 本地临时标记文件(run 结束清理)。
pub struct Wrapped {
    pub command: Command,
    pub cleanup_files: Vec<PathBuf>,
    /// 标记本次 spawn 不应设置本地 current_dir(远程路径在本机不存在)。
    pub skip_local_cwd: bool,
    /// 本机后端:发行版与 run id(中断时按它们回收 Linux 会话)。
    /// 启动器路径由 run id 推导([`unix_launcher_path`]),不必重复透传。
    pub local_run: Option<WslRun>,
    /// 本机后端:启动器失败时要用的上下文(发行版、CLI 路径、工作区)。
    /// 退出码只在读取任务结束时才拿到,那时 `WslTransport` 已不在作用域,
    /// 所以随 spawn 一起带走。ssh 后端为 `None`(失败由 ssh 自己的报错解释)。
    pub local_launch: Option<WslLaunchFailure>,
}

/// 本机启动器失败翻译所需的上下文。退出码 61/126/127 的语义由启动器
/// ([`LOCAL_LAUNCHER`])约定,与 `wsl.exe` 自己的失败严格分开(V14)。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WslLaunchFailure {
    /// 发行版名:CLI 失效(127/126)时清探测缓存用。
    pub distro: String,
    /// 传给启动器的 CLI 绝对路径(报错只取 basename)。
    pub program: String,
    /// 发行版内工作区(cwd 缺失时提示里要给出真实路径,不是 `~`)。
    pub workspace: Option<String>,
}

/// 把 build_command 产出的引擎命令包装成 WSL 执行。失败返回 Err。
///
/// `run_id` 用于本机后端的 pidfile 与中断回收;ssh 后端忽略它。
pub async fn wrap(
    command: Command,
    transport: &WslTransport,
    run_id: &str,
) -> Result<Wrapped, String> {
    let (program, args, envs) = program_args_env(&command);
    // Windows 侧的 `.cmd`/`.ps1` 包装在发行版里不存在:还原成逻辑 CLI 名,
    // 并把包装参数(`/c <path>` 等)从 argv 里去掉(见 [`logical_cli`])。
    let (program, skip) = logical_cli(&program, &args);
    let args = &args[skip..];
    match &transport.backend {
        WslBackend::Ssh { .. } => {
            let script = build_script(&program, args, &envs, transport);
            let script_id = uuid::Uuid::new_v4().simple().to_string();
            let remote_path = format!("/tmp/ccgui-wsl-{script_id}.sh");
            upload_script(transport, &script, &remote_path).await?;

            let local_tmp =
                std::env::temp_dir().join(format!("ccgui-wsl-{script_id}.marker"));
            std::fs::write(&local_tmp, b"").map_err(|e| format!("临时文件写入失败: {e}"))?;

            let mut wrapped = base_ssh_command(transport);
            // 脚本已明文落盘,run 串只含固定词。
            wrapped.arg(wsl_command_string(transport, &["bash", &remote_path]));
            Ok(Wrapped {
                command: wrapped,
                cleanup_files: vec![local_tmp],
                skip_local_cwd: true,
                local_run: None,
                local_launch: None,
            })
        }
        WslBackend::Local => {
            let cli = resolve_local_program(&program, transport)?;
            let cwd = transport
                .workspace
                .clone()
                .filter(|w| !w.trim().is_empty())
                .unwrap_or_else(|| "~".to_string());
            // 启动器先写到发行版内的 `/tmp` 再 `--exec /bin/sh <path>`:
            // pidfile 要落在 `$0` 的 dirname 下(见 [`LOCAL_LAUNCHER`]),而
            // `sh -c` 的 `$0` 是人工传入的字符串,不能当路径用。
            let launcher = unix_launcher_path(run_id);
            ensure_local_launcher(transport, &launcher).await?;
            let mut wrapped = Command::new(local_wsl_exe()?);
            wrapped.arg("-d").arg(&transport.distro);
            wrapped
                .arg("--exec")
                .arg("/bin/sh")
                .arg(&launcher)
                .arg(run_id)
                .arg(&cwd)
                .arg(&cli);
            for arg in stage_local_args(transport, args).await? {
                wrapped.arg(arg);
            }
            // 显式 env(含 provider 密钥)与探测到的 PATH 全部经 WSLENV 传递:
            // 只在进程环境里,不落盘、不进 argv(V9)。`PATH` 本身不能直传
            // (WSL 会特殊翻译),用 `CCGUI_WSL_PATH` 中转。
            let wsl_keys = apply_local_env(&mut wrapped, &envs, transport);
            prepend_wslenv(&mut wrapped, &wsl_keys);
            super::wsl_probe::apply_wsl_env(&mut wrapped);
            Ok(Wrapped {
                command: wrapped,
                cleanup_files: Vec::new(),
                skip_local_cwd: true,
                local_run: Some(WslRun {
                    distro: transport.distro.clone(),
                    run_id: run_id.to_string(),
                }),
                local_launch: Some(WslLaunchFailure {
                    distro: transport.distro.clone(),
                    program: cli,
                    // cwd 缺失时提示要给出用户认得的路径,而不是启动器的 `~`。
                    workspace: transport.workspace.clone(),
                }),
            })
        }
    }
}

/// 把 argv 里的 Windows 扩展文件路径换成发行版内副本。
///
/// pi 的 ask bridge(`--extension <app_home>/pi-extensions/…ts`)是宿主写出的
/// Windows 文件;发行版里的 CLI 读不到 `C:\…`。这里只处理显式
/// `--extension` / `-e` 后面的绝对 Windows 路径,其余参数原样保留。
async fn stage_local_args(
    transport: &WslTransport,
    args: &[String],
) -> Result<Vec<String>, String> {
    let mut out = Vec::with_capacity(args.len());
    let mut iter = args.iter().cloned();
    while let Some(arg) = iter.next() {
        if arg == "--extension" || arg == "-e" {
            out.push(arg);
            if let Some(path) = iter.next() {
                out.push(stage_local_extension(transport, &path).await?);
            }
            continue;
        }
        if let Some(path) = arg
            .strip_prefix("--extension=")
            .or_else(|| arg.strip_prefix("-e="))
        {
            let staged = stage_local_extension(transport, path).await?;
            out.push(format!("--extension={staged}"));
            continue;
        }
        out.push(arg);
    }
    Ok(out)
}

async fn stage_local_extension(transport: &WslTransport, path: &str) -> Result<String, String> {
    // 只处理绝对 Windows 路径(盘符或 UNC);Linux/相对路径原样交给 CLI。
    let bytes = path.as_bytes();
    let windows_path = path.starts_with("\\\\") || (bytes.len() > 1 && bytes[1] == b':');
    if !windows_path {
        return Ok(path.to_string());
    }
    let source = std::path::Path::new(path);
    let data = tokio::fs::read(source)
        .await
        .map_err(|e| format!("读取扩展文件失败({path}): {e}"))?;
    let name = source
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("extension.ts")
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_') {
                c
            } else {
                '_'
            }
        })
        .collect::<String>();
    let dir = format!("/tmp/ccgui-pi-{}", instance_token());
    let linux_path = format!("{dir}/{name}");
    let unc_dir = wsl_path::to_wsl_unc(&transport.distro, &dir);
    tokio::fs::create_dir_all(&unc_dir)
        .await
        .map_err(|e| format!("创建发行版扩展目录失败: {e}"))?;
    tokio::fs::write(wsl_path::to_wsl_unc(&transport.distro, &linux_path), data)
        .await
        .map_err(|e| format!("写入发行版扩展文件失败({linux_path}): {e}"))?;
    Ok(linux_path)
}

/// 启动器脚本在发行版内的路径。`run_id` 已由调用方校验
/// (`[A-Za-z0-9_-]`,≤128 字节),可直接进文件名。
/// 本应用数据目录的稳定短标识:同一 profile 的多次启动相同,不同 profile
/// 不同。pidfile / 启动器用它做命名空间,启动清扫只处理自己的文件
/// (§10 P1-18)。
pub fn instance_token() -> &'static str {
    static TOKEN: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    TOKEN.get_or_init(|| {
        use std::hash::{Hash, Hasher};
        let mut hasher = std::collections::hash_map::DefaultHasher::new();
        crate::paths::app_home().hash(&mut hasher);
        format!("{:08x}", hasher.finish() as u32)
    })
}

pub(crate) fn unix_launcher_path(run_id: &str) -> String {
    format!("/tmp/ccgui-launch-{}-{run_id}.sh", instance_token())
}

/// 把 [`LOCAL_LAUNCHER`] 写到发行版内(`/tmp`),供 `--exec /bin/sh <path>`
/// 执行。写 UNC 而不是走发行版命令:一次文件写比重开 `wsl.exe` 便宜(单次
/// `wsl.exe` 约 0.7s,V17),脚本内容也不经任何 shell 转义。
async fn ensure_local_launcher(transport: &WslTransport, launcher: &str) -> Result<(), String> {
    // `/tmp/ccgui-launch-<run>.sh` → `\\wsl.localhost\<distro>\tmp\…`。
    // 用 wsl_path 的拼写而不是自己写 UNC 字面量(边界守卫:UNC 字面量只允许
    // 出现在适配层,且这里必须和别处的路径口径一致)。
    let unc = wsl_path::to_wsl_unc(&transport.distro, launcher);
    tokio::fs::write(&unc, LOCAL_LAUNCHER.as_bytes())
        .await
        .map_err(|e| format!("WSL_PROBE_FAILED:启动器写入失败({launcher}): {e}"))
}

/// 本机后端的 CLI 解析:必须是发行版内绝对路径(裸命令名会 `execvpe
/// failed`,V2)。未探测到 → 明确的 `cliNotFound` 错误,而不是让它以
/// "exit code: 1" 失败。
///
/// `program` 是逻辑 CLI 名([`logical_cli`] 的产物,如 `claude`),不是
/// Windows 侧的 `.cmd` 路径。
fn resolve_local_program(program: &str, transport: &WslTransport) -> Result<String, String> {
    let base = logical_base(program);
    match lookup_engine_path(transport, program) {
        Some(path) if path.starts_with('/') && !path.starts_with("/mnt/") => Ok(path),
        _ => Err(format!("{CLI_NOT_FOUND_PREFIX}{base}")),
    }
}

/// 把显式 env 设到 `wsl.exe` 进程上,返回需要列入 `WSLENV` 的键。
fn apply_local_env(
    command: &mut Command,
    envs: &[(String, String)],
    transport: &WslTransport,
) -> Vec<String> {
    let mut keys = Vec::new();
    for (key, value) in envs {
        // Windows 专有路径/传输变量不得过界:它们要么由下面的探测值覆盖,
        // 要么由 wsl.exe 自己设置。透传 CODEX_HOME 会让发行版里的 codex
        // 拿到 `C:\…`(§10 P1-14)。
        if is_windows_only_env(key) {
            continue;
        }
        command.env(key, value);
        keys.push(key.clone());
    }
    apply_local_script_env(command, transport, &mut keys);
    keys
}

fn is_windows_only_env(key: &str) -> bool {
    [
        "PATH",
        "CODEX_HOME",
        "CLAUDE_CONFIG_DIR",
        "PI_CODING_AGENT_DIR",
        "WSLENV",
        "WSL_UTF8",
    ]
        .iter()
        .any(|blocked| blocked.eq_ignore_ascii_case(key))
}

/// 本机后端脚本/启动器共用的环境变量:探测到的 PATH 与两个 CLI home。
/// 只传发行版内的值,绝不透传 Windows 侧同名变量。
fn apply_local_script_env(
    command: &mut Command,
    transport: &WslTransport,
    keys: &mut Vec<String>,
) {
    if let Some(path) = transport.shell_path.as_deref().filter(|p| !p.is_empty()) {
        command.env("CCGUI_WSL_PATH", path);
        keys.push("CCGUI_WSL_PATH".to_string());
    }
    if let Some(codex_home) = transport.codex_home.as_deref().filter(|c| !c.is_empty()) {
        command.env("CODEX_HOME", codex_home);
        keys.push("CODEX_HOME".to_string());
    }
    if let Some(claude_home) = transport.claude_home.as_deref().filter(|c| !c.is_empty()) {
        command.env("CLAUDE_CONFIG_DIR", claude_home);
        keys.push("CLAUDE_CONFIG_DIR".to_string());
    }
    if let Some(pi_agent_dir) = transport.pi_agent_dir.as_deref().filter(|c| !c.is_empty()) {
        command.env("PI_CODING_AGENT_DIR", pi_agent_dir);
        keys.push("PI_CODING_AGENT_DIR".to_string());
    }
    // 启动器与回收脚本用同一命名空间;不传就无法找到自己的 pidfile。
    command.env("CCGUI_WSL_INSTANCE", instance_token());
    keys.push("CCGUI_WSL_INSTANCE".to_string());
}

/// `wsl.exe` 自己能在启动器跑到之前就失败(发行版没起来、`--exec` 目标
/// 不存在)。这类失败的退出码不是启动器约定(61/126/127),不能按约定解释:
///
/// - 输出里带 `WSL_E_DISTRO_NOT_FOUND` → 发行版不存在(V15,错误码在
///   stdout,本地化文案不参与判定);
/// - `wsl.exe` 的失败退出码是 1 且原因在 stderr(V2/V6),归到
///   `WSL_PROBE_FAILED:`(前端翻译成「发行版探测失败」并带上原文);
/// - 61/126/127 留给调用方按启动器约定处理(返回 `None`)。
pub fn classify_launch_failure(code: Option<i32>, stdout: &str, stderr: &str) -> Option<String> {
    if let Some(error) = super::wsl_probe::classify_wsl_error(stdout)
        .or_else(|| super::wsl_probe::classify_wsl_error(stderr))
    {
        return Some(error.code());
    }
    match code {
        Some(LAUNCH_CWD_MISSING) | Some(LAUNCH_CLI_MISSING) | Some(LAUNCH_CLI_NOT_EXECUTABLE) => {
            None
        }
        None => Some(format!(
            "WSL_PROBE_FAILED:发行版内进程异常终止(无退出码); {}",
            stderr.trim()
        )),
        Some(_) => {
            // 其余退出码默认是 CLI 自己的失败(认证、限流、参数错误):
            // 保留引擎原始错误,不能改写成「发行版探测失败」。只有输出里
            // 出现 wsl.exe 自己的稳定标记时,才归到探测失败(§10 P1-5)。
            if !looks_like_wsl_failure(stdout) && !looks_like_wsl_failure(stderr) {
                return None;
            }
            let detail = [stderr.trim(), stdout.trim()]
                .into_iter()
                .find(|s| !s.is_empty())
                .unwrap_or("wsl.exe 未给出原因");
            Some(format!("WSL_PROBE_FAILED:{detail}"))
        }
    }
}

/// `wsl.exe` / Relay 自己的失败标记(与 CLI 的普通非零退出区分)。
fn looks_like_wsl_failure(text: &str) -> bool {
    [
        "Wsl/Service",
        "WslRegisterDistribution",
        "WSL_E_",
        "execvpe(",
        "chdir(",
        "<3>WSL",
    ]
    .iter()
    .any(|marker| text.contains(marker))
}

/// 短调用脚本自己写出的稳定标记 → 前端错误码。脚本比宿主更早知道「文件
/// 不可读」这类事实,但它只能 `echo` 一个词;这里把它翻成与其它 WSL 错误
/// 同形的 `WSL_*` 码,前端统一走 i18n,不暴露脚本内部的词。
fn classify_script_marker(stderr: &str) -> Option<String> {
    if stderr.contains("WSL_SESSION_UNREADABLE") {
        return Some("WSL_SESSION_UNREADABLE".to_string());
    }
    None
}

/// 本机启动器失败(退出码 61/126/127)的稳定错误码。`distro` 只用在 CLI
/// 缺失时清探测缓存(§5.4:127/126 视为探测结果失效,下次发送重新探测)。
///
/// - 61 → `WSL_CWD_NOT_FOUND:<发行版内路径>`:工作区目录不存在,CLI 没有
///   在 `/` 下跑(V6);
/// - 127/126 → `WSL_CLI_NOT_FOUND:<cli>` / `WSL_CLI_NOT_EXECUTABLE:<cli>`,
///   并丢弃该发行版的探测缓存,下一轮发送会重新探测(装好/改回 CLI 后
///   不必手动点「重新检测」)。
pub fn launch_failure_code(code: i32, launch: &WslLaunchFailure) -> Option<String> {
    let base = std::path::Path::new(&launch.program)
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| launch.program.clone());
    match code {
        LAUNCH_CWD_MISSING => Some(format!(
            "{CWD_NOT_FOUND_PREFIX}{}",
            launch.workspace.as_deref().unwrap_or("~")
        )),
        LAUNCH_CLI_MISSING | LAUNCH_CLI_NOT_EXECUTABLE => {
            // 127/126 = 探测缓存里的路径已失效(CLI 被卸载/改名/去掉执行位):
            // 清缓存,下一次发送重新探测。用户手工覆盖的路径仍留在设置里。
            super::wsl_probe::invalidate(&launch.distro);
            Some(if code == LAUNCH_CLI_MISSING {
                format!("{CLI_NOT_FOUND_PREFIX}{base}")
            } else {
                format!("{CLI_NOT_EXECUTABLE_PREFIX}{base}")
            })
        }
        _ => None,
    }
}

/// 合并已有 `WSLENV`(不覆盖用户值),为每个键加 `/u`(不做路径翻译)。
fn prepend_wslenv(command: &mut Command, keys: &[String]) {
    let mut seen = std::collections::BTreeSet::new();
    let mut entries: Vec<String> = Vec::new();
    // 本应用设置的键优先(`/u`),重复键只保留一次。
    for key in keys {
        if seen.insert(key.clone()) {
            entries.push(format!("{key}/u"));
        }
    }
    // 用户已有的 WSLENV 合并进来;同名键不覆盖本应用的标志。
    if let Some(existing) = std::env::var_os("WSLENV") {
        let existing = existing.to_string_lossy();
        for entry in existing.split(':').filter(|e| !e.trim().is_empty()) {
            let name = entry.split('/').next().unwrap_or("").trim();
            if name.is_empty() || !seen.insert(name.to_string()) {
                continue;
            }
            entries.push(entry.to_string());
        }
    }
    if entries.is_empty() {
        return;
    }
    command.env("WSLENV", entries.join(":"));
}

/// 短调用脚本的公共前缀:注入探测到的 PATH(模型目录/历史脚本里要跑 CLI)。
fn with_local_path(transport: &WslTransport, script_body: &str) -> String {
    match transport.shell_path.as_deref().filter(|p| !p.is_empty()) {
        Some(_) => format!("[ -n \"$CCGUI_WSL_PATH\" ] && export PATH=\"$CCGUI_WSL_PATH\"\n{script_body}"),
        None => script_body.to_string(),
    }
}

/// 供 send_message 判断工作区是否远程(直接读 db 行的 meta JSON)。
pub fn transport_from_meta_json(meta_json: Option<&str>) -> Option<WslTransport> {
    let raw = meta_json?;
    let value: serde_json::Value = serde_json::from_str(raw).ok()?;
    from_workspace_meta(&value)
}

/// 供调用方在 workspace meta 表里查询(路径 → meta 文本)。
pub fn workspace_meta_json(db: &crate::db::Db, workspace_path: &str) -> Option<String> {
    let conn = db.0.lock();
    conn.query_row(
        "SELECT meta FROM workspaces WHERE path = ?1",
        [workspace_path],
        |r| r.get::<_, Option<String>>(0),
    )
    .ok()
    .flatten()
}

/// 供 send_message 把本地 cwd 指到一个必然存在的目录(远程工作区场景)。
pub fn fallback_cwd() -> &'static std::path::Path {
    std::path::Path::new(".")
}

/// 在发行版内跑一段脚本并取 stdout。ssh 后端 = 上传 + 运行两步;本机后端
/// = 一次 `wsl.exe --exec /bin/bash -s`,脚本经 stdin(V25)。
/// 返回值已剥传输层噪声(NUL 残迹与 wsl.exe 诊断行;wsl 通道特有,
/// 载荷本体不受影响),调用方无需重复处理。
pub async fn run_script_output(
    transport: &WslTransport,
    script_body: &str,
) -> Result<String, String> {
    run_script_output_with_timeout(transport, script_body, REMOTE_CALL_TIMEOUT).await
}

/// [`run_script_output`] 的可调预算版本：网络类操作（git push/pull）远超
/// 短调用的 30s 预算，不能套同一个 deadline。
pub async fn run_script_output_with_timeout(
    transport: &WslTransport,
    script_body: &str,
    timeout: std::time::Duration,
) -> Result<String, String> {
    match &transport.backend {
        WslBackend::Ssh { .. } => run_script_output_ssh(transport, script_body, timeout).await,
        WslBackend::Local => run_script_output_local(transport, script_body, timeout).await,
    }
}

async fn run_script_output_ssh(
    transport: &WslTransport,
    script_body: &str,
    timeout: std::time::Duration,
) -> Result<String, String> {
    let script_id = uuid::Uuid::new_v4().simple().to_string();
    let remote_path = format!("/tmp/ccgui-wsl-{script_id}.sh");
    // 调用方脚本同样落盘即删(bash 从已打开 fd 继续读,unlink 不影响执行)。
    let body = format!("rm -f \"$0\"\n{script_body}");
    upload_script(transport, &body, &remote_path).await?;
    let mut command = base_ssh_command(transport);
    command.arg(wsl_command_string(transport, &["bash", &remote_path]));
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    // 全局 deadline(理由见 REMOTE_CALL_TIMEOUT):模型目录/历史回放都走
    // 这里,远端挂起不得拖死前端。kill_on_drop:超时后 output future 被
    // 丢弃即 SIGKILL 本地 ssh(远端脚本落盘即删,无残留面)。
    command.kill_on_drop(true);
    let output = match tokio::time::timeout(timeout, command.output()).await {
        Ok(result) => result.map_err(|e| format!("远程命令执行失败: {e}"))?,
        Err(_) => {
            return Err(format!(
                "远程命令超时({}s,检查远程主机 wsl.exe 是否无响应)",
                timeout.as_secs()
            ));
        }
    };
    if !output.status.success() {
        return Err(format!(
            "远程命令退出码 {:?}: {}",
            output.status.code(),
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    Ok(String::from_utf8_lossy(&strip_transport_noise(output.stdout.as_slice())).to_string())
}

async fn run_script_output_local(
    transport: &WslTransport,
    script_body: &str,
    timeout: std::time::Duration,
) -> Result<String, String> {
    let bytes = exec_local(transport, script_body, timeout).await?;
    // 先解码再剥噪声:旧版 WSL 的 UTF-16LE 输出靠 NUL 判定,若先剥噪声
    // (内部 lossy + 删 NUL),解码兜底就再也识别不到(§10 P1-6)。
    Ok(strip_transport_noise_text(
        &super::wsl_probe::decode_wsl_output(&bytes),
    ))
}

/// 本机后端"脚本进、原始字节写文件"的短调用:转录本回放专用,stdout 边读
/// 边落盘,不整块进内存。管道逐字节安全(实机 V10:CRLF / NUL 均不变),因此
/// 不经 base64 膨胀 1.33 倍,也不做 UTF-8 lossy 与噪声剥行(那会改写正文)。
/// 返回写入的字节数;调用方在失败时负责把追加写入截回去。
pub async fn run_script_to_file_local(
    transport: &WslTransport,
    script_body: &str,
    dest: &std::path::Path,
    append: bool,
) -> Result<u64, String> {
    use tokio::io::AsyncReadExt as _;

    let body = with_local_path(transport, script_body);
    let mut command = local_short_call(&transport.distro)?;
    let mut keys = Vec::new();
    apply_local_script_env(&mut command, transport, &mut keys);
    prepend_wslenv(&mut command, &keys);
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let mut child = command
        .spawn()
        .map_err(|e| format!("WSL 命令启动失败: {e}"))?;
    if let Some(mut stdin) = child.stdin.take() {
        use tokio::io::AsyncWriteExt;
        // 发行版启动失败时 stdin 可能立刻断开:继续读输出拿错误码。
        let _ = async {
            stdin.write_all(body.as_bytes()).await?;
            stdin.shutdown().await
        }
        .await;
    }
    let mut stdout = child
        .stdout
        .take()
        .ok_or_else(|| "WSL 命令缺少 stdout 管道".to_string())?;
    // stderr 必须并行排空:失败时它可能先写满管道,阻塞子进程退出。
    let mut stderr = child
        .stderr
        .take()
        .ok_or_else(|| "WSL 命令缺少 stderr 管道".to_string())?;
    let stderr_task = tokio::spawn(async move {
        let mut buf = Vec::new();
        let _ = stderr.read_to_end(&mut buf).await;
        buf
    });

    let file = tokio::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .append(append)
        .truncate(!append)
        .open(dest)
        .await
        .map_err(|e| format!("打开转录本缓存失败: {e}"))?;
    let mut file = tokio::io::BufWriter::new(file);
    let result = tokio::time::timeout(LOCAL_TRANSCRIPT_TIMEOUT, async {
        use tokio::io::AsyncWriteExt as _;
        let copied = tokio::io::copy(&mut stdout, &mut file).await?;
        file.flush().await?;
        let status = child.wait().await?;
        Ok::<_, std::io::Error>((copied, status))
    })
    .await;
    let (copied, status) = match result {
        Ok(Ok(value)) => value,
        Ok(Err(e)) => return Err(format!("写入转录本缓存失败: {e}")),
        Err(_) => {
            return Err(format!(
                "WSL_TRANSCRIPT_TIMEOUT:{}",
                LOCAL_TRANSCRIPT_TIMEOUT.as_secs()
            ));
        }
    };
    let stderr = stderr_task.await.unwrap_or_default();
    if !status.success() {
        let mut stderr_text = super::wsl_probe::decode_wsl_output(&stderr);
        // wsl.exe 自己的错误在 stdout(V15);全量拉取时它已经落进目标文件,
        // 读回开头一段再分类,否则只会报一个裸退出码(§10 P1-5)。
        if !append {
            drop(file);
            if let Ok(head) = tokio::fs::read(dest).await {
                let head = &head[..head.len().min(4096)];
                let head_text = super::wsl_probe::decode_wsl_output(head);
                if let Some(error) = super::wsl_probe::classify_wsl_error(&head_text) {
                    return Err(error.code());
                }
                if stderr_text.trim().is_empty() {
                    stderr_text = head_text;
                }
            }
        }
        if let Some(error) = super::wsl_probe::classify_wsl_error(&stderr_text) {
            return Err(error.code());
        }
        // 脚本自己给出的稳定标记(会话文件不可读)优先于通用退出码文案。
        if let Some(code) = classify_script_marker(&stderr_text) {
            return Err(code);
        }
        return Err(format!(
            "WSL_SHORT_CALL_FAILED:退出码 {:?}: {}",
            status.code(),
            stderr_text.trim()
        ));
    }
    Ok(copied)
}

/// 本机后端的公共执行体:脚本经 stdin 送入 `bash -s`。
///
/// 返回 (退出码, stdout 原始字节):退出码是脚本语义的一部分(短调用脚本
/// 用 3/4/5/61/127 报告"不可读 / 过大 / 读失败 / 目录缺失 / 没这个命令"),
/// 只交出错误串会把它丢掉 —— 预检因此无法区分 127 与 126。
async fn exec_local_exit(
    transport: &WslTransport,
    script_body: &str,
    timeout: Duration,
) -> Result<(Option<i32>, Vec<u8>), String> {
    let body = with_local_path(transport, script_body);
    let mut command = local_short_call(&transport.distro)?;
    let mut keys = Vec::new();
    apply_local_script_env(&mut command, transport, &mut keys);
    prepend_wslenv(&mut command, &keys);
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let mut child = command
        .spawn()
        .map_err(|e| format!("WSL 命令启动失败: {e}"))?;
    if let Some(mut stdin) = child.stdin.take() {
        use tokio::io::AsyncWriteExt;
        // 发行版启动失败时 stdin 可能立刻断开:继续读 output 拿错误码,
        // 不要把"写不进去"当成唯一结论。
        let _ = async {
            stdin.write_all(body.as_bytes()).await?;
            stdin.shutdown().await
        }
        .await;
    }
    let output = match tokio::time::timeout(timeout, child.wait_with_output()).await {
        Ok(result) => result.map_err(|e| format!("WSL 命令执行失败: {e}"))?,
        Err(_) => {
            return Err(format!("WSL_SHORT_CALL_TIMEOUT:{}", timeout.as_secs()));
        }
    };
    if !output.status.success() {
        let stderr = super::wsl_probe::decode_wsl_output(&output.stderr);
        let stdout = super::wsl_probe::decode_wsl_output(&output.stdout);
        if let Some(error) = super::wsl_probe::classify_wsl_error(&stdout)
            .or_else(|| super::wsl_probe::classify_wsl_error(&stderr))
        {
            return Err(error.code());
        }
        if let Some(code) = classify_script_marker(&stderr) {
            return Err(code);
        }
        return Err(format!(
            "WSL_SHORT_CALL_FAILED:退出码 {:?}: {}",
            output.status.code(),
            stderr.trim()
        ));
    }
    Ok((output.status.code(), output.stdout))
}

/// [`exec_local_exit`] 的 stdout-only 形态(调用方不关心退出码)。
async fn exec_local(
    transport: &WslTransport,
    script_body: &str,
    timeout: Duration,
) -> Result<Vec<u8>, String> {
    exec_local_exit(transport, script_body, timeout)
        .await
        .map(|(_, bytes)| bytes)
}

/// 中断/结束时的 Linux 会话回收(本机后端):一次短调用执行
/// [`kill_run_script`]。失败不吞:`ExitUnproven` 前缀交给前端提示
/// "WSL 内进程可能仍在运行"。
pub async fn kill_local_run(distro: &str, run_id: &str, hard: bool) -> Result<(), String> {
    let launcher = unix_launcher_path(run_id);
    reclaim_local(distro, run_id, &launcher, hard).await
}

/// 正常结束时的启动器清理(不杀进程,CLI 已自行退出)。走 UNC 直接删:
/// 一次文件删除比再开一个 `wsl.exe` 便宜(V17),也不会因为发行版正忙而
/// 多占一个短调用槽。
pub async fn cleanup_local_launcher(distro: &str, run_id: &str) -> Result<(), String> {
    let launcher = unix_launcher_path(run_id);
    // 只删启动器。pidfile 留到应用退出/下次启动清扫,这样 turn 结束后
    // CLI 用 nohup 拉起的后台进程仍可被回收(§5.7 第 3 条)。
    let _ = tokio::fs::remove_file(wsl_path::to_wsl_unc(distro, &launcher)).await;
    Ok(())
}

async fn reclaim_local(
    distro: &str,
    run_id: &str,
    launcher: &str,
    hard: bool,
) -> Result<(), String> {
    let transport = WslTransport {
        backend: WslBackend::Local,
        distro: distro.to_string(),
        engine_paths: HashMap::new(),
        workspace: None,
        shell_path: None,
        codex_home: None,
        claude_home: None,
        pi_agent_dir: None,
    };
    // `$1` = run id,`$2` = 启动器脚本路径(回收脚本从它的 dirname 找 pidfile,
    // 与 [`LOCAL_LAUNCHER`] 的写入位置一致)。
    run_script_output_with_args(&transport, &kill_run_script(hard), &[run_id, launcher], hard)
        .await
}

/// 带位置参数的短调用(`bash -s` 后紧跟 argv,脚本内用 `$1`)。参数不拼进
/// 脚本文本,天然免疫转义问题。
pub async fn run_script_output_with_args(
    transport: &WslTransport,
    script_body: &str,
    args: &[&str],
    hard: bool,
) -> Result<(), String> {
    if !matches!(transport.backend, WslBackend::Local) {
        return Err("WSL_EXIT_UNPROVEN:仅本机 WSL 后端支持会话回收".to_string());
    }
    let mut command = local_short_call(&transport.distro)?;
    for arg in args {
        command.arg(arg);
    }
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let mut child = command
        .spawn()
        .map_err(|e| format!("WSL_EXIT_UNPROVEN:{e}"))?;
    if let Some(mut stdin) = child.stdin.take() {
        use tokio::io::AsyncWriteExt;
        let _ = stdin.write_all(script_body.as_bytes()).await;
        let _ = stdin.shutdown().await;
    }
    let output = match tokio::time::timeout(kill_timeout(hard), child.wait_with_output()).await {
        Ok(result) => result.map_err(|e| format!("WSL_EXIT_UNPROVEN:{e}"))?,
        Err(_) => return Err("WSL_EXIT_UNPROVEN:回收超时".to_string()),
    };
    if !output.status.success() {
        return Err(format!(
            "WSL_EXIT_UNPROVEN:退出码 {:?}",
            output.status.code()
        ));
    }
    Ok(())
}

/// 启动兜底回收脚本(§5.7 第 4 条)。只 glob 本应用命名的 pidfile
/// (`ccgui-run-<id>.pid`,id 已校验为 `[A-Za-z0-9_-]`);启动器脚本一并删掉,
/// 否则下一轮启动还会看到它们。
pub(crate) const STARTUP_RECLAIM_SCRIPT: &str = r#"shopt -s nullglob
for f in /tmp/ccgui-run-${CCGUI_WSL_INSTANCE}-*.pid; do
  read -r s start < "$f" 2>/dev/null || { rm -f "$f"; continue; }
  case "$s" in ''|*[!0-9]*) rm -f "$f"; continue ;; esac
  now=$(awk '{print $22}' "/proc/$s/stat" 2>/dev/null) || { rm -f "$f"; continue; }
  [ "$now" = "$start" ] || { rm -f "$f"; continue; }
  pkill -TERM -s "$s" 2>/dev/null
  sleep 1
  pkill -KILL -s "$s" 2>/dev/null
  rm -f "$f"
done
rm -f /tmp/ccgui-launch-${CCGUI_WSL_INSTANCE}-*.sh
rm -rf /tmp/ccgui-pi-${CCGUI_WSL_INSTANCE}
exit 0"#;

/// 启动兜底回收(§5.7 第 4 条):应用启动时发行版 `/tmp` 里可能还留着上次
/// 崩溃/强杀留下的启动器与 pidfile,对应的 Linux 会话可能还活着。这里只对
/// **本应用写的** pidfile 发 TERM,不碰用户手动启动的 CLI。
///
/// 实现上不做「列文件 + 逐个回收」两次调用:一次 `bash -s` 在发行版内 glob
/// 出所有 pidfile 并按会话 `pkill -s`,代价与一次短调用相同(约 0.7s,
/// V17)。区分不出「会话已死」的情况也不报错 —— `pkill` 找不到进程返回 1
/// 是正常结果。
pub async fn reclaim_startup_runs(distro: &str) -> Result<(), String> {
    let transport = WslTransport {
        backend: WslBackend::Local,
        distro: distro.to_string(),
        engine_paths: HashMap::new(),
        workspace: None,
        shell_path: None,
        codex_home: None,
        claude_home: None,
        pi_agent_dir: None,
    };
    run_script_output_with_args(&transport, STARTUP_RECLAIM_SCRIPT, &[], false).await
}

/// 中断/退出回收的 deadline。硬回收脚本自带 `sleep 2`(本机实测整次短调用
/// 约 2.1s),按 §5.7 第 6 条收到 3s:关闭 GUI 时每个活动 run 最多占用 3s,
/// 超时不静默 —— 返回 `ExitUnproven`,由 UI 提示"WSL 内进程可能仍在运行"。
/// 正常结束只需删一个文件,留 5s 余量。
fn kill_timeout(hard: bool) -> Duration {
    if hard {
        Duration::from_secs(3)
    } else {
        Duration::from_secs(5)
    }
}

/// wsl.exe 传输层噪声:NUL 残迹(UTF-16LE lossy 后)与 `wsl:`/`wsl.` 开头
/// 的诊断行。行结构保留(多行输出各剥各的),载荷行原样通过。
fn strip_transport_noise(raw: &[u8]) -> Vec<u8> {
    strip_transport_noise_text(&String::from_utf8_lossy(raw)).into_bytes()
}

fn strip_transport_noise_text(text: &str) -> String {
    text.replace('\0', "")
        .lines()
        .filter(|l| {
            let t = l.trim_start();
            !(t.starts_with("wsl:") || t.starts_with("wsl."))
        })
        .map(|l| format!("{l}\n"))
        .collect::<Vec<_>>()
        .join("")
}

/// 工作区路径 → 传输描述一步到位(db 读 + 形状解析都收敛在此,调用方不再
/// 自行组合两步查找)。
///
/// 顺序(设计稿 §5.2,判定顺序本身是契约):
/// 1. 工作区行带 `meta.wsl` → `Ssh`(插件登记的远程工作区,显式意图优先);
/// 2. 否则 `\\wsl.localhost\…` UNC → `Local`(本机 WSL,不需要插件授权);
/// 3. 都不是 → `None`(本机原生)。
///
/// 先读 meta 而不是先认 UNC 的原因:插件将来若登记一个 UNC 形态的路径,
/// "UNC 优先"会把远程工作区静默当成本机后端执行 —— §1.1 第 6 条要防的正
/// 是这类行为漂移。显式登记 > 路径形状推断。
pub fn transport_for_workspace(
    db: &crate::db::Db,
    workspace_path: &str,
) -> Result<Option<WslTransport>, String> {
    let meta = workspace_meta_json(db, workspace_path);
    if let Some(tp) = transport_from_meta_json(meta.as_deref()) {
        return Ok(Some(tp));
    }
    // meta 里写了 `wsl` 却解析不出合法传输(缺 host/user/distro 等):
    // fail-closed,绝不因为配置写错就悄悄回退到本机 WSL(§10 待决 D2)。
    if meta_has_wsl_key(meta.as_deref()) {
        return Err("工作区 meta.wsl 无效:缺少 host / user / distro 或端口不合法".into());
    }
    Ok(wsl_path::parse_wsl_unc(workspace_path).map(|unc| local_transport(&unc)))
}

/// meta JSON 是否声明了 `wsl`(无论字段是否合法)。
fn meta_has_wsl_key(meta_json: Option<&str>) -> bool {
    meta_json
        .and_then(|raw| serde_json::from_str::<serde_json::Value>(raw).ok())
        .is_some_and(|value| value.get("wsl").is_some())
}

/// 该路径是否落在「带 `meta.wsl` 的工作区」内(含子目录)。
///
/// 会话列表、文件索引、引擎可用性等入口没有 `WslTransport` 实例可复用,
/// 但同样必须先尊重显式 meta:插件登记的远程工作区即使路径形似 UNC,
/// 也不能被本机 WSL 后端接管(§10 P1-3)。路径比较按 Windows 语义做
/// 大小写不敏感与分隔符归一。
pub fn path_in_meta_wsl_workspace(db: &crate::db::Db, path: &str) -> bool {
    let conn = db.0.lock();
    let Ok(mut stmt) = conn.prepare("SELECT path, meta FROM workspaces WHERE meta IS NOT NULL")
    else {
        return false;
    };
    let Ok(rows) = stmt.query_map([], |r| {
        Ok((r.get::<_, String>(0)?, r.get::<_, Option<String>>(1)?))
    }) else {
        return false;
    };
    let found = rows.flatten().any(|(workspace, meta)| {
        (transport_from_meta_json(meta.as_deref()).is_some()
            || meta_has_wsl_key(meta.as_deref()))
            && path_is_under(path, &workspace)
    });
    found
}

fn path_is_under(path: &str, root: &str) -> bool {
    fn norm(value: &str) -> String {
        value
            .replace('/', "\\")
            .trim_end_matches('\\')
            .to_lowercase()
    }
    let path = norm(path);
    let root = norm(root);
    !root.is_empty() && (path == root || path.starts_with(&format!("{root}\\")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn tp() -> WslTransport {
        WslTransport {
            backend: WslBackend::Ssh {
                host: "10.0.0.2".into(),
                port: 22,
                user: "dev".into(),
                control_path: None,
            },
            distro: "Ubuntu-22.04".into(),
            engine_paths: HashMap::from([(
                "omp".to_string(),
                "/home/dev/.local/bin/omp".to_string(),
            )]),
            workspace: Some("/home/dev/proj".into()),
            shell_path: None,
            codex_home: None,
            claude_home: None,
            pi_agent_dir: None,
        }
    }

    fn local() -> WslTransport {
        WslTransport {
            backend: WslBackend::Local,
            distro: "Ubuntu-24.04".into(),
            engine_paths: HashMap::from([(
                "claude".to_string(),
                "/home/me/.nvm/versions/node/v24.17.0/bin/claude".to_string(),
            )]),
            workspace: Some("/home/me/repo".into()),
            shell_path: Some("/home/me/.nvm/versions/node/v24.17.0/bin:/usr/bin".into()),
            codex_home: None,
            claude_home: None,
            pi_agent_dir: None,
        }
    }

    #[test]
    fn meta_parses_engine_paths_and_workspace() {
        let meta = json!({"wsl": {
            "host": "10.0.0.2", "port": 2222, "user": "dev", "distro": "Ubuntu",
            "controlPath": "/tmp/m", "workspace": "/home/dev/p",
            "enginePaths": {"omp": "/home/dev/.local/bin/omp"}
        }});
        let t = from_workspace_meta(&meta).unwrap();
        assert!(matches!(t.backend, WslBackend::Ssh { port: 2222, .. }));
        assert_eq!(
            t.engine_paths.get("omp").unwrap(),
            "/home/dev/.local/bin/omp"
        );
        assert_eq!(t.workspace.as_deref(), Some("/home/dev/p"));
    }

    #[test]
    fn script_maps_bin_cd_and_quotes_args() {
        let script = build_script(
            "/Users/x/.local/bin/omp",
            &[
                "-p".into(),
                "hello world".into(),
                "--resume".into(),
                "s-1".into(),
            ],
            &[],
            &tp(),
        );
        assert!(script.starts_with("set -e\n"));
        assert!(script.contains("cd /home/dev/proj || exit 61"));
        // argv[0] basename "omp" 命中 enginePaths → 发行版内路径
        assert!(script.contains("exec '/home/dev/.local/bin/omp'"));
        assert!(script.contains("'hello world'"));
        // 本机 mac 路径绝不残留
        assert!(!script.contains("/Users/"));
    }

    #[test]
    fn script_keeps_tilde_unquoted_for_native_expansion() {
        let mut t = tp();
        t.workspace = Some("~/code/proj".into());
        let script = build_script("omp", &[], &[], &t);
        assert!(script.contains("cd ~/code/proj || exit 61"));
        // 引号包裹会杀死 bash 的 tilde 展开 —— 绝不能出现
        assert!(!script.contains("\"~/"));
    }

    #[test]
    fn script_rejects_space_paths() {
        let mut t = tp();
        t.workspace = Some("/home/dev/my proj".into());
        let script = build_script("omp", &[], &[], &t);
        assert!(script.contains("exit 60"));
    }

    #[test]
    fn script_falls_back_to_command_v() {
        let script = build_script("kimi", &[], &[], &tp());
        // 实机 V4:`bash -lc` 探不到 nvm 装的 CLI,必须用交互 shell。
        assert!(script.contains("bash -ic"));
        assert!(!script.contains("bash -lc"));
        // 答案经哨兵行剥出,profile 噪声不参与解析。
        assert!(script.contains("__CCGUI__BIN "));
        assert!(script.contains("sed -n 's/^__CCGUI__BIN //p'"));
        // Windows 侧同名程序(/mnt/)必须跳过。
        assert!(script.contains("case \"$p\" in /mnt/*) continue ;; esac"));
        assert!(script.contains("exec \"$bin\""));
    }

    #[test]
    fn resolve_script_rejects_unsafe_bin_names() {
        // base 来自本机 argv[0],不合规时只能按"找不到"退出,不能拼进代码。
        let script = resolve_bin_script("a b;rm -rf /");
        assert!(script.contains("exit 62"));
        assert!(!script.contains("rm -rf"));
        assert!(!script.contains("bash -ic"));
    }

    #[test]
    fn remote_command_string_is_shell_inert() {
        let s = wsl_command_string(&tp(), &["bash", "/tmp/x.sh"]);
        assert_eq!(s, "wsl.exe -d \"Ubuntu-22.04\" -- \"bash\" \"/tmp/x.sh\"");
        assert!(!s.contains('$') && !s.contains('|') && !s.contains('`'));
    }

    #[test]
    fn meta_rejects_ssh_option_injection_user() {
        // user 以 `-` 开头:`user@host` 会被 ssh getopt 吞成 -o 选项
        // (ProxyCommand → 本机命令执行),必须整个拒绝。
        let meta = json!({"wsl": {
            "host": "10.0.0.2", "user": "-oProxyCommand=/tmp/evil@x", "distro": "Ubuntu"
        }});
        assert!(from_workspace_meta(&meta).is_none());
    }

    #[test]
    fn meta_rejects_dash_host_and_bad_chars() {
        for host in ["-oProxyCommand=x", "ho st", "ho;st", "ho`id`st"] {
            let meta = json!({"wsl": { "host": host, "user": "dev", "distro": "Ubuntu" }});
            assert!(from_workspace_meta(&meta).is_none(), "host: {host}");
        }
        // IPv6 / 主机名 / 带点用户名为合法形态
        let meta = json!({"wsl": {
            "host": "::1", "user": "dev.ops-1_x", "distro": "Ubuntu"
        }});
        assert!(from_workspace_meta(&meta).is_some());
    }

    #[test]
    fn meta_rejects_distro_shell_chars() {
        // PowerShell 双引号内 $(…)/反引号仍求值,cmd 下 %VAR% 仍展开
        for distro in ["Ubuntu$(id)", "u`id`", "u%PATH%", "u\"&id", "u|id"] {
            let meta = json!({"wsl": { "host": "10.0.0.2", "user": "dev", "distro": distro }});
            assert!(from_workspace_meta(&meta).is_none(), "distro: {distro}");
        }
        let meta = json!({"wsl": {
            "host": "10.0.0.2", "user": "dev", "distro": "Ubuntu-22.04 LTS"
        }});
        assert!(from_workspace_meta(&meta).is_some());
    }

    /// §5.2 / §1.1 第 6 条:登记在案的 ssh 远程 WSL 必须压过 UNC 形状推断。
    /// 这条断言是"判定顺序即契约"的可执行形式 —— 顺序一旦被反过来,插件
    /// 登记的远程工作区会被静默当成本机后端跑。
    #[test]
    fn registered_meta_wins_over_unc_shape() {
        let dir = std::env::temp_dir().join(format!(
            "ccgui-wsl-dispatch-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let db = crate::db::Db::open_at(&dir.join("app.db")).unwrap();
        let path = r"\\wsl.localhost\Ubuntu-24.04\home\me\repo";
        {
            let conn = db.0.lock();
            conn.execute(
                "INSERT INTO workspaces(id, path, name) VALUES('w1', ?1, 'repo')",
                rusqlite::params![path],
            )
            .unwrap();
            conn.execute(
                "UPDATE workspaces SET meta=?2 WHERE id='w1'",
                rusqlite::params![
                    path,
                    json!({"wsl": {"host": "10.0.0.2", "user": "dev", "distro": "Ubuntu"}})
                        .to_string()
                ],
            )
            .unwrap();
        }
        let t = transport_for_workspace(&db, path)
            .expect("meta 解析不应失败")
            .expect("UNC + meta 都命中时应有结果");
        assert!(
            matches!(t.backend, WslBackend::Ssh { .. }),
            "显式登记的远程工作区必须走 Ssh,实际 {t:?}"
        );
        assert_eq!(t.distro, "Ubuntu");

        // 反过来:只有 UNC 形状、没有 meta → 本机后端。
        let bare = r"\\wsl.localhost\Ubuntu-24.04\home\me\other";
        let t = transport_for_workspace(&db, bare)
            .expect("meta 解析不应失败")
            .expect("UNC 命中应走本机后端");
        assert!(matches!(t.backend, WslBackend::Local));
        assert_eq!(t.distro, "Ubuntu-24.04");

        // 既不是 UNC 也没有 meta → 本机原生(不是 WSL)。
        assert!(transport_for_workspace(&db, "D:\\code\\repo")
            .expect("无 meta 不应失败")
            .is_none());

        // meta 写了 wsl 但字段不合法:必须报错,不能回退到本机 WSL(D2)。
        let broken = r"\\wsl.localhost\Ubuntu-24.04\home\me\broken";
        {
            let conn = db.0.lock();
            conn.execute(
                "INSERT INTO workspaces(id, path, name) VALUES('w2', ?1, 'broken')",
                rusqlite::params![broken],
            )
            .unwrap();
            conn.execute(
                "UPDATE workspaces SET meta=?2 WHERE id='w2'",
                rusqlite::params![broken, json!({"wsl": {"distro": "Ubuntu"}}).to_string()],
            )
            .unwrap();
        }
        assert!(
            transport_for_workspace(&db, broken).is_err(),
            "非法 meta.wsl 必须 fail-closed"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn workspace_allowlist() {
        assert!(is_safe_workspace("/home/dev/proj"));
        assert!(is_safe_workspace("~/code/proj"));
        assert!(!is_safe_workspace("/home/dev/my proj"));
        assert!(!is_safe_workspace("/a;id"));
        assert!(!is_safe_workspace("/a$(id)"));
        assert!(!is_safe_workspace(""));
    }

    #[test]
    fn script_exports_env_and_self_deletes() {
        let envs = vec![("MAX_THINKING_TOKENS".to_string(), "65536".to_string())];
        let script = build_script("omp", &[], &envs, &tp());
        // 落盘即删(exec 下 trap 不触发,unlink 已打开 fd 的脚本仍然安全)
        assert!(script.contains("rm -f \"$0\""));
        assert!(script.contains("export MAX_THINKING_TOKENS='65536'"));
        // 值含单引号/空白也走 sh_quote,不直接拼接
        let envs = vec![("X_Y".to_string(), "a'b c".to_string())];
        let script = build_script("omp", &[], &envs, &tp());
        assert!(script.contains("export X_Y='a'\\''b c'"));
    }

    #[test]
    fn ssh_command_separates_destination_with_double_dash() {
        let cmd = base_ssh_command(&tp());
        let args: Vec<String> = cmd
            .as_std()
            .get_args()
            .map(|a| a.to_string_lossy().into_owned())
            .collect();
        let dashdash = args.iter().position(|a| a == "--").expect("missing --");
        // `--` 之后紧跟 destination,且 destination 之前没有任何非选项值
        assert_eq!(args[dashdash + 1], "dev@10.0.0.2");
        assert!(args[..dashdash]
            .iter()
            .all(|a| a.starts_with('-') || !a.contains('@')));
    }

    // ==================== Local 后端 ====================

    #[test]
    fn local_launcher_is_a_compile_time_constant() {
        // 启动器不得含任何运行时插值;run id / cwd / argv 都走位置参数。
        assert!(LOCAL_LAUNCHER.contains("exec \"$@\""));
        assert!(LOCAL_LAUNCHER.contains("exit 61"));
        assert!(!LOCAL_LAUNCHER.contains("{}"));
    }

    #[test]
    fn local_launcher_never_uses_dash_cd_or_setsid() {
        // V6:--cd 失败会静默落到 /;V11:--exec 已是会话组长,套 setsid 会改 pid。
        assert!(!LOCAL_LAUNCHER.contains("setsid"));
        assert!(LOCAL_LAUNCHER.contains("cd -- \"$2\""));
    }

    #[test]
    fn kill_script_uses_session_not_name() {
        let hard = kill_run_script(true);
        assert!(hard.contains("pkill -TERM -s \"$s\""));
        assert!(hard.contains("pkill -KILL -s \"$s\""));
        assert!(hard.contains("rm -f \"$f\""));
        // 绝不按进程名杀(pkill sleep / pkill node 会误伤用户进程)
        assert!(!hard.contains("pkill -f") && !hard.contains("pkill sleep"));
        let soft = kill_run_script(false);
        assert!(!soft.contains("pkill"));
        // 正常结束保留 pidfile,只删启动器(§5.7 第 3 条)。
        assert!(soft.contains("rm -f -- \"$2\""));
        assert!(!soft.contains("rm -f \"$f\""));
    }

    /// §5.7 第 4 条:启动兜底只碰本应用写的 pidfile。按名字 glob 而不是
    /// `pkill -f claude` 之类 —— 后者会杀掉用户自己在 WSL 里开的 CLI。
    #[test]
    fn startup_reclaim_only_touches_our_own_pidfiles() {
        let script = STARTUP_RECLAIM_SCRIPT;
        assert!(script.contains("/tmp/ccgui-run-${CCGUI_WSL_INSTANCE}-*.pid"));
        assert!(!script.contains("pkill -f"));
        assert!(!script.contains("pkill claude") && !script.contains("pkill node"));
        // 先 TERM 再 KILL,并用 starttime 防 sid 复用误杀。
        assert!(script.contains("pkill -TERM -s"));
        assert!(script.contains("pkill -KILL -s"));
        assert!(script.contains("awk '{print $22}'"));
        // 启动器脚本一并清掉,否则下一轮启动还会 glob 到它们。
        assert!(script.contains("rm -f /tmp/ccgui-launch-${CCGUI_WSL_INSTANCE}-*.sh"));
        // pid 不是纯数字(文件被写坏)时删掉档案,不拿它去 pkill。
        assert!(script.contains("case \"$s\" in ''|*[!0-9]*)"));
        assert!(script.trim_end().ends_with("exit 0"));
    }

    /// pidfile 与启动器脚本同目录、由 `$0` 定位:实测 `XDG_RUNTIME_DIR`
    /// 经 WSLENV 带进发行版后指向不存在的 `/run/user/<uid>`,往那儿写 pidfile
    /// 会失败,`pkill -s` 读不到就静默不回收(V13 的 nohup 进程会活下来)。
    #[test]
    fn pidfile_lives_next_to_the_launcher() {
        assert!(LOCAL_LAUNCHER
            .contains("\"$(dirname \"$0\")/ccgui-run-${CCGUI_WSL_INSTANCE}-$1.pid\""));
        assert!(!LOCAL_LAUNCHER.contains("XDG_RUNTIME_DIR"));
        // 回收脚本按同一个位置读:`$2` 是启动器路径。
        assert!(kill_run_script(true)
            .contains("\"$(dirname \"$2\")/ccgui-run-${CCGUI_WSL_INSTANCE}-$1.pid\""));
        assert!(!kill_run_script(true).contains("XDG_RUNTIME_DIR"));
    }

    #[test]
    fn launcher_path_is_per_run_and_shell_safe() {
        let path = unix_launcher_path("run_abc-1");
        // 启动器也带实例命名空间,启动清扫不会删别的 profile 的文件。
        assert!(path.starts_with("/tmp/ccgui-launch-"));
        assert!(path.ends_with("-run_abc-1.sh"));
        assert!(path.contains(instance_token()));
    }

    #[test]
    fn local_resolution_requires_absolute_distro_path() {
        let t = local();
        assert_eq!(
            resolve_local_program("claude", &t).unwrap(),
            "/home/me/.nvm/versions/node/v24.17.0/bin/claude"
        );
        // 本机绝对路径按 basename 命中
        assert_eq!(
            resolve_local_program("/usr/local/bin/claude", &t).unwrap(),
            "/home/me/.nvm/versions/node/v24.17.0/bin/claude"
        );
        // 未探测到 → 明确的 cliNotFound 标记,而不是起一个裸命令名(V2)
        let err = resolve_local_program("codex", &t).unwrap_err();
        assert!(err.starts_with("WSL_CLI_NOT_FOUND:"), "{err}");
    }

    /// Windows 侧的 CLI 是 npm 的 `.cmd` 包装:`command_for_binary` 会把它变成
    /// `cmd /c <path>.cmd`。发行版里要的是 CLI 自己的名字 —— 不还原包装,
    /// 每台 Windows 上也装了同名 CLI 的机器都会得到 `WSL_CLI_NOT_FOUND:cmd`
    /// (与 §1.1 第 2 条直接冲突)。
    #[test]
    fn windows_wrapped_cli_is_unwrapped_before_lookup() {
        let t = local();
        // 包装形态(与 resolve::command_for_binary 在 Windows 上的产物一致)
        let command = {
            let mut command = Command::new("cmd");
            command
                .arg("/c")
                .arg(r"C:\Users\me\AppData\Roaming\npm\claude.cmd");
            command
        };
        let (program, args, _) = program_args_env(&command);
        // 上游形态:`.cmd` 被包成 `cmd /c <path>.cmd` —— 直接拿去查发行版
        // 的探测表只会得到 `cmd`,这就是要还原包装的原因。
        assert_eq!(program, "cmd");
        let (cli, skip) = logical_cli(&program, &args);
        assert_eq!(cli, r"C:\Users\me\AppData\Roaming\npm\claude");
        assert_eq!(skip, 2);
        assert_eq!(
            resolve_local_program(&cli, &t).unwrap(),
            "/home/me/.nvm/versions/node/v24.17.0/bin/claude"
        );
        // 直接传 Windows 绝对路径(没有包装)同样按命令名命中
        assert_eq!(
            resolve_local_program(r"C:\Users\me\AppData\Roaming\npm\claude.exe", &t).unwrap(),
            "/home/me/.nvm/versions/node/v24.17.0/bin/claude"
        );
        // 非包装命令原样返回
        assert_eq!(logical_cli("claude", &[]), ("claude".to_string(), 0));
        assert_eq!(
            logical_cli("/usr/bin/claude", &[]),
            ("/usr/bin/claude".to_string(), 0)
        );
    }

    /// `minimax` 的 CLI 叫 `mcode`(engine id ≠ 命令名):探测表按命令名建键,
    /// 发送与预检必须按同一个键查,否则发行版里装着的 mcode 永远用不上。
    #[test]
    fn engine_id_maps_to_its_cli_binary_name() {
        let mut t = local();
        t.engine_paths
            .insert("mcode".into(), "/home/me/.local/bin/mcode".into());
        assert_eq!(
            resolve_local_program(super::super::cli_binary_name("minimax"), &t).unwrap(),
            "/home/me/.local/bin/mcode"
        );
    }

    #[test]
    fn local_resolution_rejects_windows_binaries() {
        let mut t = local();
        t.engine_paths
            .insert("codex".into(), "/mnt/c/Users/x/codex".into());
        assert!(resolve_local_program("codex", &t).is_err());
    }

    #[test]
    fn wslenv_entries_are_untranslated_and_merged() {
        let mut command = Command::new("wsl.exe");
        let keys = vec!["ANTHROPIC_API_KEY".to_string(), "CCGUI_WSL_PATH".to_string()];
        prepend_wslenv(&mut command, &keys);
        let envs: Vec<(String, String)> = command
            .as_std()
            .get_envs()
            .map(|(k, v)| {
                (
                    k.to_string_lossy().into_owned(),
                    v.unwrap_or_default().to_string_lossy().into_owned(),
                )
            })
            .collect();
        let wslenv = envs
            .iter()
            .find(|(k, _)| k == "WSLENV")
            .map(|(_, v)| v.clone())
            .expect("WSLENV set");
        // `/u` 关闭 WSL 的路径翻译(密钥含 `;`/`:`/换行时不被改写,V9)
        assert!(wslenv.contains("ANTHROPIC_API_KEY/u"));
        assert!(wslenv.contains("CCGUI_WSL_PATH/u"));
    }

    #[test]
    fn hard_reclaim_deadline_matches_design_doc() {
        // §5.7 第 6 条:关闭 GUI 时每个活动 run 的回收单次超时 3s。脚本自身
        // 是 TERM → sleep 1 → KILL(加一次 wsl.exe 启动约 1.7s),超过 3s
        // 只能说明发行版不可达,按 ExitUnproven 交给 UI 提示。
        assert_eq!(kill_timeout(true), Duration::from_secs(3));
        // 正常结束只删启动器,余量可以放宽。
        assert!(kill_timeout(false) > kill_timeout(true));
    }

    #[test]
    fn local_short_call_targets_bash_stdin() {
        // 构造失败时(测试机可能无 wsl.exe)不 panic:非 Windows 返回 Err。
        if let Ok(command) = local_short_call("Ubuntu-24.04") {
            let args: Vec<String> = command
                .as_std()
                .get_args()
                .map(|a| a.to_string_lossy().into_owned())
                .collect();
            assert_eq!(args, vec!["-d", "Ubuntu-24.04", "--exec", "/bin/bash", "-s"]);
        }
    }

    #[test]
    fn workspace_meta_takes_ssh_backend_only() {
        let meta = json!({"wsl": {"host": "h", "user": "u", "distro": "Ubuntu"}});
        let t = from_workspace_meta(&meta).unwrap();
        assert!(!t.is_local());
        assert!(t.ssh().is_some());
    }

    #[test]
    fn launcher_exit_codes_map_to_stable_errors() {
        let t = local();
        let launch = WslLaunchFailure {
            distro: t.distro.clone(),
            program: "/usr/bin/claude".into(),
            workspace: t.workspace.clone(),
        };
        // 61 = 工作目录不存在(V14/V6):带发行版内路径,前端据此提示用户。
        assert_eq!(
            launch_failure_code(LAUNCH_CWD_MISSING, &launch).unwrap(),
            "WSL_CWD_NOT_FOUND:/home/me/repo"
        );
        // 127/126 = 探测缓存里的 CLI 路径失效:只报名字(前端取 basename)。
        assert_eq!(
            launch_failure_code(LAUNCH_CLI_MISSING, &launch).unwrap(),
            "WSL_CLI_NOT_FOUND:claude"
        );
        assert_eq!(
            launch_failure_code(LAUNCH_CLI_NOT_EXECUTABLE, &launch).unwrap(),
            "WSL_CLI_NOT_EXECUTABLE:claude"
        );
        // 其它退出码是 CLI 自己的失败,不能冒充宿主的能力缺失。
        assert_eq!(launch_failure_code(1, &launch), None);
        assert_eq!(launch_failure_code(7, &launch), None);
        // 没有工作区信息时不编路径,退回 `~`。
        let bare = WslLaunchFailure {
            distro: t.distro.clone(),
            program: "claude".into(),
            workspace: None,
        };
        assert_eq!(
            launch_failure_code(LAUNCH_CWD_MISSING, &bare).unwrap(),
            "WSL_CWD_NOT_FOUND:~"
        );
        // 裸命令名同样按 basename 处理(不塞整条路径)。
        assert_eq!(
            launch_failure_code(LAUNCH_CLI_MISSING, &bare).unwrap(),
            "WSL_CLI_NOT_FOUND:claude"
        );
    }

    #[test]
    fn wsl_exe_failures_are_not_launcher_codes() {
        // 发行版不存在:错误码在 stdout(WSL_UTF8 下未翻译,V15)。
        assert_eq!(
            classify_launch_failure(Some(1), "WSL_E_DISTRO_NOT_FOUND", "").unwrap(),
            "WSL_DISTRO_NOT_FOUND"
        );
        // wsl.exe 自己的失败 → 探测失败并保留原因,而不是裸退出码 1(V2/V6)。
        let failed = classify_launch_failure(Some(1), "", "WslRegisterDistribution failed").unwrap();
        assert!(failed.starts_with("WSL_PROBE_FAILED:"), "{failed}");
        assert!(failed.contains("WslRegisterDistribution failed"), "{failed}");
        // CLI 自己的普通非零退出(认证/限流/参数错误)不是 WSL 失败:
        // 返回 None,让 reader 保留引擎原始错误(§10 P1-5)。
        assert_eq!(
            classify_launch_failure(Some(1), "", "authentication failed"),
            None
        );
        // 无退出码(被信号终止)同样归类到探测失败。
        let killed = classify_launch_failure(None, "", "").unwrap();
        assert!(killed.starts_with("WSL_PROBE_FAILED:"), "{killed}");
        // 61/126/127 留给启动器约定,不在这里抢着解释。
        assert_eq!(classify_launch_failure(Some(LAUNCH_CWD_MISSING), "", ""), None);
        assert_eq!(classify_launch_failure(Some(LAUNCH_CLI_MISSING), "", ""), None);
        assert_eq!(
            classify_launch_failure(Some(LAUNCH_CLI_NOT_EXECUTABLE), "", ""),
            None
        );
    }

    #[test]
    fn script_marker_maps_to_session_unreadable() {
        assert_eq!(
            classify_script_marker("WSL_SESSION_UNREADABLE\n").as_deref(),
            Some("WSL_SESSION_UNREADABLE")
        );
        // 别的 stderr 不能误判成会话不可读。
        assert_eq!(classify_script_marker("bash: no such file"), None);
        assert_eq!(classify_script_marker(""), None);
    }
}

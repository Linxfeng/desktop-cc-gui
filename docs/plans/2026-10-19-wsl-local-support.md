# 本机 WSL 工作区支持实施方案（借鉴 synara）

- 日期：2026-10-19（同日完成实机验证并修订）；2026-10-22 按实施结果核对并修订
- 基线：desktop-cc-gui `main` @ 6434632ec（v1.1.6）；实施时已快进到 af3537bee（v1.1.7）；synara @ 299fd57（MIT）
- 状态：阶段 1（§6.1.1–1.9）**已实现**，当前为未提交工作区。本版是实施后的修订稿：§5 中已被代码推翻的设计按实现更正，§10 记录评审结论、P0/P1/P2 缺陷与待决项；2026-10-22 已按 §10 完成一轮修复，逐项状态见 §10.8
- 目标场景：**Windows 上装 GUI，CLI 与开发环境全部在 WSL 发行版内**（同一台机器，不经 SSH）

---

## 1. 目标与非目标

### 1.1 成功标准（阶段 1 验收）

1. 用系统文件夹选择器选中 `\\wsl.localhost\Ubuntu\home\me\repo`，直接成为工作区，无需安装插件、无需授权弹窗。
2. 在该工作区里 Claude Code、Codex、Pi 能多轮对话，用的是**发行版内**的 CLI、配置与登录态（`~/.claude`、`~/.codex`、`~/.pi/agent`），Windows 侧可以完全不装 CLI。
3. 中断（停止按钮）后 3 秒内，发行版内该次运行的**整个 Linux 会话**（含 CLI 拉起的后台子进程）退出；关闭 GUI 后不残留。
4. 失败可诊断：WSL 未安装、发行版不存在、发行版内找不到 CLI、工作目录不存在，各有一条明确的 i18n 提示，不再出现裸 `exit code: 1`。
5. 侧栏列出该工作区在发行版内的 Claude / Codex / Pi 历史会话，可打开回放。
6. 现有 SSH 远程 WSL（插件 `ccgui-plugin-wsl` 写入 `meta.wsl`）行为不变。

### 1.2 非目标

- 不改 SSH 远程 WSL 的协议与插件契约（但 §5.4 修复它和本机共有的 CLI 解析缺陷）。
- 不以插件形式实现本机 WSL；「WSL 管理器」插件（`chenxiangning/ccgui-plugin-wsl`）继续负责远程场景，与本方案共存（§8.1）。
- 不支持 Windows 侧 CLI / Windows git 操作 WSL 内 repo（§3 实测 Windows git 直接拒绝）。
- 阶段 1 不做：computer use、memory MCP、OMP/DSH/OpenCode/Qoder 的 WSL 路径（与现状一致，显式拒绝）。

---

## 2. 主项目现状

| 链路 | 现状 | 位置 |
| --- | --- | --- |
| 工作区识别 | 只认 `meta.wsl = {host,user,port,distro,controlPath,...}`；普通 `add_workspace` 拒绝带 `wsl` 的 meta，只能经插件授权入口 | `src-tauri/src/history/reader.rs:1262`、`plugin_caps::plugin_add_workspace` |
| 引擎发送 | `send_message` → `wsl_transport::transport_for_workspace` → `wrap()` 把命令变成 `ssh host "wsl.exe -d <distro> -- bash /tmp/x.sh"` | `engine/mod.rs:993-1096`、`engine/wsl_transport.rs:385` |
| CLI 解析 | 发行版内 `bash -lc 'command -v <cli>'` | `wsl_transport.rs:build_script` |
| 模型目录 | WSL 工作区走 `models/wsl.rs`，经 `run_script_output` 在发行版内取 | `engine/models/mod.rs:165` |
| 历史回放/删除 | `load_remote_session_page` / `delete_remote_session` 走 `run_script_output`；回放上限 `MAX_REMOTE_SESSION_BYTES = 64 MiB`，base64 全量进内存 | `history/reader.rs:658-700,1033` |
| 会话发现 | 本机扫描按工作区路径找 `~/.claude/projects/<encoded>`；WSL 会话靠插件会话源上报 `remotePath`（前端合并为 `remote: true` 行） | `history/discovery.rs:71`、`src/features/plugins/runtime/session-source.ts` |
| 引擎可用性 | 前端按本机探测；插件可经 `__ccguiWorkspaceUI.allowedEngines` 覆盖 | `src/features/chat/workspace-ui-bridge.ts` |
| 传输限制 | `Transport::Own` 引擎在 WSL 下报错；codex/kimi/grok/minimax 退回 `Child`；grok 因 `cleanup_files` 非空被拒 | `engine/mod.rs:1021-1062` |
| 路径规范化 | `strip_verbatim_prefix` 只去 `\\?\` 前缀 | `files.rs:111`、`history/discovery.rs:103` |
| 终端 | Windows 只用 `COMSPEC` | `terminal.rs:38` |
| Git | `git.rs` 用 git2 0.20.4（libgit2 1.9.7）；`git_worktree.rs` 用 git CLI | `git.rs:80`、`src-tauri/Cargo.lock` |
| 进程回收 | Windows Job Object，只管 Windows 侧进程树 | `engine/job.rs` |

**核心结论**：发送、模型目录、历史回放/删除已经全部经 `WslTransport` 收口，给它加一个"本机"后端即可一次覆盖；会话列表复用"远程会话行"（`remote + remotePath`）这一既有前端形态，不新增前端会话模型。

---

## 3. 实机验证结果

### 3.1 条件

- Windows 内部版本 10.0.26300.9457；WSL2 内核 6.18.33.1-microsoft-standard-WSL2；发行版 Ubuntu-24.04（默认用户 lintao）。
- Windows 侧父进程：`C:\Program Files\nodejs\node.exe`，`child_process.spawn`，不经 shell。libuv 与 Rust `std::process::Command` 都按 MSVC 规则拼接命令行，可作为 GUI 的代理；**未用 Rust 二进制实测**。
- 限制：node.exe 是从 WSL 内经 interop 启动的，继承了 `WSLENV=WT_SESSION:WT_PROFILE_ID::WSL_UTF8/w` 与 `WSL_UTF8=1`。编码实验已显式去掉这两个变量复测；**延迟数据含此条件，原生 Windows GUI 下需复测**。
- CLI：claude 2.1.280（npm 包内是原生 ELF）、codex-cli 0.156.0（`#!/usr/bin/env node` 脚本），均装在 nvm（`~/.nvm/versions/node/v24.17.0/bin`）。

### 3.2 结论表

| # | 实验 | 结果 | 对设计的影响 |
| --- | --- | --- | --- |
| V1 | `--exec /usr/bin/printf '[%s]\n' …`，10 个参数含空格、`"`、尾部 `\`、中文和 emoji、换行、`$HOME`、`*`、`;&\|`、空串 | **全部逐字到达**，无 shell 展开 | argv 可直接传，不需要脚本落盘 |
| V2 | `--exec claude --version`（裸命令名） | 失败：`execvpe(claude) failed`，**退出码 1**（不是 127），错误在 stderr | synara 的裸命令做法在 nvm 环境不可用；必须传绝对路径 |
| V3 | `--exec /bin/sh -c 'echo $PATH'` | 非登录 PATH = 系统目录 + 追加的 Windows PATH（`/mnt/c/...`），无 `~/.local/bin`、无 nvm | 需要把探测到的 PATH 带进去 |
| V4 | `bash -lc 'command -v claude codex'` | **找不到 claude**；codex 解析到 `/mnt/c/Users/lintao/AppData/Roaming/npm/codex`（**Windows 版**） | `-lc` 不可靠（nvm 在 `.bashrc` 第 122 行，排在第 9 行"非交互直接返回"判断之后）；必须过滤 `/mnt/` 结果。**现有 SSH 方案同样受影响** |
| V5 | `bash -ic` 同上 | 两者都解析到 nvm 路径；stderr 为空；耗时 2.4s（`-lc` 1.4s） | 探测用 `-ic`，只做一次并缓存 |
| V6 | `--cd /tmp/不存在` | stderr 打印 `chdir(...) failed 2`，**仍在 `/` 下执行，退出码 0** | 不能用 `--cd`；改由启动器 `cd` 并以 61 失败 |
| V7 | `--cd "/tmp/ccgui exp 中文"` | 正常 | — |
| V8 | Windows 父进程 cwd 设为 `\\wsl.localhost\…\tmp` 或 `\\wsl$\…\tmp`，不带 `--cd` | Linux 侧 `pwd` = `/tmp`（自动翻译） | 仅作兜底，不依赖 |
| V9 | `WSLENV=CCGUI_A/u:CCGUI_B/u`，值含 `;:=`、换行、中文和 emoji | 原样到达；未列出的 `CCGUI_C`、`USERPROFILE`、`APPDATA` 不传入；`HOME=/home/lintao` | 密钥与 PATH 都走 WSLENV；无需落盘、无需手工清理 Windows 变量 |
| V10 | stdin → `--exec /bin/cat` → stdout，字节 `a\r\nb\n中\0z` | 逐字节一致（CRLF、NUL 不变） | 管道二进制安全，历史拉取可不用 base64 |
| V11 | `--exec` 启动的进程 `ps -o pid,pgid,sid` | pid = pgid = sid（父进程为 `Relay`） | 已是会话组长；**不要再套 `setsid`**（会 fork 导致 pid 变化） |
| V12 | 杀 Windows 侧 `wsl.exe`（TerminateProcess），Linux 侧 `sleep & exec sleep` | 3 秒内两者都退出（会话收到 SIGHUP） | 普通情况自动收敛 |
| V13 | 同上但 `trap '' HUP` | **两个进程都存活**；`pkill -TERM -s <sid>` 后全部退出 | 必须做 Linux 侧按会话回收（agent 用 `nohup` 起 dev server 是常见情况） |
| V14 | 启动器完整路径（§4.3）跑 claude / codex `--version` | 均成功；目录不存在 → 61；CLI 不存在 → 127；pidfile 写入正确 | 启动器设计成立；codex 必须带 PATH（node 脚本），claude 原生二进制不依赖 |
| V15 | `wsl.exe -d NoSuchDistro` | 退出码 `0xFFFFFFFF`；**本地化提示在 stdout**，含稳定标记 `Wsl/Service/WSL_E_DISTRO_NOT_FOUND`；无 `WSL_UTF8` 时为 UTF-16LE | 设 `WSL_UTF8=1`；按错误码标记分类，不匹配本地化文案 |
| V16 | `wsl.exe -l -q` | 无 `WSL_UTF8`：UTF-16LE（无 BOM）；`WSL_UTF8=1`：UTF-8；行尾 `\r\n` | 同上 |
| V17 | 15 次 `--exec /bin/true` | min 563 / p50 714 / p90 932 / max 1038 ms | 每次 `wsl.exe` 调用约 0.7s；短调用要合并、要缓存 |
| V18 | Windows API `GetFinalPathNameByHandleW`（Rust `canonicalize` 同一调用） | `\\wsl.localhost\X\…` → `\\?\UNC\wsl.localhost\X\…`；`\\wsl$\…` → `\\?\UNC\wsl$\…`；发行版名大小写按输入保留 | **现有 `strip_verbatim_prefix` 会得到相对路径 `UNC\wsl.localhost\…`，是确定的 bug** |
| V19 | 经 UNC 扫描 `~/.claude/projects`（22 目录 / 446 文件 / 837 MB） | 列目录 + stat：6.0–8.1 s；读全部文件前 16 KB：10.3 s；读最大文件 93 MB：3.1–4.0 s。WSL 内 `find` 同一操作 31 ms | **UNC 扫描不可用**，必须在发行版内扫描 |
| V20 | 发行版内 `find -printf '%p\t%s\t%T@\n'` 经管道返回 | 672 ms（含 wsl.exe 启动） | 列表 + 签名一次调用完成 |
| V21 | 发行版内读全部文件头（base64）经管道返回 9.8 MB | 5.3 s | 只读签名变化的文件 |
| V22 | 经管道 `cat` 93 MB 转录本 | 4.7 s（约 20 MB/s） | 大转录本要增量拉取；现有 64 MiB 上限会拒绝本机上最大的会话 |
| V23 | 经 UNC 列 51 项目录并 stat / 完整遍历仓库 1396 文件 | 812 ms / 1397 ms；WSL 内 `rg --files` 75 ms | 文件树可走 UNC（按需展开）；@-mention 与搜索必须走发行版内 rg |
| V24 | Windows `git.exe -C \\wsl.localhost\…\desktop-cc-gui status` | `fatal: detected dubious ownership`，2.8 s；WSL 内 git 33 ms | Git 必须走发行版内 git。git2 链接的 libgit2 1.9.7 同样有所有权校验（**推断，未用 Rust 实测**） |
| V25 | `wsl.exe --exec /bin/bash -s`，脚本经 stdin | 正常，604 ms | 短调用不需要先上传脚本 |

---

## 4. synara 借鉴清单（按与本场景的相关度排序）

### 4.1 直接借鉴

| # | synara 做法 | 位置 | 落到主项目 | 实测修正 |
| --- | --- | --- | --- | --- |
| A1 | UNC 即工作区标识，`\\wsl.localhost` / `\\wsl$` 解析为 `{distribution, linuxPath}`，非 WSL 共享不误判 | `packages/shared/src/windowsProcess.ts:37-61`、`windowsWslProcess.test.ts` | §5.1 | 还要接受 `\\?\UNC\` 形式（V18） |
| A2 | 单一平台启动边界：provider 只交出逻辑命令，`prepareProcess` 决定是否走 `wsl.exe`，计划里带 `executionBackend` | `platformProcess.ts:175-205`、`docs/windows-runtime.md` | §5.2 `WslBackend::Local` | — |
| A3 | 无 shell 启动 `wsl.exe --distribution --cd --exec` | `windowsProcess.ts:130-146` | §5.3 | argv 逐字传递已证实（V1）；但 `--cd` 失败会静默落到 `/`（V6）、裸命令名找不到 nvm CLI（V2），两处都要改 |
| A4 | 协议 payload 里的 `cwd` 转 Linux 路径 | `apps/server/src/provider/acp/AcpSessionRuntime.ts:338`、`AcpWslCwd.test.ts` | §5.6 阶段 2 | — |
| A5 | CI 边界守卫，禁止业务代码自行处理平台进程细节 | `scripts/check-windows-runtime-boundary.ts` | §5.10 | — |
| A6 | 类型化启动失败，`WorkingDirectoryNotFound` 先于 `ExecutableNotFound` | `platformProcess.ts:64-90` | §5.8 | 退出码 61/127 由启动器给出，判定稳定（V14） |
| A7 | 回收无法证明成功时 fail-closed（`ExitUnproven`） | `windows-runtime.md` "Process-tree teardown" | §5.7 | V13 证明确有存活进程的情况 |
| A8 | Linux 侧 `renice` 后 `exec` | `platformProcess.ts:priorityExecArgs` | 可选，阶段 3 | — |

### 4.2 不照搬

| 项 | synara | 主项目 |
| --- | --- | --- |
| CLI 解析 | `--exec <裸命令名>`，非登录 PATH | V2–V5：用 `bash -ic` 探测一次，缓存绝对路径与 PATH，过滤 `/mnt/` |
| `--cd` | 直接用 | V6：改由启动器 `cd` |
| 会话发现、发行版策略、设置页 | 文档明写 follow-up（`docs/windows-runtime.md:81-85`） | §5.5、§5.9 自行设计 |
| 终端、Git、搜索 | 未做 | §6 阶段 1/2 |
| 进程树 | 未做 Job Object | 保留主项目 Job Object，补 Linux 侧回收 |

### 4.3 与本场景无关，后续再议

见 §9。

---

## 5. 设计

### 5.1 工作区识别：`src-tauri/src/engine/wsl_path.rs`（新增）

```rust
pub struct WslUncPath { pub distro: String, pub linux_path: String }

/// 接受：\\wsl.localhost\D\a、\\wsl$\D\a、//wsl.localhost/D/a、
///       \\?\UNC\wsl.localhost\D\a、\\?\UNC\wsl$\D\a（V18）。主机名大小写不敏感。
/// 拒绝：非 wsl 主机的 UNC、空发行版名、发行版名不过 is_safe_distro。
pub fn parse_wsl_unc(path: &str) -> Option<WslUncPath>;

/// 统一成 \\wsl.localhost\<发行版名>\…；`known_distros` 非空时按大小写不敏感匹配
/// 到规范拼写，为空时保留输入拼写（见下方"实现取舍"）。
pub fn normalize_wsl_unc(path: &str, known_distros: &[String]) -> Option<String>;

/// Linux 路径 → UNC（会话 cwd 映射回工作区）。
pub fn to_wsl_unc(distro: &str, linux_path: &str) -> String;
```

- 解析层是**跨平台纯函数**，不设平台门：只有真正调用 `wsl.exe` 的 `wsl_probe` 按 `#[cfg(windows)]` 分支。纯函数因此能在 Linux 与 Windows CI 上直接跑（实施时已这样落地，原「仅 windows 生效」作废）。
- **顺带修 bug**：`files.rs:111` 与 `history/discovery.rs:103` 的 `strip_verbatim_prefix` 增加 `\\?\UNC\` → `\\` 分支（V18）。否则已授权目录、Claude 项目目录匹配在 UNC 下全部失效。这一步与 WSL 无关，也影响普通 SMB 共享工作区。
- 入库前规范化，避免 `\\wsl$`、`\\wsl.localhost` 产生重复工作区行。
- **实现取舍（与初稿的差异）**：`add_workspace_inner` 是**同步**命令，拿不到 `wsl.exe -l -q` 的结果，因此入库时只做**形状归一**（`\\wsl$` 别名、主机名大小写、分隔符、尾斜杠），**发行版名逐字保留** —— 即 `normalize_wsl_unc(path, &[])` 的"未知发行版保留拼写"分支。要把发行版名的大小写也归一，需要进程级发行版列表缓存 + 启动期预取 + 重新检测时失效 + `WslSection.tsx` 挂载时顺序化（先 `wslDistros()` 再 `wslReprobe()`，否则前端拿不到列表）四套机制；而实测 `wsl.exe -d ubuntu-24.04 --exec /bin/sh -c …` 正常执行，说明发行版名大小写**不影响任何下游行为**（`parse_wsl_unc` 得到的名字只用于 `wsl.exe -d` 与缓存键），只影响"同一目录两种大小写拼写各占一行"这一个罕见情形。代价大于收益，故仅做形状归一。`normalize_wsl_unc` 的 `known_distros` 参数与单测保留：调用方若将来能拿到列表（如异步登记入口）可直接传入，不必再改签名。
- **残留风险（已接受）**：形状归一后，`\\wsl$\Ubuntu-24.04\…` 与 `\\wsl.localhost\ubuntu-24.04\…` 仍可能各占一行。另：`is_safe_distro` 目前只是字符白名单，**必须显式拒绝 `.`、`..` 与纯空格发行版名**（§10 P2-1）；否则 `to_wsl_unc` 会拼出带 `..` 的 UNC，用于写启动器与删缓存文件。
- **不写 meta、不走插件授权**：本机 WSL 不出站。`add_workspace` 拒绝 `meta.wsl` 的规则保持不变。

### 5.2 传输抽象：给 `WslTransport` 加后端

```rust
pub enum WslBackend {
    /// 现有：ssh → 远程 Windows → wsl.exe（插件 meta.wsl）
    Ssh { host: String, port: u16, user: String, control_path: Option<String> },
    /// 新增：本机 wsl.exe
    Local,
}

pub struct WslTransport {
    pub backend: WslBackend,
    pub distro: String,
    pub engine_paths: HashMap<String, String>,
    pub workspace: Option<String>, // 发行版内 Linux 路径
}
```

- `transport_for_workspace(db, path)` 判定顺序是**契约**：工作区行带合法 `meta.wsl` → `Ssh`；否则 `parse_wsl_unc` 命中 → `Local`；都不是 → 本机原生。显式插件意图优先，保证 §1.1 第 6 条；两类工作区的键（Linux 路径 / UNC）不会相撞。
- **所有新入口必须复用同一判定**：`wsl_list_sessions`、`wsl_engine_availability`、`wsl_index`/`files::list_file_index` 目前直接 `parse_wsl_unc`，对「UNC + meta.wsl」工作区会走本机，而发送/回放/删除走 SSH（§10 P1-3）。规则：先查 `meta.wsl`，再解析 UNC。
- **`meta.wsl` 存在但字段非法**：fail-closed 拒绝并报错，不回退到 `Local`（当前实现会回退，§10 待决 D2）。
- send/models/history 主链路仍只经 `WslTransport`，但「三处调用方不改」已不成立：`models/wsl.rs` 的 cwd 对 Local 走 `sh_quote`，`files.rs` 增加 WSL 分支，`engine/mod.rs` 过滤 WSL 的 `--add-dir` 并新增 CLI 预检、启动器清理与会话回收。
- `Local` 的 `engine_paths` 来自 §5.4 探测缓存，并把设置里的覆盖同时登记到「命令名」和「引擎 id」两个键（`minimax → mcode`）。
- `wrap()` / `run_script_output()` 内按 backend 分派；`Ssh` 分支除 §5.4 的解析修复外原样保留。
- `wsl.exe` 路径固定为 `%SystemRoot%\System32\wsl.exe`（不从 PATH 解析，避免同名劫持；与 synara `resolveWindowsWslExecutable` 一致）。

### 5.3 启动命令（`Local` 后端）

**所有 `wsl.exe` 调用的公共设置**

- env：`WSL_UTF8=1`（V15/V16）；`WSLENV` = 用户已有值 + 本次需要传递的键（`/u` 标志），不覆盖用户值。
- `CREATE_NO_WINDOW`（现有 `hide_console`）；Job Object 照常挂在 `wsl.exe` 上。
- Windows 侧 `current_dir` **不设置**（`skip_local_cwd = true`）；真正的 cwd 只由启动器 `cd` 决定。V8 的 UNC 自动翻译只作为实验结论保留，不是实现依赖。

**发送路径**（长驻；stdin 承载 prompt；stdout 为 NDJSON）

```
wsl.exe -d <distro> --exec /bin/sh /tmp/ccgui-launch-<run_id>.sh <run_id> <linux_cwd> <abs_cli> <args…>
```

启动器是编译期常量，不拼接任何运行时数据（V14 实测版本）；先经 UNC 写到发行版 `/tmp/ccgui-launch-<run_id>.sh`，再以文件路径执行：

```sh
[ -n "$CCGUI_WSL_PATH" ] && export PATH="$CCGUI_WSL_PATH"
echo $$ > "$(dirname "$0")/ccgui-run-$1.pid"
cd -- "$2" || exit 61
shift 2
exec "$@"
```

不用 `sh -c '<LAUNCHER>' ccgui …`：`sh -c` 的 `$0` 是人工传入的字符串，不能当路径用，而 pidfile 必须落在脚本同目录（`dirname "$0"`）。`run_id` 已限制为 `[A-Za-z0-9_-]`、非空、≤128 字节，可直接作文件名与 argv。

- 不用 `--cd`：目录缺失时 `wsl.exe` 会静默在 `/` 运行（V6）。
- 不套 `setsid`：`--exec` 起的进程已是会话组长（V11），`exec` 后 CLI 的 pid = sid。
- `/bin/sh <path>` 不读任何 profile，profile 里的 `echo` 不会混进 NDJSON。
- `<abs_cli>` 来自探测缓存；绝不传裸命令名（V2）。
- pidfile 放在**启动器同目录**（实际 `/tmp`），不用 `${XDG_RUNTIME_DIR:-/tmp}`：`WSLENV` 会把 Windows 侧的 `XDG_RUNTIME_DIR` 带进发行版，而 `/run/user/<uid>` 在非登录会话下常常不存在或不可写；`echo $$ > …` 失败会让回收静默失效，正是 V13 要防的场景。
- env：`build_command` 显式设置的 env（`program_args_env` 已能取出，含 provider 密钥）+ `CCGUI_WSL_PATH`（探测到的交互 shell PATH）设到 `wsl.exe` 进程上并列入 `WSLENV`（V9）。密钥只在进程环境中，不落盘、不进 argv。
- `WSLENV` 必须与用户已有值**合并**而不是覆盖：同名键保留用户标志，`/u` 只加在本应用新增的键上；`CCGUI_WSL_PATH` 是保留名，用户同名变量不得透传。
- 威胁模型：密钥进入发行版进程环境后，同发行版的同一用户可通过 `/proc/<pid>/environ` 读取。接受该风险（与 CLI 自己读 `~/.claude` 凭证同一信任级），文档与评审记录需明示。
- `PATH` 不能直接经 WSLENV 传（WSL 对 PATH 有特殊翻译），所以用 `CCGUI_WSL_PATH` 中转。
- `codex_provider_env::apply` 对 `Local` 跳过。`resolve::cli_search_path()` 目前仍在 wrap 之后**无条件**设置 Windows PATH（`engine/mod.rs:1236`），WSL 会把它翻译成 `/mnt/c/…` 追加到 Linux PATH；发送路径由 `CCGUI_WSL_PATH` 覆盖，但探测缓存未就绪的短调用可能解析到 Windows 同名程序（V4 根因）。规则：Local 分支不得携带 Windows PATH（§10 P1-14）。
- `CODEX_HOME` 若被宿主设成 Windows 路径会经 WSLENV 透传，只有探测到发行版值时才覆盖；规则：Windows 专有路径键不得过界（§10 P1-14）。
- 退出码约定：61 = 工作目录不存在；127 = CLI 不存在；126 = 不可执行。都由启动器给出，判定稳定（直接 `--exec` 失败时退出码是 1，无法区分，V2）。**其余退出码一律视为 CLI 自身的退出**，不得翻译成 WSL 探测失败（§5.8、§10 P1-5）。

**短调用路径**（`run_script_output`：模型目录、历史、删除、探测）

```
wsl.exe -d <distro> --exec /bin/bash -s      # 脚本经 stdin 送入（V25）
```

- 去掉 SSH 方案的 `tee` 上传步骤，单次调用约 0.6–0.9s（V17）。
- 调用方脚本不变；`REMOTE_CALL_TIMEOUT`（30s）与 `strip_transport_noise` 复用。
- 需要 PATH 的脚本（如模型目录调用 CLI）在脚本头加 `export PATH="$CCGUI_WSL_PATH"`，同样经 WSLENV 传入。

### 5.4 CLI 探测与缓存：`src-tauri/src/engine/wsl_probe.rs`（新增）

探测脚本经 `bash -ic` 运行（V4/V5：nvm 等常见安装写在 `.bashrc` 的交互判断之后，`-lc` 找不到）：

```sh
printf '\n__CCGUI__HOME=%s\n__CCGUI__PATH=%s\n__CCGUI__CODEX_HOME=%s\n' "$HOME" "$PATH" "${CODEX_HOME:-}"
for c in claude codex kimi grok mcode rg git; do
  for p in $(type -ap "$c" 2>/dev/null); do
    case "$p" in /mnt/[a-z]/*) continue ;; esac   # 跳过 Windows 侧同名程序（V4）
    printf '__CCGUI__BIN %s=%s\n' "$c" "$p"; break
  done
done
```

- 只解析 `__CCGUI__` 开头的行，profile/motd 输出一律丢弃。
- 实现细节：`type -ap` 的结果用 `while read` 逐行处理（不用 `for p in $(…)`，否则带空格的路径会被拆开）；过滤范围是 `/mnt/*`（比设计稿的 `/mnt/[a-z]/*` 更宽，覆盖大小写盘符）；额外对每个 CLI 取 `--version` 首行、`timeout 3` 兜底。命令集是 `claude codex kimi grok mcode pi rg git`。
- 缓存：进程内 `BTreeMap<distro, Arc<WslProbe>>`，带 **5 分钟 TTL**；探测失败不写缓存；`cached()` 不看 TTL（先让用户发出去），发送前由 `ensure()` 刷新。
- 时机：**没有后台预取**。首次发送在 `send_reserved` 前台等待探测（最多 30s），会话列表、引擎可用性、设置页也会触发；因此「添加工作区后后台探测、不阻塞 UI」尚未落实（§10 P1-12）。
- **没有 single-flight，也没有负缓存**：并发调用会重复跑 2.4s 的交互 shell，冷探测（含 `--version`）最坏 15s 以上；不可达发行版会反复阻塞（§10 P1-17）。后续规则：同一发行版同时只允许一次探测，失败结果短 TTL 缓存。
- 发送前预检：每次发送多跑一次 `test -f` / `test -x` 短调用（约 0.7s，V17），在探测缓存有效期内也照跑。当前 `exec_local_exit` 对任何非零退出直接返回 `Err`，预检里的 126/127 分支是死代码，CLI 被删/去执行位时用户看到的是 `WSL_SHORT_CALL_FAILED` 而不是 `WSL_CLI_NOT_FOUND`（§10 P1-5）。规则：预检要么合并进探测、要么让错误码真正可达；不应为每一次发送固定增加 0.7s。
- 失效：运行中收到 127/126 → 清该发行版缓存，但**不自动重跑该回合**；下次发送由预检重探测。设置页「重新检测」与应用重启同样清缓存。
- 设置页按**发行版 + 引擎**覆盖 CLI 绝对路径（优先于探测）。校验：以 `/` 开头、不在 `/mnt/` 下、无控制字符；允许空格、引号与中文（与 V1 的 argv 语义一致）。但模型目录侧的 `shell_safe_bin` 仍用严格字符白名单，会静默丢弃带空格/中文的合法覆盖路径（§10 P1-16），两侧规则必须统一。
- 发行版列表：带 `WSL_UTF8=1` 调 `wsl.exe -l -q`，按 `\r\n` 切分，保留 UTF-16LE 解码兜底（V16）。当前实现把超时/非零退出都吞成空表，无法区分「WSL 未安装」「没有发行版」「发行版列表读失败」（§10 P2-6）。
- **SSH 后端同步修复**：`resolve_bin_script` 从 `bash -lc 'command -v X'` 改为 `-ic` + 哨兵 + `/mnt/` 过滤（V4），但不是同一段 `PROBE_SCRIPT`，且长驻 run 内没有超时；`.bashrc` 里有阻塞式 `read` 时会挂住 SSH 发送（§10 P1-15）。

**引擎可用性**：IPC 为 `wsl_engine_availability(workspacePath) -> Vec<String>`，按发行版探测结果与设置覆盖合并。前端 composer 对 WSL 工作区用它代替本机探测，过滤点复用插件 `allowedEngines` 那一处。**两条硬规则**：

1. Windows 侧未安装 CLI 时不得隐藏发行版里装着的引擎。当前 Hook 在探测中/失败时返回 `null`，`filterEngineOptions` 随即按本机 `available` 过滤，正好把引擎隐藏掉（§10 P1-1）。规则：探测未完成时保留上一次结果或显式「未知」，失败时返回全部已注册引擎，绝不回落到本机探针。
2. 设置页保存覆盖或「重新检测」后，已挂载的聊天页必须重新取一次可用性；当前 Hook 只依赖工作区路径，切换回聊天不会刷新（§10 P1-1）。

### 5.5 会话发现与历史

UNC 扫描实测不可用（V19：446 个文件列目录 6–8s，读头 10s）。全部改在发行版内完成。

**列表**（复用"远程会话行"形态）

- IPC 为 `wsl_list_sessions(workspacePath) -> Vec<WslSessionRow>`，行字段与插件会话源一致（`engine`、`sessionId`、`workspacePath`、`title`、`updatedAt`、`remotePath`）。`workspacePath` 是**传入的 UNC 工作区路径**，不是发行版内 Linux 路径（原设计写反了）。前端由独立模块 `src/features/chat/wsl-sessions.ts` 合并，不塞进 `session-source.ts`；打开/删除仍走既有 `remote + remotePath` 分支。
- 合并去重：插件源与宿主 WSL 源之间必须按 `(engine, sessionId, workspacePath)` 去重。当前 `mergeExternalSessions` 只把**本地**会话放入 `seen`，外部数组内部不再去重，同一会话可能出两行；前端行 `id` 是 `engine/sessionId`，父/子嵌套工作区会直接产生 React 重复 key（§10 P1-11）。
- 一次短调用拿全量签名（V20，约 0.7s）：
  - Claude：`find "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/projects/<encoded>" -maxdepth 1 -name '*.jsonl' -printf '%p\t%s\t%T@\n'`，`<encoded>` = Linux 路径把 `/` 换成 `-`（已核对 `/home/lintao/projects/desktop-cc-gui` → `-home-lintao-projects-desktop-cc-gui`）。
  - Codex：`find "${CODEX_HOME:-$HOME/.codex}/sessions" -name '*.jsonl' -printf …`，按头部 `session_meta.payload.cwd` 归属工作区。**必须复用 `is_codex_subagent_file` 排除子代理 rollout**，否则子代理转录本会作为独立会话出现在侧栏、删除时可能误删（§10 P2-5）。
  - Pi：`find "${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/sessions" -name '*.jsonl' -printf …`。会话 id 取文件名 `<timestamp>_<uuid>.jsonl` 的 UUID 段（`--session <id>` 只认它）；归属同样读头部 `cwd`，与 Claude 一样在编码碰撞时复核。
- 归属规则：
  - Codex 用「cwd 等于工作区或以 `工作区/` 开头」判定。嵌套工作区（`/repo` 与 `/repo/sub`）目前会让同一会话同时出现在父子两个工作区，应改为最长前缀唯一归属（§10 待决 D6）。
  - Claude 只按目录名 `<encoded>` 取文件，没有校验转录本里的 cwd。编码规则把 `/` 与 `_` 等字符都替换为 `-`，`/home/a_b` 与 `/home/a-b` 会落到同一项目目录而互相串会话；建议像 Codex 一样读头部 cwd 复核（§10 待决 D5）。
- 签名缓存在本机 db 新表 `wsl_session_cache`（主键 `(distro, remote_path)`；值 = size、mtime、title、cwd、session_id、engine），另有进程内 `HeadCache` 与前端模块级缓存。只对签名变化的文件批量取前 16 KB（V21：全量读头 5.3s，增量通常 < 1s）。
- **读头失败不能让 Codex 行消失**：`build_rows` 先用空 cwd 过滤，只有 `heads_script` 成功后才回填；读头失败时该工作区所有 Codex 行都没有了（§10 P1-8）。规则：先按缓存归属保留行，读头失败沿用旧标题或显示占位，不得整行丢弃。
- **只读当前工作区相关的头部**：首次扫描会基于「全部 Codex 会话」计算变更集，读取其他工作区转录本的前 16 KB 并写入 db（§10 P1-9）。规则：先按缓存/路径过滤归属，再决定读哪些头。
- 刷新时机：目前是 `init`、每次 `refreshSessions`、每次 `refreshEngines` 都扫，缓存命中时还会每轮后台补扫；没有 TTL/节流，后台扫描完成也不会通知 store 重渲染（§10 P1-12）。原设计「获得焦点、会话结束、手动刷新，不做轮询」未落实，需二选一并写进验收。

**回放**（`load_remote_session_page`）

- `Local` 后端改为管道直传原始字节（V10 证明二进制安全），不经 base64，流式写入 `app_home/remote-sessions/<hash>.jsonl`，不整块进内存。
- 增量判定：缓存旁路文件记录远端 `size|mtime`；一次短调用同时取回远端签名与**缓存末尾 4 KB 对应的远端窗口**。远端变长且本地末尾窗口逐字节一致 → 只 `tail -c +<old+1>` 追加，否则全量 `cat` 覆盖（`mtime` 变化能识别压缩/重写，窗口比对能识别截断）。
- 实现缺陷：`window_matches` 用 `std::fs::read` 把**整个缓存文件**读入内存再取末尾 4 KB（`history/reader.rs:799-803`）。93 MB 会话每次打开都会整块读一次，且发生在 async 上下文；应改为 `seek` 到末尾只读 4 KB。全量拉取失败会留下半文件，需在失败时截回/删除（§10 P1-19）。
- 上限从 64 MiB 提高到 512 MiB（只对 `Local`；V22：本机最大会话 93 MB，全量 4.7s，之后只拉增量）。SSH 后端保持原逻辑。注意上限只限制拉取，解析仍把整份转录本读入内存，512 MiB 有 OOM 风险（§10 P1-19）。

### 5.6 引擎传输矩阵

| 引擎 | 本机非 WSL | 阶段 1（本机 WSL） | 阶段 2（本机 WSL） |
| --- | --- | --- | --- |
| Claude | Child | Child（§5.3） | 同左 |
| Codex | Own（app-server） | Child（`codex exec --json`，与 SSH WSL 一致） | Own：app-server 的 spawn 走同一启动器，协议 `cwd` 转 Linux 路径（A4） |
| Kimi / MiniMax | Own（ACP） | Child | Own（ACP，同上） |
| Pi | Child（rpc） | Child（rpc，§5.3；ask bridge 经 UNC 暂存到发行版） | 同左 |
| Grok | Own（ACP） | 拒绝（staging 文件在 Windows 侧） | staging 写到 `\\wsl.localhost\<d>\tmp\…`，传 Linux 路径 |
| OMP/DSH/OpenCode/Qoder | — | 拒绝，提示文案沿用 | 视需求 |
| computer use / memory MCP | — | 拒绝 | 可选：WSL interop 可从 Linux 执行 `/mnt/c/.../*.exe`，需实测 |

- 阶段 2 改造点：`transport_for(wsl: bool)` 改为接收 `enum WorkspaceExec { Native, WslSsh, WslLocal }`，`WslLocal` 时 codex/kimi/minimax/grok 返回 `Own`；`host_command` 的产物在 driver spawn 前经 `wsl_transport::wrap_local`；driver 写进协议的 `cwd`/文件路径统一调 `wsl_path::execution_cwd(workspace)`。
- `send_message` 中 `wsl_tp.is_some()` 的拒绝分支要区分 `Ssh` 与 `Local`，避免阶段 2 放开时误伤 SSH。

### 5.7 中断与进程回收

V12/V13 已证实：杀 `wsl.exe` 会让 Linux 会话收到 SIGHUP，普通进程会退出；忽略 SIGHUP 的进程（`nohup`、守护化的 dev server）会存活；`pkill -s <sid>` 能清理。

1. 启动：启动器写 `/tmp/ccgui-run-<instance>-<run_id>.pid`，内容为 `sid` 与**会话组长的 starttime**（`/proc/$$/stat` 第 22 列）。`instance` 是**按应用数据目录稳定**的短哈希（同一 profile 恒定、不同 profile 不同），用于多实例隔离；`run_id` 已校验（非空、≤128 字节、`[A-Za-z0-9_-]`）。
   - 不再用 `${XDG_RUNTIME_DIR:-/tmp}`：Windows `XDG_RUNTIME_DIR` 可能经 WSLENV 传入且 `/run/user/<uid>` 常常不可写。
   - 不再从启动器 `dirname` 推 pidfile：路径固定为 `/tmp`，回收时不需要启动器仍在。
2. 中断：先杀 Windows 侧进程树（Job Object），随后一次短调用（脚本经 stdin，参数用位置参数传入）：
   ```sh
   f=/tmp/ccgui-run-$1-$2.pid
   { read -r s; read -r start <&0; } < "$f" 2>/dev/null || exit 2   # 2 = 无凭证
   now=$(awk '{print $22}' /proc/"$s"/stat 2>/dev/null) || exit 1    # 1 = 已退出
   [ "$now" = "$start" ] || exit 3                                  # 3 = sid 已复用
   pkill -TERM -s "$s"; sleep 1; pkill -KILL -s "$s"
   rc=$?; rm -f "$f"; [ "$rc" -le 1 ] || exit 4                     # 4 = 未能证明
   ```
   退出码语义：`0` 成功、`1` 目标已不存在（成功）、`2/3/4` 回收未确认。**不得**像当前实现那样「pidfile 缺失就 `exit 0`」，也不得忽略 `pkill` 退出码。
3. 正常结束：turn 结束后**保留 pidfile**、只删启动器脚本。原因：CLI 退出后它用 `nohup` 拉起的 dev server 仍可能存活，若此时删掉 pidfile，关闭 GUI 时就再也找不到它，与 §1.1 第 3 条「关闭 GUI 后不残留」冲突。pidfile 在应用退出与下次启动清扫时删除；超过 24h 的陈旧文件顺带清理。
4. 启动兜底：应用启动时只扫描**本 instance** 的 `/tmp/ccgui-run-<instance>-*.pid`，按第 2 步校验 starttime 后清理，不碰其它 profile 或用户手动启动的 CLI。当前实现扫全部 `ccgui-run-*.pid`，两个 GUI 实例会互相误杀（§10 P1-18）。
5. 无法确认（发行版不可达、pidfile 不可读、starttime 不匹配、`pkill` 非 0/1）→ 记录 `ExitUnproven` 并进入通知队列，UI 提示「WSL 内进程可能仍在运行」，不静默（A7）。
6. 关闭 GUI：退出流程必须**等待**回收完成（不能只 `runtime.spawn` 后关闭运行时），总预算 5s、单发行版 2s；超时未完成的按第 5 条记 `ExitUnproven`。当前实现 `kill_all` 只 spawn 不 await，运行时关闭后任务可能根本没跑（§10 P1-7）。
7. **参数契约**：`Wrapped.local_run` 与 `ChildEntry.wsl_local` 统一为 `{ distro, run_id }`（结构体或固定顺序），生产/消费两侧各有单测断言。当前生产是 `(run_id, distro)`、消费按 `(distro, run_id)` 解构，停止时回收必然空转（§10 P0-1）。

### 5.8 错误分类：稳定错误码（原 `WslLaunchError` 枚举未落地）

实现没有使用枚举，而是用稳定字符串前缀跨 IPC；前端 `errorText()` 按前缀翻译。契约如下（前缀即协议）：

| 错误码 | 产生层 | 判定依据 |
| --- | --- | --- |
| `WSL_NOT_INSTALLED` | probe/短调用 | `%SystemRoot%\System32\wsl.exe` 不存在 |
| `WSL_DISTRO_NOT_FOUND` | probe/短调用 | 输出含稳定标记 `WSL_E_DISTRO_NOT_FOUND`（V15，不匹配本地化文案） |
| `WSL_START_TIMEOUT` | probe | 发行版探测超过 30s |
| `WSL_PROBE_FAILED:<detail>` | probe | `bash -ic` 探测脚本失败（**只用于探测本身**） |
| `WSL_CWD_NOT_FOUND:<path>` | 启动器 | 退出码 61（V14） |
| `WSL_CLI_NOT_FOUND:<cli>` | 预检/启动器 | 探测无结果，或退出码 127 |
| `WSL_CLI_NOT_EXECUTABLE:<cli>` | 预检/启动器 | 退出码 126 |
| `WSL_SHORT_CALL_TIMEOUT:<secs>` | 短调用 | 30s 超时 |
| `WSL_SHORT_CALL_FAILED:<code>:<stderr>` | 短调用 | 其它非零退出 |
| `WSL_TRANSCRIPT_TIMEOUT` / `WSL_TRANSCRIPT_UNREADABLE` | 回放 | 180s 超时 / 脚本标记 |
| `WSL_SESSION_UNREADABLE` / `WSL_SESSION_TOO_LARGE:<size>:<cap>` | 回放 | 文件不可读 / 超 512 MiB |
| `WSL_CLI_PATH_INVALID:<reason>` | 设置写入 | 覆盖路径不合法（`wsl.cliPathReason.*`） |
| `WSL_EXIT_UNPROVEN:<detail>` | 回收 | §5.7 第 5 条；**只进通知队列**，不经错误横幅 |

规则：

- **区分「wsl.exe 自己失败」与「CLI 自身非零退出」**：只有出现已知 WSL 标记（`WSL_E_*`、`Wsl/Service`、`execvpe`、`chdir` 等）、或退出码为 61/126/127 时，才翻译成 `WSL_*`；其余退出码（含 1）保留引擎原始错误与 stderr，不得改写为 `WSL_PROBE_FAILED`。当前实现把所有非 61/126/127 都归为探测失败，认证失败/限流会被显示成「发行版探测失败」（§10 P1-5）。
- 回放路径同样要采集 **stdout**（V15 的发行版错误在 stdout）；当前 `run_script_to_file_local` 只看 stderr（§10 P1-5）。
- 进入错误横幅的 stderr 必须与 stdout 一样脱敏，不能只对 stdout 调 `redact_secrets`（§10 P1-5）。
- 未识别的 `WSL_*` 前缀必须有通用回落文案，不能把裸英文码展示给用户（§10 P2-2）。
- `wsl.exe` 自身的错误在 **stdout**（V15），Relay 错误（`<3>WSL (...) ERROR: ...`）在 stderr（V2、V6），两处都要采集。
- 日志带发行版名、引擎、退出码、错误码；不打印 env 值与 prompt。

### 5.9 前端、设置与文件访问

- 侧栏：WSL 工作区显示发行版徽标（宿主内建，复用 `labelSuffix` 渲染位）。
- **与插件钩子共存**：`window.__ccguiWorkspaceUI` 只有一个槽位（`registerHooks` 直接替换）。宿主内建的 `allowedEngines` / 徽标判断**不得**注册进该槽位，否则装了「WSL 管理器」插件后会被覆盖。做法：在求值处先判断是否为本机 UNC 工作区，是则用宿主结果，否则交给插件钩子（实现已按此落地）。
- **前端判定必须带 `meta.wsl`**：只按路径形状判断会把插件登记、路径恰好是 UNC 的远程工作区误当成本机 WSL（徽标、引擎探测、会话列表全部走错后端）。规则：`workspace.meta.wsl` 存在时一律交给插件/SSH 路径（§10 P1-3）。
- **会话源共存**：宿主 WSL 源与插件 `wsl-remote` 源按 `(engine, sessionId, workspacePath)` 去重；`workspacePath` 对宿主行是 UNC、对插件行是 Linux 路径，本身不会互相遮蔽，但同一会话被两边上报时仍会重复（§10 P1-11）。
- 设置 → 新增「WSL」分组：发行版列表、各发行版内 CLI 与版本、**按发行版 + 引擎**的「CLI 路径覆盖」、「重新检测」。
  - 当前页面每次挂载都调用 `wsl_reprobe`，等于清空全部缓存并重探测；「读取当前结果」与「重新检测」没有分开。规则：挂载只读当前探测结果（新增只读 IPC 或让 `wsl_reprobe` 接受 `force=false`），「重新检测」才清缓存；保存某个覆盖后只重探该发行版。
  - 单发行版探测失败只写控制台，页面显示「没有探测到 CLI」，无法区分「启动超时」与「真没装」（§10 P2-6）。
- **Web 模式**：本机 WSL 是桌面能力，7 个 `wsl_*` IPC 不进入 `web/dispatch.rs`。因此设置页 WSL 分组必须在 Web 访问端与非 Windows 平台隐藏；前端不能再用 `typeof ipc.wslXxx !== "function"` 判断（`ipc.ts` 始终定义这些函数），要用 `isWeb` / 平台判断（§10 P1-2）。
- **授权边界**：本机 WSL「不出站」不等于「无授权边界」。工作区登记与 granted-roots 检查仍必须适用于回放/删除：不能只校验路径形如 `…/projects/…/x.jsonl` 就允许读/删该发行版内任意文件（§10 P1-4）。
- 文件树：走 UNC，按需展开（V23：51 项目录约 0.8s，可接受；不做全量预取）。
- @-mention 文件列表：WSL 工作区走发行版内 `rg --files`（V23：75ms vs UNC 1.4s）；探测无 rg 时退回 UNC 遍历并提示安装 rg。`rg` 的退出码必须单独采集，不能被管道末端的 `sed` 掩盖（§10 P1-13）。
- **运行期提示**：回收未确认与缺 rg 都进 `WslNotices`（`role="status"`），与 `actionError`（`role="alert"`）区分。提示的关闭按钮要带发行版/摘要的可访问名；live region 只包文本，不包按钮（§10 P2-3）。`rgMissing` 关闭后再次输入 `@` 会重新入队，需按「发行版 + 已提示」持久化或明确接受重复（§10 待决 D7）。
- 文案全部进 `src/i18n`；新增刷新入口与交互反馈按 `docs/ui-ux-spec.zh-CN.md` 登记，并在同一提交更新该文档。

### 5.10 边界守卫（A5）

新增 Rust 单测 `wsl_boundary_guard`：扫描 `src-tauri/src/**/*.rs`（剥掉注释与 `#[cfg(test)]` 模块），`wsl.exe` 字面量、`wsl.localhost`/`wsl$` 字符串只允许出现在 `engine/wsl_transport.rs`、`engine/wsl_path.rs`、`engine/wsl_probe.rs`，以及阶段 2 的 `terminal.rs`、`git_wsl.rs`。违例即红，并带自检单测（构造违例/合规文本）。

- 新增模块 `wsl_index.rs`、`wsl_availability.rs`、`wsl_notice.rs`、`history/wsl_sessions.rs` 目前不含这些字面量，因此不在允许列表里；它们只能经 `wsl_transport`/`wsl_probe` 的公开函数间接调用。这条约定要写进守卫注释，避免以后有人「顺手」在业务模块里拼 `wsl.exe`。
- 守卫只覆盖字面量，覆盖不到 `--exec`/`WSLENV`/`-d` 这类平台细节的散落。至少把 `--exec` 与 `WSLENV` 加入标记集合（允许列表同上），否则「平台细节收口」只做了一半。
- `tests/` 目录不扫描是合理的（测试需要构造违例文本），但要在注释里写明例外。

---

## 6. 分阶段计划

时间按 1 人全职估算，含单测，不含等待实机。

### 阶段 1：WSL 最小可用（约 8–10 个工作日）

| 步骤 | 内容 | 预估 | 验证 |
| --- | --- | --- | --- |
| 1.1 | `wsl_path.rs` + 单测（移植 synara 7 条，补 `\\?\UNC\`、正斜杠、中文目录、大小写）；修 `strip_verbatim_prefix` 两处 | 0.5 天 | `cargo test wsl_path`、现有 files/discovery 单测 |
| 1.2 | `WslBackend` 重构，现有字段迁入 `Ssh`，行为不变 | 1 天 | 现有 `wsl_transport` 单测、`cargo test --test send_path` |
| 1.3 | `Local` 的 `wrap`（启动器）/ `run_script_output`（`bash -s`）+ WSLENV 组装 | 1.5 天 | 单测断言 argv 精确值、`WSLENV` 内容、密钥不出现在 argv |
| 1.4 | `wsl_probe.rs`（`-ic` + 哨兵 + `/mnt/` 过滤 + 缓存 + 127 重探测）；SSH 后端换用同一探测脚本 | 1 天 | 单测：带 profile 噪声、`/mnt/c` 同名程序的输出解析 |
| 1.5 | 中断与回收（§5.7 第 1–3、6 条） | 1 天 | 实机：V13 场景停止后无残留 |
| 1.6 | `WslLaunchError` + i18n + `wsl_engine_availability` + 前端引擎过滤 | 1 天 | Vitest：WSL 工作区下引擎菜单不依赖本机探测 |
| 1.7 | `wsl_list_sessions` + 签名缓存 + 增量读头；回放改原始字节流 + 增量追加 | 2 天 | 单测：签名 diff、追加/截断判定；实机：446 会话列表耗时 |
| 1.8 | @-mention 走 `rg --files` | 0.5 天 | 实机：输入 `@` 后列表延迟 |
| 1.9 | 边界守卫单测 | 0.25 天 | `cargo test wsl_boundary_guard` |
| 1.10 | 按 §10 修复 P0/P1：回收参数顺序、设置写入死锁、引擎可用性回退、入口统一、错误分类、Codex 行与缓存清理 | 3–5 天 | §10.4 回归用例 + 实机停止/设置/探测 |
| 1.11 | 交付：整理为面向上游的 PR（问题、改动、§3 实测、§7 验证结果、限制），同时向「WSL 管理器」插件作者反馈探测缺陷（附 V4/V5） | 0.5 天 | PR 描述可被未参与讨论的评审者独立看懂 |

**实施状态（2026-10-22）**：1.1–1.9 已有代码（未提交），但以下验收项**当前会失败**：§7.2 第 4 条（停止后残留，P0-1）、设置页保存路径（P0-2 死锁）、探测中/失败时的引擎菜单（P1-1）、Web 访问端设置页（P1-2）。先完成 1.10 再谈阶段 1 验收。

**阶段 1 验收**：§1.1 六条全部按 §7.2 在 Windows 11 + WSL2 实机通过。

### 阶段 2：开发体验补齐（约 10–14 个工作日）

1. **Git**（4–6 天）：`git_wsl.rs`，status/diff/log/stage/commit 走 `wsl.exe --exec /bin/sh -c '<LAUNCHER>' … git -C <linux> …`，用 `--porcelain=v2 -z` 等机读格式；`git.rs` 入口按工作区分派。阶段 1 期间 git2 打开 UNC 失败（V24 推断为所有权校验）时显示"WSL 工作区 Git 面板将在后续版本支持"，不报错堆栈。
2. **终端**（1–2 天）：WSL 工作区的终端 = `wsl.exe -d <d> --cd <linux>`（交互登录 shell；终端场景 `--cd` 失败落到 `/` 可接受，但仍先检查 UNC `is_dir`）；`TERM`、UTF-8 locale 经 WSLENV 传入。需实测 ConPTY 下 resize 与中文输入。
3. **全文搜索**（1 天）：`files.rs::search_text` 走发行版内 `rg --json`。
4. **Own 传输放开**（3–4 天）：§5.6 阶段 2 列，codex app-server 优先（恢复 `request_user_input` 问答通道），再到 ACP 系；协议 cwd 转换单测移植 `AcpWslCwd.test.ts` 4 条。
5. **启动兜底回收**（0.5 天）：§5.7 第 4 条。

### 阶段 3：可选

Grok staging 写入发行版 `/tmp`；computer use / memory MCP 经 interop 调 Windows exe（先实测）；发行版内 `renice`（A8）。

---

## 7. 验证

### 7.1 自动化（任意平台可跑）

- `cargo test wsl_path`、`cargo test wsl_transport`、`cargo test wsl_probe`、`cargo test wsl_index`、`cargo test wsl_sessions`、`cargo test wsl_boundary_guard`
- `cargo test --test send_path`（SSH 与本机非 WSL 路径无回归）
- 新增回归（当前缺失，见 §10.4）：registry 的 `wsl_local` 参数顺序、`set_wsl_engine_path` 写入、`wrap` Local 的精确 argv（密钥不出现）、`run_script_output_local` 的 UTF-16 顺序、CLI 非零退出的错误码。
- `pnpm exec vitest run src/features/chat/components/use-wsl-engine-availability.test.tsx src/features/chat/wsl-sessions.test.ts src/features/settings/WslSection.test.tsx src/features/chat/components/WslNotices.test.tsx src/features/chat/store/wsl-notices.test.ts src/lib/errors.test.ts`
- `pnpm build`

### 7.2 实机验收（Windows 11 + WSL2，手工，约 40 分钟）

前置：发行版内装好 `claude`、`codex`，至少一个经 nvm 安装（覆盖 V4 场景）；Windows 侧不装，或装一个同名的（覆盖 `/mnt/` 过滤）。

1. 添加工作区 `\\wsl.localhost\<发行版>\home\<me>\repo`，再用 `\\wsl$\…` 添加同一目录 → 只有一行工作区，带发行版徽标。
2. Claude：发送"列出当前目录文件"→ 结果是 Linux 路径下的文件；追问一轮，会话续接。
3. Codex：同上两轮。
4. 让 agent 执行 `nohup sleep 600 &` 后点停止 → WSL 内 `ps -eo pid,sid,cmd | grep sleep` 在 3 秒内为空；pidfile 已删除；**不出现** `ExitUnproven` 通知（P0-1 的回归）。
5. 在 `~/.bashrc` 交互判断之前加一行 `echo hello` → 重复第 2 步，输出不受影响。
6. 临时改名 CLI → 发送，提示 `cliNotFound`；改回后点"重新检测"→ 恢复；**从设置页返回聊天后菜单立即恢复**（P1-1）。
7. 删除工作区目录后发送 → 提示 `cwdNotFound`，**CLI 没有在 `/` 下运行**。
8. `wsl --shutdown` 后直接发送 → 记录冷启动耗时；最终成功或给出 `startTimeout`。
9. 重启 GUI → 侧栏列出第 2、3 步的会话，可打开回放；再发一轮后重新打开，只增量拉取（看日志字节数）。
10. 在聊天框输入 `@` → 列表延迟 < 1s；`rg` 不可用时退回 UNC 并出现提示条。
11. 设置 → WSL：修改任一 CLI 路径覆盖并失焦 → 命令在 1s 内返回、无卡死（P0-2）；清空后恢复探测值。
12. 探测期间（刚打开工作区 2.4s 内）与 `wsl --shutdown` 后打开引擎菜单 → 发行版内已装的引擎仍然可见（P1-1）。
13. Web 访问端打开设置 → 不出现「WSL」分组；控制台没有 `unknown command: wsl_*`（P1-2）。
14. 插件登记一个路径形如 `\\wsl.localhost\…` 的远程工作区 → 徽标、引擎菜单、会话列表仍走 SSH，不被本机 WSL 接管（P1-3）。
15. 嵌套工作区 `/repo` 与 `/repo/sub` 各打开一次 → 同一 Codex 会话只出现在最长匹配的那个工作区（D6）。
16. 安装两个 GUI 实例（不同 profile）→ 启动后不互相回收对方的会话（P1-18）。
17. Pi：发送两轮并追问；模型菜单应来自发行版 `~/.pi/agent/models.json`（`pi models --json` 不支持时回退读配置）；会话结束后侧栏出现 Pi 行，可回放。
18. 记录：首个 token 延迟（对比 WSL 内直接跑 CLI）、会话列表耗时、回放耗时。

### 7.3 仍未验证（实施时补测）

| 项 | 原因 | 补测方法 / 退路 |
| --- | --- | --- |
| 原生 Windows GUI 进程下的 `wsl.exe` 延迟与编码 | 本次父进程经 interop 启动，继承了 `WSL_UTF8` 等变量 | 阶段 1 第一个 Windows 构建上复测 V15–V17；编码已有 UTF-16 兜底 |
| Rust `Command` 的参数转义与 node 一致 | 未编译 Windows 版 Rust 测试二进制 | 1.3 在 Windows CI/实机跑 V1 同款回显测试 |
| git2 打开 UNC 被所有权校验拒绝 | 只用 Windows git.exe 实测（V24） | 1.1 完成后在实机打开 Git 面板确认，结论只影响阶段 1 的降级文案 |
| 完整一轮对话（stdin prompt → stream-json） | 没有在实验中消耗用户账号额度 | §7.2 第 2、3 步 |
| ConPTY 承载 `wsl.exe` 交互 shell | 无 PTY 测试环境 | 阶段 2 终端步骤 |
| codex app-server / ACP 经 `wsl.exe` stdio | 阶段 2 才涉及 | 阶段 2 第 4 步 |
| Claude 转录本是否始终只追加 | 压缩（compact）可能重写文件 | §5.5 用「尾部 4 KB 窗口 + size/mtime」判定；mtime 变化或窗口不一致即全量重取。窗口比对不能发现「中间被改写但末尾相同」，如需更强保证再加周期性全量校验 |
| WSL1 发行版 | 全部实验在 WSL2 上完成 | 未支持前显式拒绝并给出 i18n（D7）；WSL1 无真实内核会话，回收与 UNC 语义都不同 |
| 共享 `\\wsl.localhost` 的多用户同机场景 | 未搭建 | pidfile 属主/starttime 校验（§5.7）；同发行版多用户共享 `/tmp` 的威胁模型需在评审确认 |

---

## 8. 关键取舍

1. **复用 `WslTransport` 而不是新建模块**：三条链路已收口，新建模块要在每条链路加分支，两套规则会漂移。
2. **UNC 做工作区标识，但只用于标识与文件树**：系统文件选择器直接返回 UNC，无需插件；凡是批量文件操作（扫描、搜索、Git）一律回到发行版内执行（V19、V23、V24）。
3. **启动器代替 `--cd`/裸命令**：只为两条实测缺陷（V2、V6）付出一个固定 5 行的 sh 常量，换来稳定的退出码与 pidfile。
4. **密钥走 WSLENV**：V9 证明特殊字符与隔离性都可靠；磁盘上不留任何会话相关内容。
5. **历史走发行版内扫描 + 增量**：UNC 实测慢两个数量级（V19 vs V20）。
6. **主仓库原生实现，不做成插件**：执行层只能在主仓库；UNC 键让主仓库现有的文件树、@-mention、Git、终端直接可用。详见 §8.1。

### 8.1 为什么不做成插件

**插件能力边界**（`plugin_caps.rs:611-775`）：插件能拉起进程的入口只有 `plugin_exec_run`（stdin 固定为 null，stdout/stderr 各截断到 64KB，最长 300s）、`plugin_exec_spawn`（不返回输出）、`plugin_exec_kill`。插件拿不到流式 stdout，也无法接管 `send_message`；终端、Git、@-mention、全文搜索、app-server 协议 cwd 也没有对应扩展点。引擎对话需要往 stdin 写 prompt、持续读取 NDJSON，因此发送、中断、Linux 侧回收只能在主仓库实现。

**「WSL 管理器」插件现状**（v0.4.6，2026-09-15，MIT）：

| 事实 | 依据 | 对本方案的含义 |
| --- | --- | --- |
| 插件依赖作者向主仓库提交的三处宿主适配：`workspaces.add` 带 meta、`selectSession`、`engine/wsl_transport.rs` | 插件 README「宿主配套」 | 这个插件本来就是"插件管入口、主仓库管执行"，不存在纯插件先例 |
| 本机只做诊断（`wsl.exe -l -v`、设默认）；添加工作区必须先选远程主机，meta 必填 `host/port/user` | `src/wsl.ts`、`src/AddWorkspacePop.tsx`、`src/store.ts` | 不支持本机工作区；现有 `from_workspace_meta` 缺 `host` 即返回 None，扩展它同样要改主仓库 |
| 工作区键是发行版内 Linux 路径（`~/proj`），客户端上不存在 | `src/store.ts` `WslWorkspaceMeta.workspace` | 主仓库自带的文件树、@-mention、Git、终端用不了，插件只能自建只读文件面板 |
| 会话列表经 `exec` 跑脚本，取最近 30 条 | `src/wsl.ts` `listRemoteSessions` | 受 64KB 截断约束；本机 446 个会话的列表输出实测 61,248 字节（V20），已接近上限 |
| 引擎探测只 source `~/.profile` 并补 `~/.local/bin` | `src/wsl.ts` `engineProbeScript` | nvm 写在 `.bashrc` 时找不到 claude（与 V4 同一根因） |

**三种做法对比**：

| | A 主仓库原生（采用） | B' 给插件加本机模式 | C 纯插件（Windows 本机 OpenSSH 回环） |
| --- | --- | --- | --- |
| 主仓库执行层 | 改 | 也要改 | 不改 |
| 文件树 / @-mention / Git / 终端 | 主仓库现有功能作用于 UNC | 不可用，依赖插件只读面板 | 同 B' |
| 会话列表 | 主仓库实现，可增量 | 受 64KB 与 30 条限制 | 同 B' |
| 授权 | 无需（本机不出站） | 需要 `host:workspace:remote` | 同 B' |
| 维护面 | 仅主仓库，可提交上游 | 主仓库 + 第三方插件 | 插件，但功能缺失：远端脚本以非登录 shell `exec`，PATH 无 nvm，codex（node 脚本）启动失败（V3、V14）；codex app-server、grok 仍被拒；需额外开启本机 sshd |

**结论与分工**：

1. 主仓库按 §5 原生实现本机 WSL，作为上游已有 WSL 通道的 `Local` 后端，按插件作者当初的方式以 PR 提交上游（§6 步骤 1.11）。
2. 「WSL 管理器」插件保持负责远程场景，两者共存，规则见 §5.2 判定顺序与 §5.9 钩子共存。
3. 可选的插件侧后续（不在本方案范围，向插件作者提议）：增加"添加本机发行版目录"入口，只需 `ctx.workspaces.add('\\\\wsl.localhost\\<发行版>\\<路径>')`，不带 meta，仅需 `host:workspace` 权限，其余交给主仓库。
4. 向插件作者反馈探测缺陷：改用 `bash -ic` + 哨兵行 + `/mnt/` 过滤（同 §5.4），附 V4/V5 实测。

---

## 9. 场景外借鉴项（不进入本方案，单独立项）

| 优先级 | 项 | synara 位置 | 价值 |
| --- | --- | --- | --- |
| 中 | 事件先落盘后发布 + 游标续传 | `provider_runtime_events`、`wsSnapshotLiveStream.ts:85` | 断线/切会话不丢事件 |
| 中 | 发送模式 `queue \| steer` | `packages/contracts/src/orchestration.ts:512` | 运行中追加指令 |
| 低 | ThreadGoal 自动续跑、线程 Recap | `orchestration.ts` | 长任务体验 |
| 低 | Agent Gateway、Tasks/Kanban、Hubs | `apps/server/src/agentGateway/` | 产品级，投入大 |
| 工程 | CI 分层 + fail-closed 聚合 | `scripts/` | 本方案 §5.10 先落一个守卫 |

主项目自身技术债（与本方案无依赖）：`web/dispatch.rs` 约 136 个手写分支与 224 个 Tauri 命令无一致性校验；`src/lib/ipc.ts` 1969 行手工镜像 Rust 类型；`vite.config.ts:10-21` 遗留 dbg-beacon 中间件；无 rustfmt/clippy/eslint 配置；`tests/*.test.ts` 未进 CI。

---

## 10. 实施核对与评审结论（2026-10-22）

> 本节表格记录评审时的**原始发现**；同日已完成一轮修复，逐项状态见 §10.8。
> 表中「当前实现」描述的是修复前状态，不作为现状依据。

### 10.1 核对范围与方法

对阶段 1 已落地的代码做了三路只读走查（传输/探测、历史/数据、前端），并对下列高危结论逐条回源码复核：回收参数顺序、设置写入锁、UTF-16 解码顺序、`rg` 管道退出码、远程会话路径白名单、新增入口是否绕过 `meta.wsl`、Web dispatch 是否覆盖、引擎可用性回退。**本节结论来自源码走查，未运行构建或实机验收**；凡标「当前」的均为工作区代码状态。

总体结论：主链路设计成立（传输收口、UNC 标识、启动器、会话行复用都按预期落地），但**当前不能进入阶段 1 验收**：

- 2 个 P0 会稳定复现：P0-1 违背 §1.1 第 3 条，P0-2 让设置页保存直接卡死。
- P1 集中在五类问题：引擎可用性、Web/插件共存、入口判定一致性、授权边界、错误语义与数据生命周期；其中前四类决定核心承诺是否成立，提交上游前必须处理。
- 设计文档原稿与实现已有系统性偏差，§5 已按实现更正；仍未决的取舍集中在 §10.6。

### 10.2 P0（阻塞验收，先修）

| ID | 问题 | 证据 | 触发与后果 | 修复方向 |
| --- | --- | --- | --- | --- |
| P0-1 | 停止/关窗时 Linux 会话回收的元组顺序颠倒 | 生产 `wsl_transport.rs:784` 写 `(run_id, distro)`；消费 `registry.rs:55,459,517,542` 按 `(distro, run_id)` 解构后调 `kill_local_run(distro, run_id)` | 任何本机 WSL 回合点停止：`wsl.exe -d <run_id>` 必然失败，`nohup` 进程存活，同时误报 `ExitUnproven`。直接违反 §1.1 第 3 条。现有 registry 测试全部用 `wsl_local: None`，故未发现 | 改为命名结构体 `WslRun { distro, run_id }`（或统一元组顺序并在两侧写死契约）；补 registry 单测：注入 `Some` 后断言传给 `kill_local_run` 的参数 |
| P0-2 | 设置写入自锁，命令永不返回 | `settings.rs:474,482` 先取 `settings_write_lock()`，随后 `:479,487` 调 `persist_settings`；后者在 `:944` 再取同一把 `parking_lot::Mutex`（不可重入） | 设置页任一 CLI 路径覆盖失焦保存或清空删除 → 同步 Tauri command 永久阻塞，页面无响应 | 持锁后改调 `persist_settings_committed`（其注释明确要求调用方已持锁）；补写入/删除单测，避免依赖 Tauri State |

### 10.3 P1（功能、安全与数据一致性）

| ID | 问题 | 证据 | 触发与后果 | 修复方向 |
| --- | --- | --- | --- | --- |
| P1-1 | 引擎可用性在探测中/失败时回落本机探针，且设置变更后不刷新 | `use-wsl-engine-availability.ts:28-44` 返回 `null`；`engine-options.ts:22-26` 对 `null` 按本机 `available` 过滤；Hook 依赖只有 `[isWsl, workspacePath]` | Windows 未装 CLI、发行版内已装时：探测的 2.4–30s 内和失败后引擎被隐藏，违反 §1.1 第 2 条；设置页「重新检测」后回到聊天菜单仍是旧结果 | 探测中保留上次结果或标记「未知」；失败返回全部已注册引擎；设置保存/重检测后递增全局版本或发事件让 Hook 重取 |
| P1-2 | Web 模式暴露 WSL 功能且 IPC 不存在 | 7 个命令只注册在 `lib.rs:464-469,504`，`web/dispatch.rs` 无 `wsl_` 分支；`sections.tsx:268-280` 无条件注册；`WslSection` 无 `isWeb` 判断；`typeof ipc.wslXxx` 恒为函数（`ipc.ts:1583-1605`） | Web 访问端看到「WSL」设置页，挂载即报 `unknown command: wsl_distros`；`wsl-sessions.ts:44` 的 guard 永远不生效 | 设置分组与相关入口在 `isWeb`/非 Windows 下隐藏；前端用 `isWeb` 判断；阶段 1 不把 `wsl_*` 加入 web dispatch（若将来加入，必须先做 P1-4） |
| P1-3 | 新入口绕过 `meta.wsl` 判定，前端只按路径判断 | `wsl_sessions.rs:426`、`wsl_availability.rs:18`、`files.rs:638-646` 直接 `parse_wsl_unc`；前端 `ChatConversation.tsx:489` 只看路径 | 「UNC + meta.wsl」工作区：发送/回放走 SSH，列表/索引/引擎菜单走本机，同一工作区两种数据源；插件登记的 UNC 路径远程工作区会被本机接管 | 后端所有入口先查 `meta.wsl`（复用 `transport_for_workspace` 或拆出 `workspace_exec_kind`）；前端判定同时看 `workspace.meta.wsl` |
| P1-4 | 会话回放/删除没有工作区授权边界 | `reader.rs:631-655` 只校验「绝对 `.jsonl` + 含 `/projects/` 或 `/sessions/` + 无 `..`」；`reader.rs:820-841,1186-1207` 直接使用调用方给的 `remotePath` | 任何能发 IPC 的上下文（插件、受损前端、未来 Web 端）可读取/删除该发行版内任意满足形状的转录本，不限于已登记工作区 | 用探测到的引擎 home + 工作区推导允许目录；或让 `wsl_list_sessions` 签发不透明句柄，回放/删除只接受句柄 |
| P1-5 | 错误语义混淆：CLI 自身非零退出被报成「WSL 探测失败」 | `reader.rs:1263-1288` 对非 61/126/127 调 `classify_launch_failure`；`wsl_transport.rs:865-881` 一律返回 `WSL_PROBE_FAILED`；`verify_local_cli` 的 126/127 分支不可达（`exec_local_exit` 非零即 `Err`，`wsl_transport.rs:1183-1200`）；回放只从 stderr 取错误（`:1119-1123`）；stderr 未脱敏（`reader.rs:1270-1284`） | 认证失败、限流、参数错误（CLI 退出 1）显示为「发行版探测失败：…」，误导排障；CLI 被删时显示 `WSL_SHORT_CALL_FAILED` 而非 `WSL_CLI_NOT_FOUND`；旧版 WSL 的 stdout 错误码识别不到 | 只有出现已知 WSL 标记或 61/126/127 才翻译；其余保留引擎错误并脱敏；回放同时采集 stdout；让预检错误码可达 |
| P1-6 | `run_script_output` 先剥噪声再解码 UTF-16，兜底失效 | `wsl_transport.rs:1025-1033` 先 `strip_transport_noise`（内部 lossy + 删 NUL，`:1342-1353`），再 `decode_wsl_output`（靠 NUL 判定 UTF-16） | 旧版 WSL（不认 `WSL_UTF8`）下含中文的 `find`/列表输出乱码；`exec_local_exit` 的顺序是对的，说明分派路径不一致 | 统一「先 `decode_wsl_output` 再剥噪声」；单测覆盖 UTF-16LE + 中文 |
| P1-7 | 回收语义不闭环 | `kill_run_script` 缺失 pidfile 直接 `exit 0`、`pkill` 退出码被忽略（`wsl_transport.rs:84-98`）；正常结束删 pidfile（`reader.rs:1310-1329`）导致 `nohup` 进程失去句柄；启动兜底只发 TERM 就删文件（`:1298-1306`）；退出流程 `runtime.spawn` 不等待（`registry.rs:556-572`、`lib.rs:363`）；「3s」预算小于脚本 `sleep 2` + 冷启动 | 回收失败被当成成功；关闭 GUI 后 dev server 残留；退出时回收任务可能根本没跑 | 按 §5.7 重写：pidfile 保留到应用退出、starttime 校验、退出码语义、退出等待与预算 |
| P1-8 | 读头失败时所有 Codex 行消失 | `wsl_sessions.rs:225-258` 先用空 cwd 过滤，`heads_script` 成功后才回填；失败只打日志（`:454-476`） | 首次扫描超时/读头失败 → 该工作区 Codex 会话全部从侧栏消失，用户以为会话丢了 | 先按缓存归属保留行；读头失败沿用旧标题或占位，不整行丢弃 |
| P1-9 | 首次扫描读取其它工作区的 Codex 头部并写入 db | `wsl_sessions.rs:448-452` 的 `changed` 基于全部 `files`，未先按工作区过滤；Codex 会话目录是全局的 | 会话多时输出过大、30s 超时；把无关工作区的标题/cwd 写入本机缓存（隐私与写放大） | 先用 db/内存缓存的归属过滤，再对「本工作区或归属未知」的文件读头 |
| P1-10 | 缓存无界增长、删除/移除工作区不清理 | db `wsl_session_cache` 只 upsert（`wsl_sessions.rs:380-408`）；进程内 `HeadCache` 无淘汰；前端 `cached` 在移除工作区时不清理（`workspaces.ts:84-115`）；`remote-sessions/*.jsonl` 删除失败/移除工作区不清理（`reader.rs:674-687,1204-1206`）；通知队列按 runId 累积（`sessions.ts:75-90`） | 长期使用后 db、内存、磁盘持续增长；重新登记同一工作区先看到旧缓存 | 删除会话/移除工作区时同步清 db、内存、前端缓存与回放文件；给 db 表加按发行版/时间的清理与条数上限 |
| P1-11 | 跨源去重缺失，嵌套工作区产生重复行 | `session-utils.ts:47-56` 只把本地会话放进 `seen`，外部数组内部不去重；`sessions.ts:204-218` 直接 `[...external, ...wslMetas]`；行 id 为 `engine/sessionId`（`use-chat-sidebar.ts:155`）；Codex 归属用前缀匹配（`wsl_sessions.rs:185-192`） | 插件源与宿主源上报同一会话时出两行；父/子工作区各出一行同 id，React key 冲突；删除一条会连带删除所有同 id 行 | 合并前按 `(engine, sessionId, workspacePath)` 去重；Codex 归属改为最长前缀唯一归属（D6） |
| P1-12 | 初始化等待 WSL 扫描，最长 30s；后台扫描不通知 UI | `sessions.ts:204-208` 在 `set` 前 await `listWslSessionMetas`；`wsl-sessions.ts:50-87` 缓存命中仍每轮后台扫，结果不回写 store；无 TTL/节流/失败负缓存 | 发行版冷启动或卡死时侧栏空数十秒，违反「后台探测、不阻塞 UI」；新结束的会话要等下一次事件才出现 | `init` 先用本地数据渲染，WSL 行异步合并并触发 store 更新；给扫描加 TTL/节流与失败负缓存 |
| P1-13 | `rg --files` 的退出码被 `sed` 掩盖 | `wsl_index.rs:41-44` 管道后 `rc=$?` 取的是 `sed` 的退出码 | `rg` 中途失败（权限、坏仓库）返回部分列表且当成功，`@` 列表静默缺文件 | 先写临时文件再 sed，或启用 `pipefail`/读 `${PIPESTATUS[0]}` |
| P1-14 | Local 分支仍携带 Windows PATH；`CODEX_HOME` 可能透传 Windows 路径 | `mod.rs:1236` 在 wrap 后无条件设置 `cli_search_path()`；`codex_read_only.rs:132` 设置本机 `CODEX_HOME`，`wsl_transport.rs:836-847` 经 WSLENV 透传 | WSL 会把 `/mnt/c/...` 追加进 Linux PATH，探测缓存未就绪的短调用可能解析到 Windows 同名程序（V4 根因）；codex 收到 Windows 路径 | Local 分支显式移除 Windows PATH；对 Windows 专有路径键设黑名单，只允许探测到的发行版值 |
| P1-15 | SSH 远程 WSL 行为被改变且未登记 | `mod.rs:527-541` 对 `wsl=true` 只保留 `/` 开头目录（此前 Windows 绝对路径会被塞进 `--add-dir`）；`wsl_transport.rs:578-597` 的 `-ic` 探测无超时 | 与 §1.1 第 6 条「SSH 行为不变」冲突；`.bashrc` 阻塞时 SSH 发送挂起 | 确认 `additional_dirs` 变化是有意修复并写入 §1.2/§7；探测加超时 |
| P1-16 | 模型目录不保证探测完成，合法覆盖路径被 `shell_safe_bin` 丢弃 | `models/mod.rs:166-190` 未 `ensure_local_probe`；`models/wsl.rs:105-111,144-153` 字符白名单拒绝空格/中文 | 冷缓存时模型菜单为空；设置里能保存的路径在模型目录侧静默失效 | 模型目录先 `ensure` 探测；覆盖路径的校验与消费规则统一（D9） |
| P1-17 | 探测无 single-flight/负缓存，每次发送多一次 0.7s 预检 | `wsl_probe.rs:241-255`；`mod.rs:1095-1102` | 并发调用重复跑 2.4s 交互 shell；每个回合首 token 固定 +0.7s | 同发行版 single-flight；失败短 TTL；预检合并进探测或按 TTL 跳过 |
| P1-18 | 多实例互相误杀，sid 复用无防护 | 启动兜底扫全部 `ccgui-run-*.pid`（`wsl_transport.rs:1298-1306`）；pidfile 只有 run id；回收不校验 leader starttime | 两个 GUI 实例（不同 profile）后启动者 TERM 前者会话；sid 被复用时可能误杀无关进程 | 按 §5.7：instance 命名空间 + starttime 校验 |
| P1-19 | 大文件处理与失败清理 | `window_matches` 整文件 `std::fs::read`（`reader.rs:799-803`）；512 MiB 仍整份解析；全量拉取失败留半文件（`wsl_transport.rs:1091-1098`） | 93 MB 会话每次打开整块读；大文件 OOM 风险；失败后磁盘留下不完整缓存 | 只读尾部 4 KB；解析改为流式或降低上限；失败时截回/删除 |
| P1-20 | 设置页每次挂载清空全部缓存并重探测；`wsl_reprobe` 串行 N×30s | `WslSection.tsx:45-49` 挂载即 `wsl_reprobe()`；`wsl_availability.rs:75-101` 串行 | 打开设置页导致其它页面探测缓存失效；多发行版时「重新检测」可能长时间无响应 | 挂载只读当前结果；重检测并行或按发行版；保存覆盖后只重探该发行版 |

### 10.4 回归用例（修复时同批补）

1. `registry`：构造 `ChildEntry { wsl_local: Some(...) }`，断言 `kill_local_run` 收到 `(distro, run_id)` 的正确顺序（P0-1）。
2. `settings`：`set_wsl_engine_path` 新增/删除各一次，断言返回、文件内容与锁释放（P0-2）。
3. `wrap` Local：注入可替换的启动器写入函数，断言完整 argv 顺序、`run_id` 作为 `$1`、密钥只出现在 env 不在 argv、`skip_local_cwd`（§6 1.3 的原始验收项）。
4. `run_script_output_local`：UTF-16LE + 中文输出，断言解码正确（P1-6）。
5. `reader`：CLI 退出码 1 保留引擎原始错误，不被改写成 `WSL_PROBE_FAILED`（P1-5）。
6. `wsl_sessions`：读头失败时 Codex 行保留（P1-8）；嵌套工作区唯一归属（D6）；子代理文件被排除（P2-5）。
7. `wsl-sessions.ts`：缓存命中、`inFlight` 合并、失败返回旧值、`forgetWslWorkspace` 与在途扫描的竞态（P1-11/P1-12）。
8. `use-wsl-engine-availability`：探测中/失败不隐藏引擎、设置变更后重取（P1-1）。
9. `WslSection`：保存失败 `role="alert"`、空串删除、未改动不写、挂载不触发全量重探（P0-2/P1-20）。
10. `add_workspace`：`\\wsl$` 与 `\\wsl.localhost` 同一目录只登记一行（DB 集成）。
11. db 迁移：已有库升级后 `wsl_session_cache` 存在且可用。
12. Web：设置页不渲染 WSL 分组，且不发出 `wsl_*` 调用（P1-2）。

### 10.5 P2（质量、体验与文档）

| ID | 问题 | 证据 | 影响 |
| --- | --- | --- | --- |
| P2-1 | `is_safe_distro` 接受 `.` / `..` / 纯空格 | `wsl_path.rs:26-31` | `to_wsl_unc` 可拼出带 `..` 的 UNC 用于写/删；需显式拒绝 |
| P2-2 | 未识别的 `WSL_*` 无通用回落；`WSL_EXIT_UNPROVEN`/`WSL_RG_MISSING` 未映射 | `errors.ts:10-67`；两者当前只进通知/日志 | 未来经错误通道透出时用户看到裸英文码，违反 §1.1 第 4 条 |
| P2-3 | 提示条可达性：关闭按钮同名、`role="status"` 包裹按钮、设置页错误未与输入框关联 | `WslNotices.tsx:29-52`；`WslSection.tsx:130-136` | 读屏无法区分关闭哪条；错误在视口外时不可感知 |
| P2-4 | `builtin-search` 的 WSL 用例是错误分支的假通过 | `builtin-search.test.tsx:30-36` 的 mock 让 `WslSection` 抛错 | 断言只覆盖「重新检测」锚点，动态覆盖行没有验证 |
| P2-5 | Codex 子代理 rollout 未过滤 | `wsl_sessions.rs:52-54` 直接 `find`；本地扫描器有 `is_codex_subagent_file` | 子代理转录本被当成独立会话，删除可能误删 |
| P2-6 | 发行版列表失败被吞成空表，无法区分未安装/无发行版/读取失败 | `wsl_probe.rs:352-384`；`wsl_availability.rs:53-55` | 设置页文案误导，排障困难 |
| P2-7 | `dirs_for` 是死代码，`CLAUDE_CONFIG_DIR` 未进探测与短调用 | `wsl_sessions.rs:294-310,436`；`wsl_probe.rs:117-131` | 自定义 Claude 配置目录时历史与 CLI 不一致 |
| P2-8 | 缓存持久化/删除/清理大量 `let _` 吞错 | `wsl_sessions.rs:390-407,475-476`；`reader.rs:1204-1206`；`wsl_transport.rs:1225-1232` | 失败不可见，问题只能靠「数据不对」发现 |
| P2-9 | 设置页 `onSaved` 触发全量重探且吞错，成功时清掉其它错误 | `WslSection.tsx:184,250` | 保存后探测失败无反馈；列表错误被误清 |
| P2-10 | ui-ux 变更记录版本/日期顺序不自洽（v0.87 2026-10-19 排在 v0.86 2026-10-21 之上） | `docs/ui-ux-spec.zh-CN.md:302-305` | 读者无法按版本或日期任一维度顺序阅读；需定一条排序规则 |
| P2-11 | `wsl.exe` 路径取自 `%SystemRoot%` 环境变量再拼接 | `wsl_probe.rs:258-267` | 以被篡改的环境启动应用时可指向非系统 `wsl.exe`；常规风险，但应在威胁模型里写明「不信任父进程环境」的边界 |

### 10.6 待决问题（需要拍板）

| ID | 问题 | 建议 | 理由 |
| --- | --- | --- | --- |
| D1 | 正常 turn 结束后 pidfile 是否保留 | **保留到应用退出** | 否则 `nohup` 拉起的进程在关闭 GUI 时无档案可回收，与 §1.1 第 3 条冲突；启动清扫处理崩溃残留 |
| D2 | `meta.wsl` 存在但字段非法时的行为 | **fail-closed 报错** | 「显式意图优先」要求不能悄悄回退到本机 WSL；否则插件配置写错会连到错误的执行层 |
| D3 | Web 访问端是否支持本机 WSL | **阶段 1 不支持，隐藏入口** | 需要先有 P1-4 的授权边界；否则 token 持有者可读写宿主发行版文件 |
| D4 | 引擎探测中/失败时的菜单 | **探测中保留上次结果，失败列出全部已注册引擎** | 唯一满足「Windows 侧可不装 CLI」的语义；「未知」不能等价于「不可用」 |
| D5 | Claude 是否也读头部 cwd 复核归属 | **读**（与 Codex 一致） | 目录编码存在 `_`/`-` 碰撞，只靠目录名会串工作区；代价是首次多读一批头 |
| D6 | 嵌套工作区归属 | **最长前缀唯一归属** | 避免同 id 两行、React key 冲突与误删；规则简单可测 |
| D7 | WSL1 发行版 | **显式拒绝并给 i18n** | 实验只在 WSL2 完成，WSL1 的会话/回收语义不同，静默按 WSL2 处理会制造更难查的问题 |
| D8 | `rgMissing` 关闭后是否允许再次提示 | **按「发行版 + 会话生命周期」只提示一次** | 否则每次 `@` + 刷新都重新出现，与 ui-ux 规范「关闭后不重复刷」冲突 |
| D9 | CLI 覆盖路径的字符规则 | **统一为「绝对路径 + 非 `/mnt/` + 无控制字符」，并让 `shell_safe_bin` 接受同样的路径（argv 场景不需要 shell 白名单）** | 否则设置能保存、发送能跑、模型目录却静默失效 |

### 10.7 结论

- 设计层面：§5 已按实施结果修订，阶段 1 的边界、启动器、回收、错误码、会话与缓存规则现在都有明确契约。
- 实施层面：**P0-1、P0-2 必须先修**，否则 §7.2 第 4 条与设置页保存无法通过；P1-1/P1-2/P1-3 决定「Windows 不装 CLI」与「插件共存」两条核心承诺是否成立。
- 提交上游前：完成 §10.4 的 12 组回归，并按 §10.6 的 D1–D9 落一条明确规则；不要把「待决」状态带进 PR。

### 10.8 修复状态（2026-10-22）

本轮按 §10 完成以下改动（工作区未提交）：

**P0（2/2）**

- P0-1：`Wrapped.local_run` / `ChildEntry.wsl_local` 改为具名字段 `WslRun { distro, run_id }`，生产者与消费者不再可能写反；registry 三处解构同步。
- P0-2：`set_wsl_engine_path` 抽出 `set_wsl_engine_path_at`，持锁后调用 `persist_settings_locked`（不再二次进 `persist_settings`）；新增写入/删除/非法路径回归测试。

**P1（20/20）**

- P1-1：`filterEngineOptions` 增加 `delegated`；WSL 探测中/失败时不再回落本机探针。设置页保存/重检测通过 `invalidateWslEngineAvailability()` 让聊天页重取。
- P1-2：WSL 设置页与搜索项只在桌面 Windows 注册；前端 guard 改用 `isWeb`。
- P1-3：`wsl_list_sessions`、`wsl_engine_availability`、文件索引与前端判定都先尊重 `meta.wsl`；非法 meta fail-closed。
- P1-4：本机 WSL 回放/删除增加 `${CLAUDE_CONFIG_DIR:-~/.claude}/projects` 与 `${CODEX_HOME:-~/.codex}/sessions` 根校验。
- P1-5：只有已知 WSL 标记或 61/126/127 才翻译成 `WSL_*`；CLI 自身非零退出保留原文；预检改为哨兵输出（126/127 分支可达）；回放失败读回 stdout 分类。
- P1-6：`run_script_output_local` 改为先解码 UTF-16 再剥噪声。
- P1-7：pidfile 保留到应用退出；启动/退出清扫带 starttime 校验、`pkill` 退出码语义；退出流程 `block_on` 等待 5s。
- P1-8：签名变化时沿用缓存 cwd，读头失败不再让 Codex 行整批消失。
- P1-9：已知归属其它工作区的文件不再读头。
- P1-10：删除会话清 db/内存/前端/回放缓存；移除工作区使前端缓存与在途扫描失效；db 表按发行版保留最近 5000 条；后台补扫加 15s 节流。
- P1-11：外部源按 `(engine, sessionId, workspacePath)` 去重；嵌套工作区最长前缀唯一归属。
- P1-12：`init` 对 WSL 扫描最多等 2s，迟到结果异步并入；WSL 标签不再因首屏未拿到行而被丢弃。
- P1-13：`list_script` 启用 `pipefail`，不再用 `sed` 的退出码冒充 `rg`。
- P1-14：Local 分支不设置 Windows PATH；`PATH/CODEX_HOME/CLAUDE_CONFIG_DIR/WSLENV/WSL_UTF8` 不再从宿主环境透传；WSLENV 去重并保留用户标志。
- P1-15：SSH 的 `-ic` 探测加 `timeout 30`；`additional_dirs` 行为变化本次未改，记为有意修复并在 §1.2 保留说明。
- P1-16：模型目录先 `ensure` 探测；本机覆盖路径改用 `sh_quote`，与设置页校验一致。
- P1-17：探测按发行版 single-flight；失败结果 10s 负缓存；刚探测过的路径跳过发送前预检。
- P1-18：pidfile/启动器带实例命名空间；回收前校验会话组长 starttime，防 sid 复用误杀。
- P1-19：`window_matches` 改为 seek 只读尾部 4 KB；全量拉取失败删除半文件。
- P1-20：新增 `wsl_probe_snapshot`（挂载只读、不失效缓存）；`wsl_reprobe` 并行探测；保存单个覆盖只重探该发行版。

**Pi 支持（本轮新增）**

- 探测表加入 `pi`，并采集 `$PI_CODING_AGENT_DIR`；可用引擎菜单只列本机 WSL 真正能跑的 Child 引擎（claude/codex/kimi/minimax/pi），grok/omp 即使装着也不出现。
- `build_command` 生成的 `--extension <Windows 路径>` 在 `wrap` 的 Local 分支经 UNC 暂存到发行版 `/tmp/ccgui-pi-<instance>/`，argv 改为 Linux 路径；ask bridge 因此在 WSL 里也能注册 `ask_user`。
- 会话发现加入 `${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/sessions`，id 取 `<timestamp>_<uuid>.jsonl` 的 UUID 段，归属按头部 cwd 复核；回放/删除的根校验同步加入 pi。
- 模型目录：`pi models --json` 为空时回退读取发行版内的 `models.json`（与本机 `configured_models` 同一解析）。
- 设置页覆盖位加入 pi（探测不到也可手工指定）。
- 退出清扫另有回归：窗口关闭后无 reactor panic（`exit_reclaim_builds_its_own_reactor`）。实机验证：在本机 WSL（pi 1.4.0）用真实启动器跑通 `--mode rpc` + ask bridge，`get_state` 返回模型/会话，系统提示里出现桥接的 `ask_user` 工具；启动器写入 `sid + starttime`，回收脚本 `kill_rc=0` 且无残留 `sleep 600`，启动兜底同样清零。这次实机测试还发现并修正了 pidfile「一行两字段、脚本按两行读」的 bug。

**P2（10/11）**

- 已修：P2-1（拒绝 `.`/`..`）、P2-2（未知 `WSL_*` 通用回落 + EXIT_UNPROVEN/RG_MISSING 文案）、P2-3 的 live region 与关闭可访问名、P2-4（搜索测试补 IPC mock）、P2-5（Codex 子代理剔除）、P2-6（发行版列表错误可区分）、P2-7（采集 `CLAUDE_CONFIG_DIR`、删除死代码）、P2-8（缓存写入/提交/删除失败日志）、P2-9（保存后单发行版重探失败上屏）、P2-10（ui-ux 变更记录补充排序规则）。
- 未完成：P2-3 的设置页输入框 `aria-invalid`/`aria-describedby` 关联。

**D1–D9 决策**

- D1 pidfile 保留到应用退出；D2 非法 meta fail-closed；D3 Web 端隐藏；D4 探测中/失败不隐藏引擎；D5 Claude 读头后按 cwd 复核；D6 嵌套工作区最长前缀；D7 通过 `/proc/sys/kernel/osrelease` 识别并对 WSL1 显式报错；D8 rg 提示每次应用运行只发一次；D9 本机覆盖路径统一为 `sh_quote`。均已落地。

**仍待处理（明确不在本轮范围）**

- P1-10 的 `remote-sessions/` 回放文件在“移除工作区”时仍不清理（删除会话时会清）。
- D5 已按 Claude 头部 cwd 复核归属，但编码碰撞的**历史行**要等下一次读头后才被过滤。

**验证（2026-10-22 实际结果）**

- `cargo check --tests` 通过（Windows 工具链）。
- Rust WSL 相关：`cargo test --lib wsl` → **85 passed / 0 failed**；`engine::models::pi` → **5 passed**；`engine::models::wsl` → **4 passed**；`set_wsl_engine_path` 死锁回归 → **1 passed**；`cargo test --test wsl_boundary_guard` → **2 passed**。
- 前端 vitest：`engine-options`、`WslNotices`、`wsl-notices`、`errors`、`WslSection`、`builtin-search`、`use-chat-sidebar`、`wsl-path` 与 `session-utils-merge`、`plugin-run-workspace` 共 **11 个文件 / 80 个用例通过**；pi 改动后又复跑 `WslSection`/`engine-options`/`use-chat-sidebar` → **29 passed**。
- `pnpm build`（`tsc --noEmit` + `vite build`）通过。
- 全量 `cargo test --lib`：**1054 passed / 7 failed**，失败全部在 `git_worktree::tests::*`，原因是本机测试仓库默认分支为 `main`、用例写死 `master`，与本次改动无关。
- `cargo test --test send_path`：**4 failed**，均卡在 IPC 层 `send_message not allowed. Plugin not found`（Tauri ACL/测试环境），未进入被改动的发送代码；需要在能正常跑该用例的环境里复验。
- **未做**：实机 §7.2 验收（停止回收、插件共存、多实例、Web 访问端）；这些路径的最终结论仍以实机为准。

---

## 11. WSL 侧 CLI 管理方案（2026-10-23）

### 11.1 现象与根因

设置 → CLI 管理的每个页签由 `CliConfigSection` / `useCliConfig` 驱动，数据源是**主机作用域**：

- 渠道、当前渠道、启停来自应用自己的 `config::read_config()`（`~/.ccgui-next/config.json`）；
- 自定义路径、自定义配置目录、自定义模型来自主机 `AppSettings`；
- 官方配置编辑器 `provider_files::official_config_read/write` 直接读写 Windows 的 `~/.claude/settings.json`、`~/.codex/{config.toml,auth.json}`、`~/.kimi-code/config.toml`、`~/.grok/config.toml`；
- Pi/omp 认证区块 `PiFamilyAuthSection` 读写主机 `~/.pi/agent/{auth.json,models.json}`；
- 版本检查与更新、cc-switch 导入、DSH 本机主机都只针对 Windows 二进制。

WSL 侧目前只有「设置 → WSL」里的发行版列表、探测结果/版本和**CLI 路径覆盖**（`wsl_engine_paths`）。所以用户在 WSL 里用 pi/claude/codex 时，能改路径，但不能改发行版内的官方配置、认证或模型配置——这不是菜单漏注册，而是管理面没有“作用域”。

### 11.2 能力盘点

| 能力 | 现实现（本机） | WSL 可行性 | 归属 |
| --- | --- | --- | --- |
| 引擎启停 | 全局 `config.enabled` | 全局即适用（发送前统一门禁） | 本次（只读说明，不新增开关） |
| 版本/路径 | 本机探测 + `AppSettings.<engine>Bin` | 已有 `wsl_engine_paths` + `wsl_probe` 版本 | 本次（查询、展示与覆盖） |
| 官方配置编辑 | 本地文件编辑器 | 发行版内读/写文本，复用 JSON/TOML 校验 | 本次（claude/codex/kimi 读写，codex `auth.json` 标记 secret） |
| Pi / omp 认证 | 主机 `auth.json` / `models.json` | 发行版内同名文件；API key 可写、OAuth 登录需终端 | 后续（API key/models）；OAuth 依赖终端 |
| 供应商渠道 | 应用级 `config.json` + spawn 时注入 env/argv | 同一套渠道已作用于 WSL 发送（`prepare_launch` 在 `wrap` 之前） | 本次（只读说明，避免误导为“每个发行版一套”） |
| 自定义模型 | `AppSettings.customModels`（全局） | 远程目录已是权威；全局自定义模型是否合并需定 | 后续 |
| 自定义配置目录 | `codexHome`（主机） | 可加每发行版 `CODEX_HOME` 覆盖 | 后续 |
| 检查更新/升级 | 本机二进制/包管理器 | 需在发行版内跑包管理器，风险高 | 后续（只给可复制命令，不自动执行） |
| cc-switch 导入 | 主机配置/文件 | 与发行版配置无关 | 不提供 |
| DSH 本机主机 | Windows 主机进程 | 与本机 WSL 无关 | 不提供 |

### 11.3 交互设计（推荐：页内作用域切换）

**不新增一个平行的“WSL CLI 管理”导航页**，而是在每个 CLI 页签顶部加作用域分段控件：

```
Claude Code
[ 本机 Windows ] [ WSL: Ubuntu-24.04 ▾ ]
```

- 默认「本机 Windows」，保持现有行为完全不变。
- 选择 WSL 后，整个页签主体替换为 `WslCliPanel`（独立组件，不复用主机 `useCliConfig` 的 state），最终目标显示：
  1. **状态**：探测到的二进制绝对路径、版本、来源、探测时间；「重新检测」复用 `wsl_reprobe`。
  2. **CLI 路径覆盖**：复用现有 `set_wsl_engine_path` / `get_wsl_engine_paths`。
  3. **官方配置**：claude/codex/kimi 的白名单文件可读写（`wsl_cli_config_*`）；codex 的 `auth.json` 标记 secret 并以 0600 写入。
  4. **Pi / omp 认证**：API Key 列表（只回传 provider + 掩码状态，绝不回传 key）、新增/删除、`models.json` 编辑器；本次的 OAuth 只显示「请在 WSL 终端执行 `pi auth login`」，内置终端就绪后由用户在其中完成登录，宿主不代跑 `pi auth`。
  5. **渠道说明**：一行只读提示「应用级渠道对本机与 WSL 同时生效」，避免用户在 WSL 面板里找不到渠道而误以为失效。
  6. **不支持项**：检查更新、cc-switch 导入、DSH 主机卡片直接隐藏；不受支持的引擎不显示作用域，页面与本机一致，不提供点了才报错的假入口。

  本次只实现 1–2（只读状态 + 路径覆盖）；3–5 在后续加入，本次不提前渲染空壳。
- 发行版选择持久化在 localStorage（全局一个，不按引擎分裂）；没有发行版时作用域控件不渲染，页面与本机现状一致（发行版的安装/检测入口仍在「设置 → WSL」）。
- 作用域控件只在桌面 Windows、至少有一个发行版且该引擎受后端支持时出现；Web 模式不渲染。

**为什么不做成新导航页**：用户已经在对应引擎页里，作用域是页内属性；新页会让“Claude 的 WSL 配置”和“Claude 的本机配置”分居两处，也会让 CLI 管理导航无限膨胀（发行版 × 引擎）。**为什么不把 host state 穿透一个 `scope` 参数**：`useCliConfig`、`CliEngineSettingsCard`、官方编辑器、Pi 认证、版本/更新都各自直连主机数据源，逐个改造会把主机路径、AppSettings、cc-switch 语义带进远程分支，回归面过大；独立面板可以 fail-closed。

### 11.4 后端设计

新增 `src-tauri/src/engine/wsl_cli.rs`（桌面命令，不进 `web/dispatch.rs`）：

```rust
pub struct WslCliStatus {
    engine: String,
    distro: String,
    bin: Option<String>,        // 探测/覆盖后的发行版内绝对路径
    version: Option<String>,
    source: WslCliSource,       // probe | override | missing
    probed_ago_secs: Option<u64>,
    // 以下字段后续增量加入；本次不实现
    config_files: Vec<WslConfigFileInfo>, // key/path/format/secret/exists
    auth: bool,                 // pi/omp 是否有 auth.json
    capabilities: WslCliCaps,   // official_config / api_key / models / oauth / update
}

pub struct WslConfigFile { key, path, format, content, exists, secret }
```

上面是后续的最终形状；本次只实现前六个字段（`engine`/`distro`/`bin`/`version`/`source`/`probed_ago_secs`），后续字段只做增量，不改已有语义。

IPC（本次只实现前两个只读命令，其余后续增量加入）：

- `wsl_cli_capabilities() -> WslCliCapabilities`（后端声明哪些引擎能在 WSL 中运行）
- `wsl_cli_status(distro) -> Vec<WslCliStatus>`
- `wsl_cli_config_read(distro, engine) -> Vec<WslConfigFile>`
- `wsl_cli_config_write(distro, engine, files: Vec<{key, content, expectedHash?}>) -> ()`
- `wsl_pi_auth_list(distro, engine) -> {providers, oauthProviders, storePath}`
- `wsl_pi_auth_set_key(distro, engine, provider, key) -> ()`
- `wsl_pi_auth_delete(distro, engine, provider) -> ()`
- `wsl_pi_models_read(distro, engine) -> {text, path}`
- `wsl_pi_models_write(distro, engine, text) -> ()`

复用：`wsl_probe_snapshot`、`wsl_reprobe`、`set_wsl_engine_path`、`get_wsl_engine_paths`。

**文件白名单**（key 固定，前端不能传任意路径）：

| 引擎 | key → 发行版内路径 | 格式 | secret |
| --- | --- | --- | --- |
| claude | `settings` → `${CLAUDE_CONFIG_DIR:-$HOME/.claude}/settings.json` | json | 否 |
| codex | `config` → `${CODEX_HOME:-$HOME/.codex}/config.toml` | toml | 否 |
| codex | `auth` → `${CODEX_HOME:-$HOME/.codex}/auth.json` | json | 是 |
| kimi | `config` → `${KIMI_CODE_HOME:-$HOME/.kimi-code}/config.toml` | toml | 否 |
| pi | `models` → `${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/models.json` | json | 否 |
| pi | `auth` → `${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/auth.json` | json | 是 |
| omp | 同 pi，根为 `$OMP_HOME`/`~/.omp/agent`（后续） | json/yml | 是 |

**读写机制**

- 读：一次 `bash -s`，脚本按白名单常量 `cat` 文件并 base64 输出，`stat` 给 mtime/size；单文件上限 256 KiB、单次总上限 1 MiB。返回内容到 webview 编辑（与主机官方编辑器同信任级）。
- 写：先在后端校验 JSON/TOML（复用现有 parser），再在一次 `bash -s` 中把 base64 内容写到同目录临时文件（`umask 077`；secret 文件 `chmod 600`），`mv` 原子替换；失败保留原文件。脚本内容走 stdin，不进 argv。
- 冲突：可选 `expectedHash`（读时返回 sha256）；不一致返回 `WSL_CLI_CONFIG_CONFLICT`，前端提示重新读取，不覆盖终端里刚改的内容。
- 锁：按 `(distro, engine, file)` 串行化写入；同一发行版的探测/写配置不并发。
- 错误码：`WSL_CLI_FILE_TOO_LARGE`、`WSL_CLI_CONFIG_INVALID_JSON/TOML`、`WSL_CLI_CONFIG_READONLY`、`WSL_CLI_CONFIG_CONFLICT`、`WSL_CLI_AUTH_INVALID`，其余复用 `WSL_*` 探测错误；全部走 i18n。

**Pi 认证复用**：把 `pi_family_auth` 的纯解析/校验（`validate_models_config_text`、provider catalog、掩码逻辑）抽成不依赖主机路径的函数；主机实现继续用 `~/.pi`，WSL 实现通过上面的文件 API 读写发行版 `auth.json` / `models.json`。OAuth 状态只读展示；登录按钮本次显示「在 WSL 终端执行」，内置终端就绪后再接入。

### 11.5 安全与数据

- 只允许白名单 key，前端永远不能指定任意路径；发行版名过 `is_safe_distro`。
- API key 只在写命令中出现一次：不写日志、不进 argv、不出现在错误串；列表只返回 provider id 与掩码。
- secret 文件权限 0600、目录 0700；普通配置保留原权限（读时 `stat`，写时沿用）。
- 文本上限 + base64 解码上限，防止 `cat` 大文件打爆 IPC。
- 所有远程文件操作只在 `Local` 后端；`meta.wsl` 远程工作区不走本机发行版。
- Web 模式不注册这些命令，设置页 WSL 作用域不渲染。

### 11.6 范围与路线图（公开仓库）

**最终目标状态**

- 桌面 Windows 上，每个 CLI 页签都能切换「本机 / WSL 发行版」；
- WSL 侧可查看状态/版本/探测路径，覆盖 CLI 路径，编辑官方配置（claude/codex/kimi）、Pi/omp 的 API Key 与 `models.json`，并在条件具备后完成 OAuth 登录；
- 每个发行版可选自定义配置目录与自定义模型；
- 不能自动完成的（更新、OAuth 未接入终端时）给出明确的降级说明，不出现假按钮；
- 渠道（供应商）保持**应用级**，本机与 WSL 共用；不按发行版分裂；
- 所有远程能力按引擎 capability 显示，后续新增引擎不需要改 UI 骨架。

**本次实现**

- 只读状态与页内作用域：CLI 页出现「本机 / WSL 发行版」，WSL 面板显示 bin、版本、来源、上次探测，可改路径、可重新检测；
- WSL 面板复用本机页的应用级能力：引擎启停、官方配置白名单读写（claude/codex/kimi，codex `auth.json` 标记 secret）、供应商渠道说明与「切回本机管理」；
- 后端提供 `wsl_cli_status` / `wsl_cli_capabilities` / `wsl_cli_config_read` / `wsl_cli_config_write`，复用现有探测缓存与路径覆盖；
- Pi 的认证与模型编辑（`auth.json` / `models.json`）不在本次范围。

**后续工作**（按依赖顺序推进，不构成版本承诺）

| 工作项 | 用户可见结果 | 范围 | 明确不做 | 依赖 |
| --- | --- | --- | --- | --- |
| Pi 认证 | 已实现（`docs/plans/2026-10-23-wsl-pi-auth.md`）：Pi 的 API Key 列表/增删、`models.json` 编辑；聊天模型菜单即时刷新 | 远程 `auth.json` 读写、掩码、provider 校验、模型刷新 | OAuth 登录 | 本次的文件服务 |
| WSL 终端与 OAuth | Pi/omp OAuth 登录可在发行版内完成；OAuth 状态刷新 | WSL 终端 + `pi auth` 流程 + 状态读取 | 其他引擎的登录流程 | 终端能力 |
| 高级配置 | 每发行版自定义配置目录/自定义模型；更新给出可复制的发行版内命令 | `CODEX_HOME` 等覆盖、custom models、手动更新提示 | 自动跑包管理器升级 | 本次的文件服务与 Pi 认证 |

**已决定：渠道保持应用级，不做每发行版独立渠道。** 本机与 WSL 发送共用 `config.json` 的渠道与当前选择；WSL 面板只放说明，不提供第二套渠道管理。这样发送路径、迁移与 UI 都不会分裂。

**当前工作区的改动**：§1–§10 的本机 WSL 基础能力、Pi 支持与一轮缺陷修复已经交织在同一批文件里，作为一次完整的改动整体提交；不按文件硬拆（中间态无法编译，也不符合公开仓库每个提交可构建的要求）。§11 描述的只读状态与页内作用域已实现（未提交），实机验收通过。

本次实现的详细设计、IPC 契约、组件拆分和验收见 `docs/plans/2026-10-23-wsl-cli-management.md`；后续工作在该文档 §9 保持概要，实施时再单独细化。

**为什么先做只读**

1. **先固定只读契约**：状态、能力、路径来源与错误码在没有 UI 时评审完；白名单、原子写、权限、上限、冲突检测随第一次真正的文件读写一起评审，避免先落一层没有调用方、也不会被实机验证的写入代码。
2. **只读作用域先验证交互**：切换、发行版选择、错误态和 host 页签零回归；不引入写入风险。
3. **官方配置写入面较大**：但只碰非 secret 文件（codex `auth.json` 单独按 secret 处理）；Pi 认证涉及密钥，单独评审、独立测试/威胁模型，先 API Key，OAuth 等终端可用。
4. **OAuth 依赖终端**：需要发行版内交互式终端；终端未就绪时保持「在 WSL 终端执行」的明确降级，不做假登录按钮。
5. **增强项不阻塞主路径**：自定义目录/模型、其他引擎都建立在稳定契约上。

**公开仓库的合并规则**

- 每次改动自包含：后端 + UI + i18n + 测试 + 设计文档同步；不把未完成面板露给用户。
- 新 IPC 与新字段只做**增量**；`config.json` / `AppSettings` 不改既有字段语义，旧版本读写不报错。
- 能力用 `WslCliCapabilities` 表达：后端说支持什么，前端才渲染什么；新引擎接入不改 UI 骨架。
- 主机 CLI 管理路径完全不动；WSL 作用域只在桌面 Windows 且检测到发行版时出现，Web 端不注册命令。
- 涉及密钥的改动，合并前必须有：不回传明文 key、不写日志、0600 权限、大小上限、失败不覆盖原文件。
- 涉及文件读写的改动增加实机 WSL 读写用例；只涉及只读状态的改动至少跑 `cargo test --lib wsl`、相关 vitest、`pnpm build`、`cargo test --test wsl_boundary_guard`。
- 版本记录/`src/version/changelog.ts` 只在真正发版时更新，不随每次改动修改；设计文档随改动更新 §11 的状态。

**验收门槛（摘要）**

- 只读状态与页内作用域：契约稳定；受支持引擎顺序固定；非法发行版在探测前被拒绝；不新增 `wsl.exe` 调用；host 页签无回归；空态/发行版关停/无 CLI 都有明确文案；Web 与非 Windows 不出现作用域；`wsl_boundary_guard` 全绿。
- 官方配置：白名单外路径不可读写；非法 JSON/TOML 不落盘；secret 文件 0600；超限/只读/冲突有稳定错误码；编辑保存后发行版内文件立即变化；外部同时修改返回冲突而非覆盖；原文件在失败时保持不变。
- Pi 认证：API Key 只在写入命令中出现一次；列表只返回掩码；保存 `models.json` 后模型菜单刷新。
- WSL 终端与 OAuth：OAuth 在发行版内完成并能刷新状态；终端不可用时 UI 明确降级。
- 高级配置：每发行版自定义目录/模型只影响该发行版；更新只给命令，不自动执行。

### 11.7 验收清单

- [ ] CLI 页顶部可切换「本机 / WSL 发行版」，默认本机，主机行为不变。
- [ ] WSL 面板显示发行版、bin、版本；「重新检测」只重探该发行版。
- [ ] 修改 `~/.claude/settings.json` 后保存，发行版内 `cat` 立即看到；非法 JSON 被拒且原文件不变。
- [ ] codex `config.toml` / `auth.json` 可读写；`auth.json` 权限为 0600。
- [ ] pi 新增/删除 API key 后，发行版 `auth.json` 更新、前端只显示掩码；`models.json` 保存后聊天模型菜单刷新。
- [ ] 发行版关停/无权限/文件过大/冲突各有可诊断错误，不出现裸 exit code。
- [ ] 两个 GUI 实例不会互相覆盖配置（写入锁 + 原子替换）。
- [ ] Web 访问端看不到 WSL 作用域。

### 11.8 待决问题

已决定：

1. **渠道作用域**：保持应用级，不做每发行版一套；本次只放说明。
2. **作用域选择持久化粒度**：全局一个发行版，不按引擎分裂。
3. **minimax/grok/omp**：本次覆盖 `claude/codex/kimi/pi/minimax`；grok/omp 等发送门禁支持 WSL 后再加入，不在本次显示不可用的作用域。
4. **本次是否包含文件读写**：包含白名单官方配置（claude/codex/kimi）的读写；白名单外路径不可读写。
5. **secret 文件是否允许在 webview 中查看**：允许，与主机官方编辑器同级；secret 文件标记并以 0600 写入，内容不进日志/argv。

仍待确认：

1. **Pi OAuth 登录**：接受“在 WSL 终端执行”作为明确降级，还是必须内置终端（依赖后续的 WSL 终端）。

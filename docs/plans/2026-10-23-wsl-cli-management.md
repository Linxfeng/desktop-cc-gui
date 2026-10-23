# WSL CLI 管理：只读状态与页内作用域

- 日期：2026-10-23
- 基线：`main` @ `29242af14`（本机 WSL 工作区与 Claude/Codex/Pi CLI 支持）
- 状态：已实现，Windows 11 + WSL2 实机验收通过（2026-10-23）
- 上游路线：`docs/plans/2026-10-19-wsl-local-support.md` §11（本文细化其中的只读状态与页内作用域）
- 上游同步：`2026-10-19-wsl-local-support.md` §11.2 的能力归属、§11.3 的作用域可见性、§11.6 的范围与验收门槛、§11.8 的待决问题已按本文修订
- 本次决策：渠道保持**应用级**，本机与 WSL 共用；不做每发行版渠道
- 范围：本次只做**只读状态与能力契约**；白名单文件读写、原子写、权限与冲突检测留到第一次真正需要写文件时再评审，避免先落一层没有调用方的写入基础设施

---

## 0. 一页结论

**后端（本次实现，无 UI）**

- 新增 `src-tauri/src/engine/wsl_cli.rs`；
- 新增 `wsl_cli_status(distro)`：复用 `wsl_probe` 的缓存（含 5 分钟正缓存、10 秒失败负缓存与 single-flight），返回该发行版内**受支持引擎**的路径、版本、来源、探测年龄；
- 新增 `wsl_cli_capabilities()`：返回后端当前能在 WSL 里运行的引擎 id，前端据此决定是否显示作用域，避免前后端各维护一份白名单；
- 把 `wsl_availability::local_supported_engine` 收敛为 `wsl_cli::supported_engine`，可用性与 CLI 管理共用同一判定。

**前端（本次实现，只读）**

- CLI 页顶部出现「本机 Windows / WSL 发行版」作用域，发行版可切换并全局记忆；
- WSL 面板复用本机页的语言：引擎启停（应用级）、官方配置（白名单文件读写 + 冲突检测）、CLI 状态与「重新检测」、路径覆盖、供应商渠道说明与「切回本机管理」；
- 页头在本机作用域保持原样，在 WSL 作用域隐藏本机版本/更新，只保留通用文档入口；
- 本机页签的内容与既有测试不变（`useCliConfig` 原样搬进 `HostCliConfig`）；只有桌面且检测到发行版时，内容上方多一张作用域卡，其余环境 DOM 与现在一致。

**本次明确不做**

- 不编辑 Pi 的 `models.json` / `auth.json`（认证与模型留给下一步）；
- 不做 API Key、OAuth、CLI 更新、cc-switch 导入、DSH 主机；
- 不新增每发行版渠道，不新增「WSL CLI 管理」导航页；
- 不改 `config.json` / `AppSettings` 的既有字段语义；
- 不把 `wsl_cli_*` 加入 `web/dispatch.rs`；
- 白名单之外的发行版内文件不可读写。

---

## 1. 问题与目标

现有「设置 → CLI 管理」的每个页签只管理 Windows 侧：

- `src/features/settings/CliConfigSection.tsx` 直接调用 `useCliConfig`；
- `useCliConfig` 读主机 `config.json`（渠道/当前渠道/启停）与主机 `AppSettings`（自定义路径、配置目录、自定义模型）；
- `CliOfficialEditDialog` / `provider_files` 直接读写 Windows 的 `~/.claude`、`~/.codex`、`~/.kimi-code`；
- `PiFamilyAuthSection` 读写主机 `~/.pi`；
- `CliHeaderActions` 的版本检查、更新、安装只针对 Windows 二进制；
- cc-switch 导入与 DSH 主机卡片同样只针对本机。

WSL 侧目前只有「设置 → WSL」的探测结果、版本和 CLI 路径覆盖（`AppSettings.wsl_engine_paths`）。用户在发行版里用 Claude/Codex/Pi 时：

- 看不到发行版内的安装路径、版本、来源；
- 无法在对应的 CLI 页里确认「这个引擎在 WSL 里能不能用」；
- 后续官方配置/认证管理也没有稳定的入口与数据契约。

**本次目标**

| 编号 | 目标 | 验收方式 |
| --- | --- | --- |
| G1 | 后端提供发行版内 CLI 状态：引擎、绝对路径、版本、来源、探测年龄 | Rust 单测 + 实机 |
| G2 | 前端能按引擎判断「是否支持 WSL 作用域」，不在 UI 里硬编码白名单 | `wsl_cli_capabilities` + 前端测试 |
| G3 | CLI 页顶部出现作用域切换，默认本机，行为不变 | 本机回归测试 |
| G4 | WSL 面板只读展示状态，空态/错误/发行版关停都有明确文案 | 前端测试 + 实机 |
| G5 | 复用现有路径覆盖与「重新检测」，不新增存储 | 单测 + 实机 |
| G6 | 渠道与引擎启停说明明确为应用级 | UI 文案 + 设计文档 |
| G7 | 为后续留出稳定的 `WslCliStatus` 契约，只做增量扩展 | 契约评审 |

**非目标**

- 不读取/写入发行版内的配置、认证、模型文件；
- 不提供第二套渠道；
- 不把 WSL 作用域暴露到 Web 访问端；
- 不解决 grok/omp/ACP 引擎在 WSL 中的运行问题（发送门禁仍会拒绝，作用域不显示）。

---

## 2. 设计前提核对

以下事实在基线代码中已确认，本设计直接复用，不重复造轮子：

| 事实 | 代码位置 | 对本设计的意义 |
| --- | --- | --- |
| 探测带 5 分钟缓存、同发行版 single-flight、失败 10 秒负缓存 | `engine/wsl_probe.rs` 的 `ensure` | `wsl_cli_status` 直接 `ensure`，不新增 `wsl.exe` 调用 |
| 探测结果含 `bins`（命令名 → 绝对路径）与 `versions`（命令名 → 版本） | `WslProbe` | 状态卡的数据源 |
| 探测结果含发行版内 `HOME` / `CODEX_HOME` / `CLAUDE_CONFIG_DIR` / `PI_CODING_AGENT_DIR`；本次补 `KIMI_CODE_HOME` | `WslProbe` / `PROBE_SCRIPT` | 官方配置路径只读展示 |
| 探测年龄可读 | `wsl_probe::probe_age(distro)` | `probedAgoSecs` 不新开缓存 |
| 发行版名校验 | `wsl_path::is_safe_distro`（`pub(crate)`） | 命令入口与 `ensure` 双重校验 |
| 路径覆盖按 `<distro>:<engine>` 存储、写入即校验 | `settings::set_wsl_engine_path` / `wsl_engine_overrides` | 直接复用，不新增字段 |
| 引擎 id 与 CLI 命令名可能不同 | `engine::cli_binary_name`（`minimax` → `mcode`） | 状态查询必须按命令名查探测表 |
| 引擎顺序稳定 | `config::ENGINES` | 状态列表与可用性列表同序 |
| WSL 可运行的引擎白名单目前是私有函数 | `wsl_availability::local_supported_engine` | 收敛到 `wsl_cli`，两处共用 |
| 页头版本/更新只针对本机 | `CliHeaderActions.tsx` | 必须在 WSL 作用域隐藏，否则会误导 |
| 设置搜索的索引测试只渲染 `CliConfigBody` | `builtin-search.test.tsx` 的 `PAGES` | 不新增搜索锚点，避免索引测试与作用域条件渲染打架 |
| `ensure` 成功即写入缓存 | `wsl_probe::ensure` | 成功返回后 `probe_age` 正常总有值；`Option` 只兜底并发 `invalidate` 竞态 |
| 探测失败有 10 秒负缓存 | `wsl_probe::negative_cache`（`NEGATIVE_TTL`） | 失败后 10 秒内的普通重试拿到的还是同一错误；「重新检测」先 `invalidate` 才能立即再探 |
| `isWeb` 在 jsdom 中恒为 `true`（没有 `__TAURI_INTERNALS__`） | `src/lib/transport.ts` | 前端测试默认走「非桌面」分支；WSL 用例必须显式 mock 平台，不能只改 UA |
| 设置页偏好的存储键使用 `ccgui-next.*:v1` | `src/features/settings/font.ts`、`src/lib/cli-nav-order.ts` | 作用域记忆沿用同一命名，便于排查与迁移 |

---

## 3. 用户路径与交互

### 3.1 页面结构

```
设置 → CLI 管理 → Claude Code
┌──────────────────────────────────────────────────────────────┐
│ 作用域   [ 本机 Windows ] [ WSL 发行版 ]      Ubuntu-24.04 ▾ │
├──────────────────────────────────────────────────────────────┤
│ 启用 Claude Code                                       [开关] │
├──────────────────────────────────────────────────────────────┤
│ 官方配置        /home/me/.claude/settings.json         [复制] │
├──────────────────────────────────────────────────────────────┤
│ CLI 状态          自动探测 · v2.1.280            [重新检测]  │
│ CLI 路径          /home/me/.nvm/.../bin/claude              │
│ 上次探测          2 分钟前                                    │
│ Claude Code 路径覆盖  [ /home/me/bin/claude            ]     │
├──────────────────────────────────────────────────────────────┤
│ 供应商渠道     应用级，与 WSL 共用           [切回本机管理]   │
└──────────────────────────────────────────────────────────────┘
```

选择 WSL 后，整个页签主体替换为 `WslCliPanel`；本机的 `useCliConfig`、渠道、官方配置编辑器、版本/更新**不挂载**。

### 3.2 作用域可见性

作用域控件只在同时满足以下条件时渲染：

1. `!isWeb`；
2. `IS_WINDOWS`（`src/lib/platform.ts`）；
3. 已成功读取发行版列表与能力表；
4. 至少一个发行版；
5. 当前 CLI 页的引擎在 `wsl_cli_capabilities().engines` 里。

否则**完全不渲染**，页面与本机现状一致。非 Windows、Web、无发行版、引擎不支持都不显示一个点不动的控件。

判定顺序固定为 `isWeb` → `IS_WINDOWS` → 元数据就绪 → 发行版非空 → 引擎受支持：前两项是同步常量，后两项要等一次 IPC，因此**不要**在元数据回来前渲染作用域控件。测试环境里 `isWeb` 恒为真（jsdom 没有 `__TAURI_INTERNALS__`）、`IS_WINDOWS` 也为假，默认就是「本机」；WSL 分支必须 mock 平台模块，不能靠改 `navigator.userAgent`（见 §6.2）。

**支持范围（本次固定）**：`claude`、`kimi`、`codex`、`pi`、`minimax`（按 `config::ENGINES` 顺序为 `claude, kimi, codex, pi, minimax`）。

`grok` / `omp` / `dsh` / `agy` / `opencode` / `qoder` / `qoder-cn` 不显示作用域。原因不是「探测不到」，而是发送门禁只允许 Child 传输且无 Windows staging 的引擎；让用户切过去再在发送时被拒绝，比不显示更糟。未来支持哪个引擎，只改后端白名单，前端无需改。

### 3.3 作用域与发行版记忆

- `localStorage` 键（沿用设置页 `ccgui-next.*:v1` 的命名）：
  - `ccgui-next.cliScope:v1`：`"host" | "wsl"`，缺省 `host`；
  - `ccgui-next.wslCliDistro:v1`：发行版名。
- 读取放在首次 `getSnapshot`，不在模块 import 期碰 `window`：Web 端、jsdom 与服务端渲染路径都不会因为缺少存储而抛错，测试也不用为每个文件加全局 stub。
- 作用域与发行版是**全局**的：在一个 CLI 页选 WSL，切到另一个受支持的 CLI 页仍保持 WSL；避免每页重选。
- 只有一个发行版时仍显示选择器（让用户确认作用域），不是隐藏成一个静态标签。
- 已记忆的发行版不在当前列表里时，回退到第一个并写回；列表为空时强制回退 `host` 并**同时清除两个键**（否则下次装好发行版会突然跳回 WSL 作用域）。
- 默认 `host`；从未使用过 WSL 的用户看不到任何变化。

### 3.4 页头行为

`CliHeaderActions` 目前显示官方文档、版本检查、刷新、安装/更新。WSL 作用域下：

- 隐藏版本检查/刷新/更新/安装（它们只针对 Windows 二进制）；
- 保留「官方文档」图标按钮（文档对两种作用域都成立）；
- 在作用域尚未判定、但用户上次选的是 WSL 时，同样只保留文档按钮，避免本机版本号先闪一下。

### 3.5 WSL 面板状态

| 情况 | 展示 |
| --- | --- |
| 正在读取状态 | `role="status"` 的加载行；路径覆盖仍可用 |
| 探测成功、引擎已安装 | 来源「自动探测」、绝对路径、版本、上次探测；「重新检测」 |
| 设置了路径覆盖 | 来源「路径覆盖」、覆盖路径；版本显示 `—`（不拿探测到的另一个二进制的版本冒充）；「上次探测」仍显示自动探测的缓存年龄，它描述探测而非覆盖路径 |
| 探测成功但该引擎未安装 | 来源「未找到」、空态「发行版内未检测到该 CLI」；路径覆盖与「重新检测」仍可用 |
| 探测失败 / 发行版关停 | 页面级 `role="alert"`：`wsl.cli.statusFailed` + `errorText` 的原因；保留路径覆盖与「重新检测」 |
| 重新检测：探测成功、状态读取失败 | **不显示对号**；页面级错误 + 可再次重新检测（走 `wsl_reprobe`，会清 10 秒负缓存） |
| 路径覆盖保存失败 | 行内 `role="alert"`，显示 `WSL_CLI_PATH_INVALID:*` 的本地化原因；输入框内容不丢，状态卡保持原样 |
| 路径覆盖已保存、但随后状态读取失败 | 页面级 `role="alert"`：`wsl.cli.statusStale` + 原因；**不**写成「路径无效」，也不回滚设置（保存本身已经成功）；行内只保留保存校验错误，避免同一失败出现两次 |
| 发行版列表/能力表读取失败 | 不渲染作用域；若用户上次选的是 WSL，显示错误 + 重试，下方仍可用本机页 |
| 没有发行版 | 不渲染作用域；本机页正常 |

### 3.6 来源与版本语义

| 来源 | `bin` | `version` | 含义 |
| --- | --- | --- | --- |
| `probe` | 探测到的绝对路径 | 探测到的版本，可能为 `null` | 发行版内 `bash -ic` 找到的 CLI |
| `override` | 设置里的覆盖路径 | 恒为 `null` | 用户显式指定；不证明文件存在，也不拿探测结果冒充 |
| `missing` | `null` | `null` | 既没有覆盖，也没有探测到 |

「路径覆盖」只表示设置值。发送时仍会走现有的 `verify_local_cli`，路径不存在/不可执行会得到 `WSL_CLI_NOT_FOUND` / `WSL_CLI_NOT_EXECUTABLE`。本次不为状态卡额外跑一次短调用；后续若需要「文件是否存在」再增量加字段。

### 3.7 应用级设置

WSL 面板把**应用级**能力按本机页的语言直接给出，而不是只放一句说明：

- **引擎启停**：复用 `CliEngineCard`，开关写的就是 `config.enabled`；WSL 发送受同一个开关门禁（`config::ensure_engine_enabled`），不存在「本机停用、WSL 仍可发」的第二套开关。
- **官方配置**：白名单文件可读写（claude `settings.json`、codex `config.toml` + `auth.json`、kimi `config.toml`）：读带 sha256，写前校验 JSON/TOML、`expectedHash` 冲突检测、`umask 077` 临时文件 + `mv` 原子替换，secret 文件 `chmod 600`；卡片显示路径 + 复制 + 编辑入口。
- **供应商渠道**：卡片说明「应用级，本机与 WSL 发送共用同一套渠道」，并提供「切回本机管理」按钮（切回本机作用域后即可看到完整的渠道卡）。不在 WSL 作用域内复制一套渠道 UI。

---

## 4. 后端设计

### 4.1 新模块

`src-tauri/src/engine/wsl_cli.rs`：

```rust
//! WSL 发行版内的 CLI 管理状态 —— 只读。
//!
//! 数据源是 [`super::wsl_probe`] 的探测缓存与 `AppSettings.wsl_engine_paths`
//! 的路径覆盖；本模块**不直接调用 `wsl.exe`**（探测一律经 `wsl_probe::ensure`，
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
/// 从 `wsl_availability` 收敛到这里，可用性与 CLI 管理共用一份判定。
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
```

### 4.2 IPC

```rust
#[tauri::command]
pub fn wsl_cli_capabilities() -> WslCliCapabilities {
    WslCliCapabilities {
        engines: supported_engines(),
        editable_engines: editable_engines(), // claude / codex / kimi
    }
}

#[tauri::command]
pub async fn wsl_cli_status(distro: String) -> Result<Vec<WslCliStatus>, String> {
    // 先转成 owned String：发行版名要跨 await 使用，owned 值不把借用
    // 生命周期带进异步状态机。
    let distro = checked_distro(&distro)?.to_string();
    let probe = wsl_probe::ensure(&distro).await.map_err(|e| e.code())?;
    // 设置文件损坏不应让探测结果一起消失：没有覆盖也能展示探测状态。
    // 抽成纯函数是为了让错误分支可单测（见 §6.1）。
    let overrides = overrides_or_empty(crate::settings::read_settings(), &distro);
    let probed_ago_secs = wsl_probe::probe_age(&distro).map(|age| age.as_secs());
    Ok(statuses(&distro, &probe, &overrides, probed_ago_secs))
}
```

另外两条只读/写命令（白名单文件服务，细节见 §4.6 与 §4.8）：

- `wsl_cli_config_read(distro, engine) -> Vec<WslCliConfigFile>`（`key/path/format/secret/exists/tooLarge/content/hash`）；
- `wsl_cli_config_write(distro, engine, files)`：`{ key, content, expectedHash }` 先全量校验、再原子写；冲突返回 `WSL_CLI_CONFIG_CONFLICT:<key>` 不写任何文件。

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

fn checked_distro(distro: &str) -> Result<&str, String> {
    let distro = distro.trim();
    if !wsl_path::is_safe_distro(distro) {
        return Err("WSL_DISTRO_NOT_FOUND".to_string());
    }
    Ok(distro)
}
```

`wsl_cli_capabilities` 是纯静态数据，不返回 `Result`；它不调用 `wsl.exe`，也不依赖设置。它也不判断当前主机是否 Windows —— 前端用 `IS_WINDOWS` 兜底，非 Windows 平台即使调用也只会得到 `WSL_NOT_INSTALLED`。

`wsl_cli_status` 里的 `read_settings()` 是同步读一个小 JSON 文件，与 `wsl_availability::available_engines` 的现有做法一致，不引入新的阻塞点；`overrides_or_empty` 保证设置损坏只影响覆盖字段，不让探测结果一起消失，且该分支有单测覆盖。

序列化形状（camelCase）：

```json
// wsl_cli_capabilities
{ "engines": ["claude", "kimi", "codex", "pi", "minimax"] }

// wsl_cli_status
[
  {
    "engine": "minimax",
    "distro": "Ubuntu-24.04",
    "bin": "/usr/local/bin/mcode",
    "version": "0.4.2",
    "source": "probe",
    "configPath": null,
    "probedAgoSecs": 12
  }
]
```

前端类型（`src/lib/ipc.ts`）：

```ts
export type WslCliSource = "probe" | "override" | "missing";

export interface WslCliStatus {
  engine: string;
  distro: string;
  bin: string | null;
  version: string | null;
  source: WslCliSource;
  configPath: string | null;
  probedAgoSecs: number | null;
}

export interface WslCliCapabilities {
  engines: string[];
}
```

### 4.3 状态组装（纯函数）

```rust
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
```

关键点：

- 顺序由 `config::ENGINES` 决定，前端不再排序；
- 探测表按**命令名**建键，`minimax` 必须查 `mcode`；版本同样按命令名映射回引擎 id；
- 覆盖优先于探测；覆盖路径没有版本，不能拿探测到的另一个二进制的版本冒充；
- 受支持但没安装的引擎也要返回 `missing` 行，前端才能显示空态与覆盖输入框；
- `config_path` 只做展示：claude `settings.json`、codex/kimi `config.toml`、pi `models.json`，目录优先取发行版内 `CLAUDE_CONFIG_DIR` / `CODEX_HOME` / `KIMI_CODE_HOME` / `PI_CODING_AGENT_DIR`，否则回退 `$HOME/.claude` 等；minimax 暂无官方配置文件，返回 `None`。它不证明文件存在，也不读写；
- `probed_ago_secs` 对整个列表相同（同一次 `ensure` 的结果）。

### 4.4 复用与边界

- 复用 `wsl_probe::ensure`：不新增 `wsl.exe` 调用，自动享受 5 分钟缓存、single-flight、失败负缓存；探测脚本只增加一个 `KIMI_CODE_HOME` 哨兵（供官方配置路径展示），不改变既有字段语义；
- 复用 `settings::wsl_engine_overrides`：只读，不新增存储；写入仍走 `set_wsl_engine_path`；
- 复用 `engine::cli_binary_name`：不在新模块里写 `minimax → mcode` 特判；
- `wsl_availability` 改为调用 `wsl_cli::supported_engine`，删除自己的私有白名单；`available_engines` 的其他逻辑不变；
- 不碰 `transport_for_workspace`、`wrap`、`prepare_launch`、发送链路；
- 不新增文件读写；`wsl_boundary_guard` 的允许清单不变（新模块不含 `wsl.exe` / UNC 字面量）。

### 4.5 注册与可见性

- `engine/mod.rs` 增加 `pub mod wsl_cli;`；
- `lib.rs` 的 `invoke_handler` 增加：
  ```rust
  engine::wsl_cli::wsl_cli_capabilities,
  engine::wsl_cli::wsl_cli_status,
  ```
- **不加入** `web/dispatch.rs`：这是桌面能力，Web 端不渲染作用域，也不应能调用；
- 非 Windows 平台上命令仍然可调用，但 `ensure` 会返回 `WSL_NOT_INSTALLED`；前端在 `IS_WINDOWS` 为假时根本不显示入口。

### 4.6 错误契约

| 情况 | 返回值 | 前端 |
| --- | --- | --- |
| 发行版名非法 | `WSL_DISTRO_NOT_FOUND` | 已有 `errorText` 映射 |
| 本机没装 WSL | `WSL_NOT_INSTALLED` | 同上 |
| 发行版启动超时 | `WSL_START_TIMEOUT` | 同上 |
| 其他探测失败 | `WSL_PROBE_FAILED:<detail>` | 同上 |
| 探测失败的 10 秒负缓存期内重试 | 仍返回上一次错误 | 面板的「重新检测」走 `wsl_reprobe`（先 `invalidate`），而不是裸重试 |
| 设置文件损坏 | 不失败；无覆盖继续返回探测状态 | 控制台留原因，不阻塞页面 |

配置读写新增错误码（全部走 `errorText` 本地化）：`WSL_CLI_FILE_TOO_LARGE:<key>`、`WSL_CLI_CONFIG_INVALID_JSON:<key>: <detail>`、`WSL_CLI_CONFIG_INVALID_TOML:<key>: <detail>`、`WSL_CLI_CONFIG_CONFLICT:<key>`、`WSL_CLI_CONFIG_WRITE_FAILED:<key>`、`WSL_CLI_CONFIG_READ_FAILED:<key>`、`WSL_CLI_CONFIG_UNSUPPORTED:<engine>`。脚本永远 `exit 0`：结果走 stdout 哨兵，非零退出会被传输层统一成 `WSL_SHORT_CALL_FAILED` 而丢掉冲突信息。

### 4.7 缓存与并发

- 同一发行版的并发 `wsl_cli_status` 由 `wsl_probe::ensure` 的 single-flight 串行，不会叠加 2.4s 探测；
- 缓存命中时 `probed_ago_secs` 是缓存年龄（0–300 秒）；刚探测时为 0；
- 探测失败有 10 秒负缓存：窗口内的普通重试拿到同一错误是既有语义，不是「按钮没反应」。面板把「重新检测」映射到 `wsl_reprobe`（先 `invalidate` 正/负缓存），失败后可以立即再探；
- 「重新检测」先 `wsl_reprobe(distro)` 失效缓存并探测，再 `wsl_cli_status(distro)` 读取新缓存；第二次调用不会重新探测；
- 不在 `wsl_cli_status` 里强制刷新，否则打开页面就会丢掉 composer 正在用的探测结果（与 `2026-10-19-wsl-local-support.md` §10 中 `wsl_probe_snapshot` 的语义一致）。

### 4.8 契约演进

后续只做增量字段/命令，不改变现有字段语义。本次已落地：

- `WslCliCapabilities.editableEngines`（`Vec<String>`）：声明哪些引擎的官方配置可编辑（claude/codex/kimi）；
- `wsl_cli_config_read(distro, engine)` → `Vec<WslCliConfigFile>`（`key/path/format/secret/exists/tooLarge/content/hash`）；
- `wsl_cli_config_write(distro, engine, files)`：`key/content/expectedHash`，全量校验后才写，冲突按文件拒绝。

仍留给后续的增量：

```rust
// 后续增量（本次不实现）
pub struct WslCliStatus {
    // ... 现有字段不变
    pub auth: bool,                 // pi/omp 是否有 auth.json
    pub capabilities: WslCliCaps,   // api_key / models / oauth / update
}
```

`WslCliStatus` 不内嵌 `configFiles`：打开编辑器才读文件（`wsl_cli_config_read`），状态查询不付发行版内文件读取的代价。

---

## 5. 前端设计

### 5.1 组件拆分

```tsx
CliConfigSection(engine)
  ├─ useCliScope(engine)          // 作用域、发行版、能力、元数据
  ├─ CliScopeSwitch(scope)        // 可见时渲染
  ├─ HostCliConfig(engine)        // scope === host：现有实现原样搬入
  └─ WslCliPanel(engine, distro)  // scope === wsl：独立组件
```

- `HostCliConfig` 就是现有 `CliConfigSection` 的主体（`useCliConfig`、`CliConfigBody`、三个 dialog），行为不变；在不显示作用域的环境（Web / 非 Windows / 无发行版 / 引擎不支持）DOM 与既有测试保持原样，显示作用域时只在内容上方多一张作用域卡；
- `WslCliPanel` 不调用 `useCliConfig`、不读 `AppSettings`、不 import 主机 provider/cc-switch 逻辑；
- 这样避免给 `useCliConfig` / `CliEngineSettingsCard` / `CliOfficialEditDialog` / `CliHeaderActions` 穿透 `scope` 参数，也避免在 WSL 分支里误触主机文件。

`CliScopeSwitch` 的控件复用现有设置页语言：

- `SettingsCard` + `SettingsRow label={t("wsl.cli.scope")}`；
- 右侧 `PillTabList`（`blue`）放「本机 Windows / WSL 发行版」两个 `PillTab`。不用 `gray`：暗色主题下 gray 的选中底色（`neutral-850`）与卡片（`neutral-900`）几乎同色，看不出选中；作用域是主模式切换，用 blue 的强调底 + 蓝字；
- 选 WSL 后追加 `Select size="sm"` 选发行版（`aria-label` 用 `wsl.cli.distro`）；只有一个发行版也显示，方便确认作用域；
- 控件容器用 `flex flex-wrap items-center justify-end gap-2`，Select 最小宽度 ~160px：窗口窄时换行而不是把发行版名挤成一个字；
- 不新增设置搜索锚点（理由见 §5.9）。

间距：`HostCliConfig` 保留现有 `flex w-full flex-col gap-6` 容器，`CliScopeSwitch` 自带底部间距，`WslCliPanel` 使用同样容器；`CliConfigSection` 本身不再套一层 `gap-6`，避免双倍间距。

### 5.2 作用域 store

作用域需要被 `CliConfigSection` 与 `CliHeaderActions` 同时读取，因此做成模块级外部 store（`useSyncExternalStore`），而不是组件局部 state：

`src/features/settings/use-cli-scope.ts`

```ts
export type CliScope = "host" | "wsl";

interface CliScopeSnapshot {
  /** 用户上次选择，持久化；meta 未就绪时也保留。 */
  requested: CliScope;
  /** 全局发行版选择。 */
  distro: string | null;
  distros: string[];
  /** 后端声明的 WSL 可运行引擎。 */
  engines: string[];
  /** 是否已完成一次元数据读取（成功或失败）。 */
  ready: boolean;
  metaError: string | null;
}

interface CliScopeView extends CliScopeSnapshot {
  /** 当前引擎是否应该显示作用域控件。 */
  visible: boolean;
  /** 当前引擎实际生效的作用域（unsupported / 无发行版时回落 host）。 */
  active: CliScope;
  /** 用户上次选 WSL，但元数据还没回来：先别挂载 HostCliConfig。 */
  pending: boolean;
  setScope(next: CliScope): void;
  setDistro(next: string): void;
  reloadMeta(): void;
}

export function useCliScope(engine: EngineId): CliScopeView;
```

派生规则：

```ts
const desktop = typeof window !== "undefined" && !isWeb && IS_WINDOWS;
const visible =
  desktop &&
  snapshot.ready &&
  snapshot.distros.length > 0 &&
  snapshot.engines.includes(engine);
const active: CliScope = visible ? snapshot.requested : "host";
// 只有桌面环境才需要「等元数据」：Web/非 Windows 永远走本机，不该闪加载。
const pending = desktop && !snapshot.ready && snapshot.requested === "wsl";
```

- `setScope("wsl")` 时若还没有选中发行版，取列表第一个；
- `setScope` / `setDistro` 同步写 `localStorage`；
- 元数据读取成功且列表为空时：把 `requested` 重置为 `host` 并清除 `ccgui-next.cliScope:v1` 与 `ccgui-next.wslCliDistro:v1`；
- 元数据读取成功且已记忆的发行版不在列表里：回退第一个并写回；
- 元数据读取失败：`ready = true`、`metaError` 有值、`visible = false`；如果上次选的是 WSL，页面显示错误与「重试」，但下方仍回落到本机页，不让整页不可用；
- 失败不缓存：下一次挂载或点「重试」会重新读取；重试期间保留 `metaError`（不把旧错误闪没），成功后清空；
- localStorage 只在首次 `getSnapshot` 读取，写入用 try/catch 包住（隐私模式/配额满时不能因为记忆作用域而让页面崩溃）；
- `getSnapshot` 必须返回同一个对象直到 store 真正更新，否则 `useSyncExternalStore` 会因每次渲染都拿到新对象而无限重渲染。派生出的 `CliScopeView` 可以在 hook 内组装，但 `getSnapshot` 本身必须稳定。

### 5.3 元数据加载

`use-cli-scope.ts` 内部维护模块级缓存：

- 同时调用 `ipc.wslDistros()` 与 `ipc.wslCliCapabilities()`，用 `Promise.allSettled` 汇总：任一失败都记 `metaError`，发行版列表读不到时不显示作用域；
- 成功结果缓存 30 秒；失败不缓存，下次挂载/重试会重新读取；
- 同一时刻只允许一个 in-flight 请求（single-flight），`CliHeaderActions` 与 `CliConfigSection` 同时挂载时不会重复调用；
- 读取在 store 的订阅/effect 里启动，**绝不在 `getSnapshot` 里发起 IPC**：React 可能在渲染期多次调用 `getSnapshot`，在那里发请求会造成重复调用与「渲染中更新」；
- `invalidateWslCliMeta()` 只在用户主动「重新检测」（`probeAll(true)`）后调用。挂载时的 `wslProbeSnapshot()` **不**失效：否则每次进设置页都会把 30 秒元数据缓存清掉，等于没有缓存；发行版的安装/卸载本来就要用户点「重新检测」才会反映；
- 非桌面 Windows / Web 直接返回空元数据，不调用 IPC（jsdom 中 `isWeb` 为真，因此测试默认安全）；
- 元数据在页面挂载后**后台读取**：`requested = host` 时 Host 内容立即渲染，控件晚到只造成一次轻微布局变化；只有 `requested = wsl` 才用 `pending` 占位，避免先读主机配置再卸载。

### 5.4 状态加载

`src/features/settings/use-wsl-cli-status.ts`：

```ts
export function useWslCliStatus(distro: string | null): {
  statuses: WslCliStatus[] | null;
  loading: boolean;
  /** 最近一次读取失败；reason 决定页面用哪条文案（初次/重探 vs. 保存后）。 */
  error: { message: string; reason: "load" | "rescan" | "save" } | null;
  /** 触发一次读取并标记触发动作，返回该次读取的 Promise。 */
  reload: (reason?: "rescan" | "save") => Promise<void>;
};
```

- 仅 `distro` 非空时调用 `ipc.wslCliStatus(distro)`；
- 切换发行版时先清空旧状态并进入 loading，避免把上一个发行版的数据显示成新发行版；
- 「重新检测」/「路径覆盖保存后」调用 `reload()` 时**保留旧状态**，新结果到达再替换，页面不闪空；
- 用请求序号 + `cancelled` 标记丢弃晚到结果：切换发行版后旧请求的结果不得覆盖新发行版；
- `reload()` 的 Promise 在本次读取成功时 resolve、失败时 reject；面板用它的结果决定转圈 → 对号是否成功，避免「探测成功但状态读取失败」仍显示对号；
- 失败写入 `error`（带 `reason`），`reload()` 同时 reject；面板只保留**一个**页面级错误位置：`reason = save` 用 `wsl.cli.statusStale`，其余用 `wsl.cli.statusFailed`，同一失败不会在行内和页面各出现一次；
- `reload()` 不清空 `error` 也不清空旧 `statuses`：清空会让页面闪一下空态；成功后再替换，失败时保留上一次成功的结果并提示「读取失败」，用户仍能看到旧状态；
- 内部 effect 必须捕获初始读取的 reject，不能产生 unhandled rejection；`reload` 的 reject 由调用方 `.catch` 处理（通常只是 `catch(() => {})`，因为展示统一由 `error` 负责）；
- 错误统一走 `errorText`，不把裸错误串/退出码直接显示给用户。

### 5.5 WslCliPanel

`src/features/settings/WslCliPanel.tsx`：

- 面板结构与本机页对齐：引擎启停卡 → 官方配置卡（只读路径 + 复制）→ CLI 状态卡（含路径覆盖）→ 供应商渠道卡（说明 + 切回本机管理）；
- 引擎启停复用 `CliEngineCard`，状态来自聊天 store 的 `engines[].enabled`，写 `set_engine_enabled` 后 `notifyCliConfigChanged()`；失败在卡片下方行内 `role="alert"`；
- 官方配置卡只在 `configPath` 存在时渲染；路径等宽截断 + `title`，复制走 `useCopied`（Copy → Check）；
- `editableEngines` 含当前引擎时给「编辑」按钮，打开 `WslOfficialEditDialog`（打开时 `wsl_cli_config_read`，保存前 JSON 校验 + `expectedHash` 冲突检测，冲突提示「重新读取」而非覆盖；secret 文件标记密钥、写入 0600）；
- 编辑弹窗：`ModalShell` + 每个白名单文件一个 `TextArea` 页签；超限文件只提示不加载内容；缺失的 JSON 文件预填 `{}`；
- 渠道卡只说明应用级并提供「切回本机管理」（`onManageHost` → `scope.setScope("host")`）；不在 WSL 作用域复制渠道 UI，避免两套开关；
- 从 `statuses` 里按 `engine` 取当前行；若能力表说支持但状态行缺失（前后端漂移），按 `missing` 显示并在控制台留一行警告，不静默空白；
- 已安装/覆盖：
  - 「CLI 状态」行：来源徽标（自动探测 / 路径覆盖 / 未找到）+ 版本；右侧「重新检测」；
  - 「CLI 路径」行：绝对路径，等宽字体、`title` 显示完整路径、允许换行或截断；
  - 「上次探测」行：`relativeTime(Date.now() - probedAgoSecs * 1000)`，复用 `src/features/chat/time.ts` 的现有实现（`time.*` 文案），不额外起定时器；时间只在重新读取或重新进入页面时刷新，不做秒级倒计时；`probedAgoSecs` 为 `null` 时显示 `wsl.cli.probedUnknown`，不显示成「刚刚」；
  - 「路径覆盖」行：复用共享组件 `WslEnginePathRow`；
- 未安装：状态卡照常显示「未找到」，卡内保留路径覆盖，卡下方给空态标题/说明（文案指向「上方」的覆盖输入框）；
- 错误：页面级 `role="alert"`，由 `useWslCliStatus` 的 `error` 统一渲染（`reason` 选择文案），保留路径覆盖与重新检测；
- 「重新检测」：
  ```ts
  void feedback.start(async () => {
    // `wsl_reprobe` 先 invalidate 正/负缓存：关停后立刻重试不会拿到 10 秒内的旧错误。
    await ipc.wslReprobe(distro);
    invalidateWslEngineAvailability();
    // 等状态读取也有结果：探测成功但状态读取失败时不冒充对号。
    await reload("rescan");
  }).catch(() => {
    // 错误由 useWslCliStatus.error 渲染；这里只吞掉 feedback.start 的 rethrow。
  });
  ```
  走 `docs/ui-ux-spec.zh-CN.md` §4.1 的转圈 → 对号；失败不显示对号；
- 「路径覆盖」保存成功后（`onSaved` 里触发，不套用刷新的转圈 → 对号）：
  - `void reload("save").catch(() => undefined)` 让状态立刻变为 `override`（`wsl_cli_status` 直接读设置，不强制重新探测）；刷新失败由页面级错误显示「已保存，但读取状态失败」，**不**归到行内的 `WSL_CLI_PATH_INVALID`（保存已经成功，路径本身没有错），也不回滚设置；
  - 若探测缓存已过 5 分钟 TTL，`ensure` 会按既有语义正常刷新一次，这不是保存动作触发的强制重探；
  - `invalidateWslEngineAvailability()` 让聊天页的引擎菜单同步；
  - 不清空输入框，不强制重探整个发行版（避免每次保存都付 2.4s 探测）；
- 「路径覆盖」保存失败：行内 `role="alert"`，输入框保留用户输入，状态卡保持原样，错误不上升到整页；
- 行内只放**保存校验**错误，页面级只放**状态读取**错误：两种事实不同，可以同时出现，但同一次失败不会重复显示。

### 5.6 路径覆盖复用

把 `WslSection.tsx` 里现有的 `OverrideRow` 抽成 `src/features/settings/WslEnginePathRow.tsx`：

```tsx
export function WslEnginePathRow({
  distro,
  engine,
  anchor,
  onSaved,
  onError,
}: {
  distro: string;
  engine: string;
  /** 页面内唯一：WSL 设置页用 `wslCliPath:<distro>:<engine>`，CLI 面板用 `cliWslPath:<engine>`。 */
  anchor: string;
  onSaved?: (distro: string) => void;
  onError: (message: string) => void;
}) {
  // 原有逻辑原样搬入：挂载读回 get_wsl_engine_paths、失焦且值有变化才
  // set_wsl_engine_path、空串删除覆盖、错误交给 onError。
}
```

- `WslSection` 改为使用该组件，anchor 保持 `wslCliPath:${distro}:${engine}`，现有测试与搜索锚点不变；
- `WslCliPanel` 使用 `anchor={`cliWslPath:${engine}`}`，并以 `key={`${distro}:${engine}`}` 挂载：切换发行版时重新读回该发行版的覆盖值，不残留上一个发行版的草稿；
- 两处共用同一套校验/保存/「未改动不写盘」逻辑，不复制第二份；输入框显式描边（`fieldClassName="border border-border-button-default"`）并带占位示例：暗色主题下输入框默认底色与卡片几乎同色，不描边就看不出这里可以填；
- 两个页面的常驻覆盖行仍有差异：`WslSection` 固定给 `claude/codex/pi`（探测不到也要能补），`WslCliPanel` 只给当前引擎。`kimi/minimax` 在 WSL 设置页要探测到才有行，在 CLI 面板则总有行——这是有意的（面板的引擎由用户当前打开的页签决定），本次不改 `WSL_OVERRIDE_ENGINES`，验收时按此确认；
- 不把组件做成通用 hook：发行版/引擎是动态行，hook 会被条件调用。

### 5.7 页头

`CliHeaderActions` 改为：

```tsx
export function CliHeaderActions({ engine }: { engine: EngineId }) {
  const scope = useCliScope(engine);
  // pending：上次选 WSL、元数据还没回来，先别让本机版本号闪出来。
  if (scope.pending || scope.active === "wsl") {
    return <CliDocsButton engine={engine} />;
  }
  return <HostCliHeaderActions engine={engine} />;
}
```

- `HostCliHeaderActions` 是现有实现（`useCliVersionStatus` / `useCliUpdateFlow` / 版本胶囊）原样搬入；
- `CliDocsButton` 只保留官方文档入口；
- 这样 WSL 作用域下不会对 Windows CLI 跑版本探测，也不会显示一个属于本机的「更新至 …」；
- 既有 `CliHeaderActions.test.tsx` 在本机作用域下应全绿；新增 WSL 作用域用例断言 `cliVersionStatus` 未被调用。

### 5.8 i18n

新增 `wsl.cli.*`，中英对称：

| key | 中文 | 英文 |
| --- | --- | --- |
| `wsl.cli.scope` | 作用域 | Scope |
| `wsl.cli.scopeHost` | 本机 Windows | This PC |
| `wsl.cli.scopeWsl` | WSL 发行版 | WSL distro |
| `wsl.cli.distro` | 发行版 | Distro |
| `wsl.cli.status` | CLI 状态 | CLI status |
| `wsl.cli.sourceProbe` | 自动探测 | Detected |
| `wsl.cli.sourceOverride` | 路径覆盖 | Path override |
| `wsl.cli.sourceMissing` | 未找到 | Not found |
| `wsl.cli.path` | CLI 路径 | CLI path |
| `wsl.cli.pathMissing` | 发行版内未检测到该 CLI | CLI not found in this distro |
| `wsl.cli.probed` | 上次探测 | Last probe |
| `wsl.cli.probedUnknown` | 未知 | Unknown |
| `wsl.cli.statusFailed` | 读取 CLI 状态失败：{{message}} | Could not read CLI status: {{message}} |
| `wsl.cli.statusStale` | 已保存，但读取状态失败：{{message}} | Saved, but reading the status failed: {{message}} |
| `wsl.cli.loading` | 正在读取发行版内的 CLI 状态… | Reading CLI status in this distro… |
| `wsl.cli.metaLoading` | 正在读取 WSL 信息… | Reading WSL information… |
| `wsl.cli.emptyTitle` | 发行版内未检测到 {{cli}} | {{cli}} not found in this distro |
| `wsl.cli.emptyDesc` | 可在上方填写发行版内的绝对路径，或安装后重新检测。 | Set an absolute path above, or install it and rescan. |
| `wsl.cli.channelsGlobal` | 供应商渠道为应用级，本机与 WSL 发送共用同一套渠道。 | Provider channels are app-level and shared by host and WSL sends. |
| `wsl.cli.manageChannels` | 切回本机管理 | Manage on This PC |
| `wsl.cli.officialDesc` | 发行版内的官方配置文件；可在发行版内直接编辑。 | The CLI's own config file inside the distro; edit it there. |
| `wsl.cli.copyPath` | 复制路径 | Copy path |
| `wsl.cli.metaFailed` | 无法读取 WSL 信息：{{message}} | Could not read WSL information: {{message}} |
| `wsl.cli.retry` | 重试 | Retry |
| `wsl.cli.editTitle` | 编辑 {{name}} 官方配置（发行版内） | Edit {{name}} official config (in the distro) |
| `wsl.cli.secretBadge` | 密钥 | secret |
| `wsl.cli.fileMissing` | 文件不存在，保存时创建 | The file does not exist; saving will create it. |
| `wsl.cli.fileTooLarge` | 配置文件过大（{{name}}），上限 256 KiB；请在发行版内编辑。 | The config file is too large ({{name}}); the limit is 256 KiB. Edit it inside the distro. |
| `wsl.cli.configConflict` | 发行版内的 {{name}} 已被修改；请重新读取后再保存。 | {{name}} was modified inside the distro. Read it again before saving. |
| `wsl.cli.configInvalid` | 配置内容校验失败：{{message}} | Invalid config content: {{message}} |
| `wsl.cli.configWriteFailed` | 写入发行版内配置失败：{{message}} | Could not write the config inside the distro: {{message}} |
| `wsl.cli.configReadFailed` | 读取发行版内配置失败：{{message}} | Could not read the config inside the distro: {{message}} |
| `wsl.cli.reRead` | 重新读取 | Read again |

复用现有键：`wsl.rescan`、`wsl.cliPathFor`、`wsl.cliPathDesc`、`wsl.cliPathPlaceholder`（新增）、`wsl.cliPathInvalid`、`wsl.cliPathReason.*`、`settings.cliOfficial`、`settings.cliChannels`、`wsl.error.*`，以及 `relativeTime` 已经在用的 `time.now` / `time.minutes` / `time.hours` / `time.days`。

### 5.9 搜索与锚点

本次**不新增**设置搜索条目：

- 搜索索引测试会逐个渲染 `PAGES`（CLI 页渲染的是 `CliConfigBody`，不是 `CliConfigSection`），而 WSL 面板只有在作用域切换后才存在；
- 若把 WSL 面板行声明为 `cli:<engine>` 的搜索项，测试会要求它在 `CliConfigBody` 里渲染，与条件渲染冲突；
- 作用域本身是页内路由，不是「设置行」；先用页面标题 + 作用域控件可见性保证可发现性。

`WslEnginePathRow` 的 anchor 只用于未来可能的搜索/闪烁，不注册索引；WSL 设置页仍保持 `wslRescan` 一个索引项。

### 5.10 ui-ux 规范同步

同一个提交内更新 `docs/ui-ux-spec.zh-CN.md`：

1. §3 增加「CLI 管理的 WSL 作用域只读」规则：可见条件、全局作用域、页头隐藏本机版本、渠道与引擎启停均为应用级、本次不提供配置/认证写入；
2. §7 刷新入口清单新增一行：
   - 入口：CLI 管理 → WSL 重新检测；
   - 文件：`src/features/settings/WslCliPanel.tsx`；
   - 反馈：`useActionFeedback({ spin: true })`；
   - 备注：只重探当前发行版；与「设置 → WSL」的 `wslRescan` 是两个页面/两个锚点，互不复用；
3. 版本表追加 `v0.90 | 2026-10-23 | ...`，写明作用域、只读状态、页头行为与 §7 登记。

---

## 6. 测试与验收

### 6.1 Rust

`cargo test --lib wsl`：

- `supported_engines_follow_config_order`：结果正好是 `["claude", "kimi", "codex", "pi", "minimax"]`；
- `statuses_include_supported_engines_even_when_missing`：探测只有 claude，仍返回 5 行，其余 `source = missing`；
- `probe_source_maps_mcode_to_minimax`：`__CCGUI__BIN mcode=…` + `__CCGUI__VER mcode=0.4.2` → `engine = minimax`、`version = 0.4.2`；
- `override_wins_without_borrowing_probe_version`：探测到 claude 2.1.280，同时设置覆盖 → `source = override`、`bin = 覆盖值`、`version = None`；
- `missing_rows_have_no_bin_or_version`；
- `probe_age_is_carried_to_every_row`：传入 `Some(42)`，所有行一致；
- `invalid_distro_is_rejected_before_probing`：`checked_distro("..")` 返回 `WSL_DISTRO_NOT_FOUND`；
- `settings_error_yields_no_overrides`：`overrides_or_empty(Err(..), distro)` 返回空覆盖且不 panic，再用 `statuses` 喂空覆盖验证仍按探测结果出行；
- `config_paths_default_to_home_dirs` / `config_paths_follow_distro_env`：官方配置路径按 `$HOME` 与发行版内 `CLAUDE_CONFIG_DIR` / `CODEX_HOME` / `KIMI_CODE_HOME` / `PI_CODING_AGENT_DIR` 计算，minimax 为 `None`；
- `capabilities_match_supported_engines`。

官方配置读写（同模块）：

- `config_targets_follow_whitelist_and_env`：claude/codex/kimi 的白名单路径随发行版内 `*_HOME` 环境变量走，codex `auth` 标记 secret，pi/minimax 无目标；
- `validate_rejects_malformed_content`：JSON 必须是对象、TOML 必须可解析，非法内容不落盘；
- `parse_config_read_roundtrip` / `parse_config_read_marks_too_large` / `parse_config_read_rejects_incomplete_output`：存在/缺失/超限/输出不完整的哨兵解析；
- `write_script_checks_conflicts_before_writing`：冲突检查在写入之前，脚本永远 `exit 0`；
- `parse_config_write_reports_conflict_first`：冲突/写入失败/写入计数三类输出。

`cargo test --test wsl_boundary_guard`：

- 新模块不得出现 `wsl.exe` / `wsl.localhost` / `wsl$`；
- 允许清单不变。

`cargo test --lib wsl_availability`：

- 现有菜单测试改为调用 `wsl_cli::supported_engine` 后仍全绿；
- `available_engines` 的覆盖优先、`mcode` 映射、版本映射测试不变。

### 6.2 前端

**测试环境前提（必须先满足，否则 WSL 分支会「假绿」）**

- jsdom 没有 `__TAURI_INTERNALS__`，`isWeb` 是模块加载时的常量 `true`；`IS_WINDOWS` 读 `navigator.userAgent`，在 jsdom 里也是假。因此 `useCliScope` 默认不加载元数据、不渲染作用域，**现有测试自然全绿并不代表 WSL 分支被测到**。
- 覆盖桌面分支时用 `vi.mock("@/lib/platform", ...)` 提供 `IS_WINDOWS: true`、`isWeb: false`，或在 import 前同时 mock `@/lib/transport`（`isWeb` 从那里 re-export）。只改 `navigator.userAgent` 无效，只改其中一个常量也不够。
- 用例之间清理 `ccgui-next.cliScope:v1` / `ccgui-next.wslCliDistro:v1`；模块级 store 用 `vi.resetModules()` + 动态 `import()` 隔离（与现有模块级 store 测试同一做法）。
- `SettingsPage.test.tsx` 的 ipc Proxy 对未知方法返回 `null`：元数据加载要按 `Array.isArray` 兜底，别把 `null` 灌进快照（否则真实页面也会因为后端返回异常形状而崩）。

`pnpm exec vitest run` 相关文件（设置页用例较重，建议加 `--no-file-parallelism` 逐个跑，避免相互争用导致超时）：

**`use-cli-scope.test.ts`（新增，store 单测）**

- 默认 `host`；`setScope("wsl")` 自动选第一个发行版并写两个 localStorage 键；
- 作用域全局：换引擎后仍保持 WSL；
- 已记忆的发行版不在列表 → 回退第一个并写回；
- 列表为空 → 回落 `host` 并清除两个键；
- 元数据失败 → `ready = true`、`metaError` 有值、`visible = false`；**失败不缓存**，下一次读取会立刻重试；
- `engines` 不含当前引擎 → `visible = false`、`active = "host"`；
- 并发读取 single-flight，只调用一次 IPC；
- 首个订阅者触发元数据读取；
- `getSnapshot` 在无更新时返回同一引用。

**`CliConfigSection.test.tsx`（新增，作用域可见性与切换）**

- jsdom 需要 `ResizeObserver` stub（`PillTabList` 用它测量选中滑块，参照 `builtin-search.test.tsx`）；
- 先按上面的前提模拟桌面 Windows；
- 桌面 Windows + 有发行版 + 引擎受支持 → 渲染作用域；
- 本机作用域：调用 `getCliConfig`，不调用 `wslCliStatus`；
- WSL 作用域：不调用 `getCliConfig`，调用 `wslCliStatus` 并显示面板；
- 引擎不受支持 → 不渲染作用域，显示本机页；
- 元数据失败且记忆为 WSL → 显示错误 + 重试，仍回落到本机页。

**`WslCliPanel.test.tsx`（新增）**

- 显示路径/版本/来源徽标、官方配置路径；`source = override` 时版本显示 `—`；
- 引擎启停卡渲染，点击开关调用 `setEngineEnabled(engine, false)`；
- 渠道卡说明应用级并提供「切回本机管理」；
- 「重新检测」调用 `wslReprobe(distro)` 并重读状态；探测成功但状态读取失败时显示错误、不显示对号；
- 路径覆盖保存失败显示行内本地化错误；
- **保存成功但 `reload()` 失败**：页面级显示 `wsl.cli.statusStale`（不是行内「路径无效」），设置不回滚；
- 官方配置编辑：打开弹窗读白名单文件、保存带 `expectedHash` 调用 `wslCliConfigWrite`、冲突显示「重新读取」入口、`editableEngines` 之外的引擎不出现编辑按钮。

**`CliHeaderActions.wsl.test.tsx`（新增）**

- WSL 作用域只渲染文档按钮，`cliVersionStatus` 未被调用。

**`CliHeaderActions.test.tsx`（保持）**

- 本机作用域既有 4 个用例全绿。

**`WslSection.test.tsx`（更新）**

- 抽取 `WslEnginePathRow` 后，现有路径覆盖保存/读回用例全绿；
- 「重新检测」仍调用 `wslReprobe()` 并刷新徽标。

**`builtin-search.test.tsx`**

- 不新增条目，现有「CLI 页声明与渲染一致」用例不变。

**构建**

- `pnpm build`：TypeScript 类型检查与前端构建。

### 6.3 实机矩阵（Windows + WSL2）

| 场景 | 预期 |
| --- | --- |
| Ubuntu-24.04 已装 claude/codex/pi | 三个 CLI 页都能看到正确路径/版本；pi 版本为实际版本 |
| 只装其中一个 | 其余页显示「未找到」空态，路径覆盖可用 |
| 设置覆盖路径 | 保存后来源立即变「路径覆盖」，版本 `—`；清空后回到探测 |
| 覆盖成非绝对路径 / `/mnt/...` | 行内报本地化原因，文件不变 |
| `wsl --shutdown` 后打开 WSL 作用域 | 页面级错误；点「重新检测」立即重探（不被 10 秒负缓存挡住），可恢复 |
| 保存覆盖成功后立刻在设置里手工改坏 `settings.json` | 保存已成功；刷新失败提示「已保存，但读取状态失败」，不显示为路径无效 |
| 切到不受支持的引擎页（grok/omp/dsh） | 不出现作用域控件，页面与本机一致 |
| 本机侧停用某引擎后打开它的 WSL 作用域 | 状态仍可查看；面板说明启停为应用级；发送被既有门禁拒绝，不出现「WSL 能绕过停用」的错觉 |
| 切到 Web 访问端 | 不出现作用域控件 |
| 在 WSL 设置页点「重新检测」后再回 CLI 页 | 新发行版/新 CLI 出现在作用域里（不必重启） |
| 路径覆盖保存后回聊天页 | composer 引擎菜单同步（`invalidateWslEngineAvailability`） |
| WSL 面板切换引擎启停后回本机作用域 | 本机页的开关同步（同一个 `config.enabled`） |
| 官方配置路径 | Claude / Codex / Pi / Kimi 显示发行版内实际路径；复制按钮可复制 |
| 点「切回本机管理」 | 作用域切回本机，完整的供应商渠道卡可见 |

### 6.4 验收清单

**后端**

- [ ] `wsl_cli_status` 只返回受支持引擎，顺序稳定；
- [ ] 覆盖优先、探测次之、都没有为 `missing`；
- [ ] `minimax` 的 `mcode` 版本映射正确；
- [ ] 非法发行版在探测前被拒绝；
- [ ] 设置文件损坏时仍返回探测状态，不整页失败；
- [ ] `wsl_boundary_guard` 全绿；
- [ ] 不新增 `wsl.exe` 调用（代码评审确认）。

**前端**

- [ ] 默认本机，本机页签行为/测试零回归；
- [ ] WSL 作用域只在桌面 Windows + 发行版 + 受支持引擎时出现；
- [ ] 切换 WSL 不调用 `getCliConfig`；
- [ ] 状态、空态、错误、发行版关停都有明确文案，不出现裸退出码；
- [ ] 状态读取失败、路径保存失败、保存成功但刷新失败是三种不同提示，互不冒充；
- [ ] 路径覆盖复用 `set_wsl_engine_path`，失焦且有变化才写盘；
- [ ] 重新检测走转圈 → 对号，失败不出对号；失败后再次点击能真正重探；
- [ ] 页头在 WSL 作用域不显示本机版本/更新；
- [ ] WSL 面板提供引擎启停（写同一个 `config.enabled`）、官方配置文件路径（可复制）与「切回本机管理」渠道入口；
- [ ] 渠道与引擎启停为应用级，WSL 面板不提供第二套开关；
- [ ] Web 端、非 Windows 完全不出现作用域；
- [ ] WSL 分支的测试显式模拟桌面（不是靠 jsdom 默认 `isWeb` 假绿）；
- [ ] `pnpm build` 与相关 vitest 全绿。

---

## 7. 改动范围

| 范围 | 内容 | 文件 | 验证 |
| --- | --- | --- | --- |
| 后端 | 只读状态底座：能力表 + 状态查询 + 单测；支持引擎白名单收敛；探测脚本补 `KIMI_CODE_HOME` | `src-tauri/src/engine/wsl_cli.rs`（新）、`engine/mod.rs`、`engine/wsl_availability.rs`、`engine/wsl_probe.rs`、`lib.rs` | `cargo test --lib wsl`、`cargo test --test wsl_boundary_guard` |
| 前端 | 作用域切换、只读面板、路径覆盖复用、页头、i18n、ui-ux 登记 | `CliConfigSection.tsx`、`HostCliConfig.tsx`（新）、`CliScopeSwitch.tsx`（新）、`use-cli-scope.ts`（新）、`WslCliPanel.tsx`（新）、`use-wsl-cli-status.ts`（新）、`WslEnginePathRow.tsx`（新）、`WslSection.tsx`、`CliHeaderActions.tsx`、`src/lib/ipc.ts`、`src/i18n/{zh,en}.ts`、`docs/ui-ux-spec.zh-CN.md`、测试（`use-cli-scope.test.ts`、`CliConfigSection.test.tsx`、`WslCliPanel.test.tsx`、`CliHeaderActions.wsl.test.tsx`，以及更新 `CliHeaderActions` / `WslSection` / `SettingsPage` 相关用例） |

- 后端先落地不影响 UI：命令未被调用但有单测；前端依赖后端的契约；
- 本机**作用域内容**不变（`HostCliConfig` 只是搬移）；桌面 + 有发行版时顶部多一张作用域卡，Web/非 Windows/无发行版时 DOM 与现在一致；
- 实现顺序：后端 `wsl_cli.rs` 模块与纯函数 → 单测 → `engine/mod.rs` 导出 → `lib.rs` 注册 → 边界守卫；前端 `src/lib/ipc.ts` 类型 → `use-cli-scope` + store 单测 → 抽取 `WslEnginePathRow`（先让 `WslSection` 全绿）→ `use-wsl-cli-status` → `WslCliPanel` + 测试 → `HostCliConfig` 搬移 → `CliScopeSwitch` → `CliHeaderActions` → i18n → `pnpm build` → 实机矩阵；
- 不把未完成的面板露给用户：面板与入口在同一次改动里完成。

---

## 8. 风险与备选

| 风险 | 影响 | 缓解 | 备选 |
| --- | --- | --- | --- |
| 前后端支持引擎白名单漂移 | 作用域显示但后端没有该行 | 后端 `wsl_cli_capabilities` 是唯一来源，前端不硬编码 | 退回 TS 常量 + 双端测试（不推荐） |
| `wsl.exe -l -q` 首次读取慢 | 作用域晚出现 | 元数据 30 秒缓存 + single-flight；本机页先正常渲染 | 把列表并入 `wsl_probe_snapshot`（会扩大现有契约） |
| 元数据读取失败 | 作用域消失 | 本机页照常可用；记忆为 WSL 时显示错误 + 重试 | 允许手动输入发行版名（增加误输入面，不做） |
| 已记忆 WSL 但元数据未回 | 短暂空白 | `pending` 时显示加载行，不挂载 HostCliConfig | 先挂本机再切换（会多读一次主机配置，不推荐） |
| 设置文件损坏 | 覆盖丢失 | 仅记日志，继续返回探测状态 | 整页报错（会掩盖探测结果，不推荐） |
| 覆盖路径不存在 | 状态显示 override，发送失败 | 文档说明「覆盖只表示设置值」；发送时既有错误码可诊断 | 后续增加 `exists` 字段（需要额外短调用） |
| 重新检测两次 IPC | 多一次请求 | 第二次命中缓存，不重复探测 | 给 `wsl_cli_status` 加 `force`（扩大命令面，暂不做） |
| 本机页回归 | 公开仓库高风险 | `HostCliConfig` 原样搬移；`getCliConfig` 调用断言 | 给 `useCliConfig` 加 scope 参数（回归面更大，不做） |
| 页头仍显示本机版本 | 误导 | `CliHeaderActions` 在 WSL 作用域只保留文档按钮 | 页头也显示 WSL 版本（需要把状态提升到页头，后续再做） |
| 搜索找不到 WSL 行 | 可发现性下降 | 作用域控件在页面顶部；后续单独设计索引 | 为条件页面扩展搜索测试模型（成本高，暂不做） |
| jsdom 里 `isWeb` 恒为真 | WSL 分支默认不渲染，测试假绿 | store 单测 + 显式 mock 平台模块（§6.2）；验收单列一条 | 改 `navigator.userAgent`（无效，`isWeb` 是常量） |
| 探测失败后的 10 秒负缓存 | 用户点重试看起来没反应 | 面板把重试映射到 `wsl_reprobe`（先 `invalidate`） | 给 `wsl_cli_status` 加 `force` 参数（扩大命令面，不做） |
| 保存成功但状态刷新失败 | 用户误以为没保存 | 独立提示「已保存，但读取状态失败」，不回滚设置 | 回滚设置（错误：保存本身已经成功） |

---

## 9. 后续工作（本次不实现）

| 工作项 | 内容 | 关键依赖 | 契约增量 |
| --- | --- | --- | --- |
| Pi 认证 | Pi API Key / `models.json` 编辑：掩码、只写 key、模型菜单刷新 | 本次的文件服务；secret 单独评审 | 已实现（`docs/plans/2026-10-23-wsl-pi-auth.md`）：`authEngines` + `wsl_pi_*` 五命令 |
| WSL 终端与 OAuth | WSL 终端 + Pi/omp OAuth 登录 | 原方案的终端能力 | `capabilities.oauth` |
| 高级配置 | 每发行版自定义配置目录/模型、手动更新提示（minimax 状态已在本次实现） | 文件服务与 Pi 认证 | 每发行版设置键、`capabilities.update` |

渠道保持全局，不做每发行版渠道。后续的文件读写复用本次的 `wsl_cli_config_*` 与 `WslEnginePathRow`，不另造一套发行版选择器。

---

## 10. 待决问题

已决定：

1. **作用域/发行版是否全局记忆**：是；不按引擎分裂。
2. **是否显示不受支持的引擎**：否；由 `wsl_cli_capabilities` 决定，作用域不渲染。
3. **路径覆盖是否直接编辑状态卡**：独立行，复用 `WslEnginePathRow`，不放状态卡内联编辑。
4. **「重新检测」的 ui-ux 登记**：新增 §7 条目，与「设置 → WSL」的 `wslRescan` 区分页面/锚点，不共用。
5. **本次是否包含文件读写底座**：不包含；第一次需要写文件时再评审白名单/原子写/权限，避免无调用方的写入代码。
6. **本次是否提供搜索索引**：不提供；原因见 §5.9，后续若产品需要再扩展搜索测试模型。
7. **`probedAgoSecs` 是否可空**：保留 `Option`（并发 `invalidate` 兜底），前端按「未知」显示；`ensure` 成功后正常总有值。
8. **测试如何模拟桌面**：mock `@/lib/platform` / `@/lib/transport`，不改 UA；store 用 `vi.resetModules()` 隔离。
9. **WSL 设置页与 CLI 面板的覆盖行差异**：保留（见 §5.6），本次不统一 `WSL_OVERRIDE_ENGINES`。
10. **WSL 面板补齐到什么程度**：引擎启停直接复用应用级开关；官方配置白名单可读写（打开编辑器才读文件）；渠道不复制第二套 UI，只给「切回本机管理」。
11. **官方配置路径的来源**：优先发行版内环境变量（`CLAUDE_CONFIG_DIR` / `CODEX_HOME` / `KIMI_CODE_HOME` / `PI_CODING_AGENT_DIR`），否则 `$HOME` 下的默认目录。
12. **codex `auth.json` 是否可读**：与主机官方编辑器同级，允许读，标记密钥，写入 0600；内容不进日志/argv（base64 走 stdin 脚本）。
13. **`configFiles` 是否进 `WslCliStatus`**：不进；状态查询不付文件读取代价，打开编辑器时 `wsl_cli_config_read` 才读（带 `exists` 与 sha256，不带 mtime）。
14. **冲突处理**：`expectedHash` 不一致时整次写入放弃，提示「重新读取」，不覆盖、不写部分文件。

仍待产品/实现确认：

1. WSL 面板是否需要在状态卡里显示发行版名（作用域选择器已经显示，可能重复）；实现时按视觉评审决定。
2. 内置终端就绪后的 OAuth 登录是否复用宿主终端，还是只给「在 WSL 终端执行」的复制命令；依赖终端能力。

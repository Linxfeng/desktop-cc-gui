# WSL 作用域内的 Pi 供应商认证

- 日期：2026-10-23
- 基线：`main` @ `8ac0bf816`（WSL 作用域内官方配置白名单读写）
- 状态：已实现，Windows 11 + WSL2 实机验收通过（2026-10-23）
- 上游路线：`docs/plans/2026-10-23-wsl-cli-management.md` §9 的「Pi 认证」项、`docs/plans/2026-10-19-wsl-local-support.md` §11.4 的 Pi 认证 IPC 清单

---

## 0. 一页结论

CLI 管理页切到 WSL 作用域后，Pi 页签新增「供应商认证」区块：

- **API Key**：provider 目录浏览、设置/替换/删除 key；key 明文只在写入命令中出现一次，列表只回传掩码；
- **自定义供应商**：发行版内 `models.json`（JSONC）的整篇编辑与 provider 块内联编辑，保存后聊天页模型菜单即时刷新；
- **订阅授权（OAuth）**：只读状态 + 明确降级说明（在发行版内终端执行 `pi /login <arg>`），不渲染点了无效的登录按钮。

后端把 `pi_family_auth.rs` 的解析/掩码/合并抽成路径无关纯函数，主机实现改调它们（行为不变）；WSL 侧复用 `wsl_cli.rs` 既有的白名单读/写脚本与冲突检测，新增 5 个 `wsl_pi_*` 命令。密钥处理规则沿用既有契约：不进日志、不进 argv、secret 文件 0600、冲突不覆盖。

**本次明确不做**

- 不做 OAuth 登录的宿主代跑（依赖 WSL 内置终端，后续里程碑）；
- 不做 omp 的 WSL 认证（omp 不在 WSL 可运行引擎白名单内）；
- 不给 pi 开放通用 `wsl_cli_config_read/write` 编辑器（会把 auth.json 明文送进 webview）；
- 不做每发行版渠道（渠道保持应用级，既有决定）。

---

## 1. 问题与目标

主机侧 pi/omp 有完整的「供应商认证」区块（`PiFamilyAuthSection`：订阅授权 / API Key / 自定义供应商三组）。WSL 作用域的 Pi 页签目前只有官方配置路径展示与 CLI 状态：用户在发行版里用 pi 时，API Key 与自定义供应商仍要进终端手工编辑 `auth.json` / `models.json`。

| 编号 | 目标 | 验收方式 |
| --- | --- | --- |
| G1 | WSL 作用域 Pi 页签可查看/设置/删除 API Key，列表只有掩码 | Rust 单测 + 实机 |
| G2 | 发行版内 `models.json` 可整篇编辑与 provider 块内联编辑，JSONC 注释保留 | 单测 + 实机 |
| G3 | 保存后聊天页模型菜单即时刷新（WSL 工作区的远程 catalog 重探） | 前端测试 + 实机 |
| G4 | OAuth 状态只读展示 + 降级说明，无假登录按钮 | UI 评审 |
| G5 | 主机侧 `PiFamilyAuthSection` 行为零回归 | 既有 vitest 全绿 |
| G6 | 密钥契约：掩码跨 IPC、0600、冲突不覆盖、损坏 fail-closed | Rust 单测 + 实机 |

## 2. 设计前提核对

| 事实 | 位置 | 对本设计的意义 |
| --- | --- | --- |
| `wsl_cli.rs` 的读/写脚本按 `ConfigTarget {key,dir,file,format,secret}` 驱动，格式字段是自由字符串 | `wsl_cli.rs` | pi 的 target 直接复用同一套脚本与哨兵解析，`format: "jsonc"` 不影响脚本 |
| `config_targets` 对 pi 返回空 → 通用编辑器对 pi 返回 `WSL_CLI_CONFIG_UNSUPPORTED` | `wsl_cli.rs` | 通用编辑器天然对 pi 关闭；pi 走专用命令，两套入口互不越界 |
| 探测结果含 `pi_agent_dir`（`$PI_CODING_AGENT_DIR`，空则回退 `$HOME/.pi/agent`） | `wsl_probe.rs` | pi target 的目录来源 |
| `pi_family_auth.rs` 的掩码（head6+tail4）、key 校验、oauth 拒删、JSONC 剥注释、models 校验都是路径无关逻辑 | `pi_family_auth.rs` | 抽成纯函数后两端共用 |
| 主机 `PiFamilyApiKeySection` / `PiFamilyCustomSection` / `PiFamilyOauthSection` 是纯展示组件（state 全在父 hook） | `PiFamilyAuthSection.tsx` | 换数据源不需复制 UI |
| `CLI_CONFIG_CHANGED_EVENT` 目前只让聊天页重读渠道配置与自定义模型，不重探 catalog | `use-engine-models.ts` | 「模型菜单刷新」需要事件带引擎标识并触发重探 |
| WSL pi 的模型菜单回退读发行版内 `models.json`（`models/wsl.rs`），与本机 `models_from_config_text` 同一解析 | `models/wsl.rs` | 编辑保存后重探即可拿到新目录，无需新解析 |
| 通用写脚本已做：冲突先检查、`umask 077`、同目录 tmp + mv、secret 0600、非 secret 沿用原权限 | `wsl_cli.rs` | pi 写入自动继承，不新增脚本机制 |

## 3. 后端设计

### 3.1 `pi_family_auth.rs` 抽纯函数

从文件 IO 中抽出路径无关逻辑（`pub(crate)`），主机命令改调它们，行为与既有单测不变：

- `parse_auth_store(text) -> Result<Map<String,Value>, String>`：JSON 对象解析，损坏报 `[PI_FAMILY_AUTH_CORRUPTED]`（fail-closed）；
- `auth_snapshots(map) -> (Vec<AuthProviderSnapshot>, Vec<String>)`：provider 快照（掩码）+ oauth provider 列表；
- `apply_set_api_key(map, provider_id, key) -> Result<(), String>`：目录校验 + oauth-only 拒写 + 空串/换行拒收；
- `apply_delete_credential(map, provider_id) -> Result<bool, String>`：oauth 凭据拒删；无该条目返回 false（无事可做）；
- `summarize_providers` 与 `PI_MODELS_TEMPLATE_JSON` 转为 `pub(crate)`。

### 3.2 `wsl_cli.rs` 新增命令

```rust
/// pi 的白名单 target —— 只供 wsl_pi_* 命令使用；
/// 通用 config_targets 对 pi 保持为空（通用编辑器会把 auth.json 明文送进 webview）。
fn pi_targets(probe: &WslProbe) -> Vec<ConfigTarget> {
    let dir = /* probe.pi_agent_dir 非空取之，否则 $HOME/.pi/agent */;
    vec![
        ConfigTarget { key: "auth",   dir, file: "auth.json",  format: "json",  secret: true },
        ConfigTarget { key: "models", dir, file: "models.json", format: "jsonc", secret: false },
    ]
}

#[tauri::command] pub async fn wsl_pi_auth_list(distro: String) -> Result<AuthListResult, String>;
#[tauri::command] pub async fn wsl_pi_auth_set_key(distro: String, provider_id: String, key: String) -> Result<(), String>;
#[tauri::command] pub async fn wsl_pi_auth_delete(distro: String, provider_id: String) -> Result<(), String>;
#[tauri::command] pub async fn wsl_pi_models_read(distro: String) -> Result<WslPiModelsRead, String>;
#[tauri::command] pub async fn wsl_pi_models_write(distro: String, text: String, expected_hash: Option<String>) -> Result<(), String>;
```

`WslPiModelsRead` 形状与主机 `ModelsConfigReadResult` 对齐（`file/text/template/providers/parseError`），外加 `hash`（冲突检测用）。`AuthListResult` 直接复用 `pi_family_auth` 的类型——两端的列表形状一致，前端组件无需两套类型。

**读**（`auth_list` / `models_read`）：一次短调用，`config_read_script` 按需只含目标文件；`parse_config_read` 解码后：

- `auth_list`：`parse_auth_store` → `auth_snapshots` → 掩码列表 + oauth 列表。文件缺失 = 空店（全部 none）；损坏 = 报错（fail-closed，与主机一致）。**掩码之后的结构体才跨 IPC，原文 key 不出 Rust。**
- `models_read`：文本原样返回（用户自己的配置文本，注释保留；`apiKey` 字段可能是 `$ENV`/`!command` 引用，不属于凭据存储的机密边界——与主机同规则），附 providers 摘要与 parse_error。

**写**（`auth_set_key` / `auth_delete` / `models_write`）：

- 写前校验：`models_write` 过 `validate_models_config_text("pi", text)`；auth 的合并结果序列化后是合法 JSON 对象；
- 冲突检测：`models_write` 带 `expected_hash`；auth 写是「读-改-写」（读当前 auth.json → Rust 内合并 → 带 hash 写回），两个短调用之间的外部修改会被 `expectedHash` 拦下报 `WSL_CLI_CONFIG_CONFLICT:auth`，前端提示重试，不覆盖；
- 写脚本复用 `config_write_script`：secret 0600、非 secret 沿用原权限、原子替换、失败保留原文件。

### 3.3 能力表

`WslCliCapabilities` 增量字段：

```rust
/// 发行版内供应商认证可管理的引擎。pi 的 auth/models 在白名单内；
/// omp 不在 WSL 可运行引擎里，不出现。
pub auth_engines: Vec<String>,   // ["pi"]
```

只做增量，不改既有字段语义；前端据此渲染认证区块，不硬编码引擎名。

### 3.4 错误契约

| 情况 | 错误 | 前端 |
| --- | --- | --- |
| auth.json 损坏 | `[PI_FAMILY_AUTH_CORRUPTED] …` | 列表区 `role="alert"`，与主机同形态；不覆盖原文件 |
| 未知 provider / oauth-only / 空 key | `[PI_FAMILY_AUTH_*]` | 编辑器行内 alert（主机同款透传） |
| 删除 oauth 凭据 | `[PI_FAMILY_AUTH_OAUTH_MANAGED]` | 行内 alert，提示在发行版内 `pi /logout` |
| 读写期间发行版侧修改 | `WSL_CLI_CONFIG_CONFLICT:auth` | 已有本地化文案「已被修改」 |
| 校验失败不落盘 | `WSL_CLI_CONFIG_INVALID_JSON` / 既有 models 错误 | 已有映射 |

`pi_family_auth` 的错误串按主机现状原样透传（主机 UI 也是原样展示），不新造错误码。

### 3.5 注册

- `lib.rs` 注册 5 个 `wsl_pi_*` 命令；
- 不进 `web/dispatch.rs`（桌面能力，与 `wsl_cli_*` 同规则）。

## 4. 前端设计

### 4.1 状态 hook 抽取

`PiFamilyAuthSection.tsx` 的 `usePiFamilyAuthState` 抽到 `usePiFamilyAuth.ts`，IPC 调用收敛为一个后端适配器参数：

```ts
interface PiFamilyAuthBackend {
  list(): Promise<PiFamilyAuthListResult>;
  setKey(providerId: string, key: string): Promise<void>;
  deleteCredential(providerId: string): Promise<void>;
  modelsRead(): Promise<PiFamilyModelsConfigReadResult>;
  modelsWrite(text: string): Promise<void>;
}
```

- 主机适配器包 `ipc.piFamily*`；WSL 适配器包 `ipc.wslPi*`（固定 `distro`，`modelsWrite` 附读时 hash）;
- 登录启动改为回调参数 `onLaunchLogin`（主机传现实现；WSL 不渲染登录按钮，传 no-op）;
- provider 块编辑辅助（`piFamilyModelsBlocks`）操作原始文本，两端共用不改;
- `PiFamilyAuthSection`（主机）行为不变，既有测试（`piFamilyCustomProviderEdit.test.tsx` 等）全绿。

### 4.2 `WslPiAuthSection`

新组件，组合既有展示组件：

- **订阅授权**：状态点复用列表里的 `oauthProviders`；登录按钮替换为降级说明：在发行版内启动 `pi` 后执行 `/login <arg>`（i18n 文案内插命令），不渲染无效按钮;
- **API Key** / **自定义供应商**：`PiFamilyApiKeySection` / `PiFamilyCustomSection` 原样复用，storePath 显示发行版内路径;
- 每次成功写入 `notifyCliConfigChanged("pi")`（见 4.3）。

### 4.3 模型菜单刷新

`CLI_CONFIG_CHANGED_EVENT` 升级为可带 `detail.engine`（`CustomEvent`）：

- `use-engine-models` 的事件处理器在收到带引擎的事件时，清除该引擎的已探标记并重探 catalog（pi 的探针是 `pi models --json` / `models.json` 回退，成本可控）；无 detail 时行为不变（只重读渠道配置）;
- 主机 `PiFamilyAuthSection` 的写入同样带上 `engine`——主机与 WSL 的「保存后菜单刷新」语义一致，且重探范围限定在 pi 一个引擎。

### 4.4 WslCliPanel 挂载

`engine === "pi"` 且 `authEngines` 含 `"pi"` 时，在官方配置卡与 CLI 状态卡之间渲染 `WslPiAuthSection`（对齐主机页的顺序：官方配置 → 认证区块）。发行版切换时随面板 key 重挂载。

### 4.5 i18n

新增（中英对称）：`wsl.cli.piAuthOauthHint`（降级说明，含命令插值）。

复用既有键：`settings.piAuth*` 全套（标题/状态/确认/编辑器文案）、`wsl.cli.configConflict` 等。

## 5. 测试与验收

### 5.1 Rust

- `pi_family_auth`：既有单测不改语义全绿（纯函数抽取的行为保持）；
- `wsl_cli`：
  - `pi_targets_follow_agent_dir`：`$PI_CODING_AGENT_DIR` 与 `$HOME` 回退两条路径；
  - `parse_auth_store` / `apply_set_api_key` / `apply_delete_credential`：掩码列表、oauth 保留、oauth-only 拒写、拒删、损坏 fail-closed（复用主机的断言形态）；
  - `models_read_validate_jsonc`：注释保留、校验失败报 parse_error；
  - 通用 `config_targets` 对 pi 仍为空（编辑器越界回归）。

### 5.2 前端

- 既有 `PiFamilyAuthSection` / `piFamilyCustomProviderEdit` / `CliConfigBody` 用例全绿（hook 抽取无回归）；
- `WslPiAuthSection`：列表掩码渲染、设置 key 调 `wslPiAuthSetKey`、删除带确认、models 编辑保存带 hash、OAuth 无登录按钮只有说明；
- `use-engine-models`：带引擎的变更事件触发该引擎重探。

### 5.3 实机矩阵（Windows + WSL2）

| 场景 | 预期 |
| --- | --- |
| 发行版内已有 auth.json（含 oauth 条目） | API Key 列表正确掩码；oauth provider 出现在订阅授权 |
| 设置 anthropic key | 发行版内 `cat auth.json` 可见新条目，原 oauth/未知条目保留，权限 0600 |
| 删除 key | 条目移除，oauth 条目不动；聊天页 pi 模型菜单重探 |
| 删除 oauth 凭据 | 拒绝并提示在终端 `pi /logout` |
| models.json 整篇编辑（含注释） | 保存后注释保留；模型菜单出现新 provider 模型 |
| models.json 内联改 baseUrl | 仅该字段变化，块结构不破坏 |
| models.json 写入非法结构 | 拒绝保存，原文件不变 |
| 保存期间在发行版内手工改文件 | 冲突提示「已被修改」，可重新读取，不覆盖 |
| auth.json 手工改坏 | 列表区报错（fail-closed），不覆盖 |
| 主机侧 pi 认证区块 | 行为与此前一致（回归） |

## 6. 风险与备选

| 风险 | 影响 | 缓解 | 备选 |
| --- | --- | --- | --- |
| auth 读-改-写跨两次短调用，窗口内发行版侧改动 | 覆盖丢失 | `expectedHash` 冲突检测，前端提示重试 | 单脚本内 shell 合并（复杂度高，不做） |
| 掩码逻辑漂移（两端各一份） | 泄密面或显示不一致 | 纯函数共用一份，主机测试覆盖 | — |
| 事件重探范围过大 | 每次设置保存都拉起多个 CLI | detail 只带 pi；无 detail 行为不变 | 全引擎重探（不做） |
| JSONC 注释在整篇编辑后丢失 | 用户配置被静默改写 | 文本原样保存（verbatim），不 round-trip 解析 | 结构化编辑（成本高，不做） |
| models.json 内 `apiKey` 字面量回传前端 | 机密泄漏面 | 与主机同规则：该字段是用户自己的配置文本（`$ENV`/`!command` 常见），auth 存储的 key 才是机密边界 | models 文件也掩码（会破坏编辑功能，不做） |

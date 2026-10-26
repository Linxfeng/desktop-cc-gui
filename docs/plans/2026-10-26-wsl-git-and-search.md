# WSL 工作区的 Git 面板与全文搜索

- 日期：2026-10-26
- 基线：`main` @ `9b3caf6b3`（WSL 作用域内 Pi 供应商认证）
- 状态：已实现，Windows 11 + WSL2 实机验收通过（2026-10-26）
- 上游路线：`docs/plans/2026-10-19-wsl-local-support.md` §6 阶段 2 第 1 项（Git）与第 3 项（全文搜索）、§3 V24/V23 实测结论

---

## 0. 一页结论

WSL 工作区的 Git 面板与全文搜索目前在主机侧执行：`git2` 对 `\\wsl.localhost\…` 要么被 Git 的所有权校验拒绝（V24），要么慢到不可用（UNC 遍历两个数量级于发行版内，V19/V23）。本方案把这两条链路改为**在发行版内执行**：

- 新增 `src-tauri/src/git_wsl.rs`：用 `git -C <repo root>` 实现面板需要的全部命令（status / diff / stage / unstage / discard / commit / push / pull / branches / checkout / create branch）与文件树装饰（`git_tree_status`）；
- `git.rs` 的 Tauri 命令按工作区路径分派：WSL UNC → `git_wsl`，其余原路径不变；
- `files.rs::search_text` 增加 WSL 分支：发行版内 `rg --json`，拿不到 `rg` 时回退既有 UNC 遍历（慢但可用）；
- 前端零改动：IPC 形状保持不变，文件树徽标、Git 面板、差异页签直接生效。

**本次明确不做**

- 不做 WSL 的 worktree 子系统（`git_worktree_*` 仍只在主机路径上工作，`git_branch_merged` 同在此范围）；
- 不在 Web 访问端暴露 WSL Git（与既有「Web 端不支持本机 WSL」的决定一致，dispatch 显式拒绝）；
- 不覆盖 `workspace_vcs_metadata`（插件工作区元数据）——WSL 工作区继续返回 `None`；
- `git_file_colors` / `git_repository_summaries` 保持 host-only：前端文件树实际消费的是 `git_tree_status`，这两个旧 IPC 只有 Web/测试入口，WSL 路径下沿用既有的空结果，不另做发行版实现；
- 合并冲突（porcelain `u` 记录）按主机现状不单独展示，不新增冲突解决 UI；
- 不改 `git2` 主机路径的任何行为。

---

## 1. 问题与目标

| 现象 | 现状 | 证据 |
| --- | --- | --- |
| WSL 工作区的 Git 面板 | `git_status` 走 `Repository::discover(\\wsl.localhost\…)`，所有权校验拒绝或极慢，面板显示原始错误串 | V24：Windows `git.exe -C \\wsl.localhost\…` 报 `dubious ownership`，2.8s；WSL 内 `git` 33ms |
| 文件树徽标（M/A/仓库蓝标） | `git_tree_status` 同上，失败后静默为空 | 同一根因 |
| 全文搜索 `search_text` | 主机侧 `read_dir` 递归遍历 UNC（自研 walker，非 `rg`） | V23：UNC 遍历 1397ms vs 发行版内 `rg --files` 75ms |
| ack 之后的搜索能力 | `search_text` 目前没有前端调用方（仅 IPC/Web 暴露），但它是插件与 Web 端的既有能力，路径同样要正确 | `src/lib/ipc.ts` 无消费者 |

**目标**

| 编号 | 目标 | 验收 |
| --- | --- | --- |
| G1 | WSL 工作区的 Git 面板可读：分支、ahead/behind、staged/unstaged/untracked、行统计、差异预览 | Rust 单测 + 实机 |
| G2 | 变更操作可用：stage / unstage / discard / commit / push / pull / checkout / create branch | 单测 + 实机 |
| G3 | 文件树徽标与仓库摘要可用 | 单测 + 实机 |
| G4 | `search_text` 在 WSL 工作区返回正确结果，且走发行版内 `rg`；无 `rg` 时回退 UNC 且不报错 | 单测 + 实机 |
| G5 | 主机路径零回归；Web 端不因本方案获得 WSL Git 能力 | 既有测试 + 边界测试 |
| G6 | 错误可诊断：非仓库、缺 git、认证失败、冲突各有稳定错误码与文案 | 实机 |

## 2. 设计前提核对（实测）

| 事实 | 依据 | 意义 |
| --- | --- | --- |
| 发行版内有 `git` 2.43 | 实机 `git --version` | 不依赖主机 git，也不需要额外安装 |
| `git status --porcelain=v2 --branch -z` 输出 `# branch.oid/head/upstream/ab` + `1/2/?` 记录；rename 记录的两段路径以 NUL 分隔 | 实机探针（/tmp 临时仓库） | 分支、ahead/behind 与逐文件状态一次调用拿全 |
| `git diff --numstat -z` 的 rename 记录是 `add\tdel\t\0old\0new` | 同上 | 行统计解析要处理双 NUL 字段 |
| `git diff --no-index /dev/null <file>` 可为 untracked 文件生成带 `+` 行的补丁（有差异时退出码 1） | 同上 | 差异预览与主机侧「untracked 也出补丁」语义对齐 |
| `git status` 的 porcelain 路径相对仓库根，与 cwd 无关 | 实机 | 与主机 `git2` 的 status 路径语义一致，前端无需适配 |
| `wsl_index` 已建立「发行版内 rg + 哨兵前缀 + RG_MISSING 回退」模式 | `engine/wsl_index.rs` | 全文搜索复用同一形态 |
| `run_script_output` 固定 30s deadline，脚本失败统一成 `WSL_SHORT_CALL_FAILED` | `engine/wsl_transport.rs` | git 需要自己的错误哨兵与更长的网络超时 |
| 边界守卫已预留 `git_wsl.rs` | `tests/wsl_boundary_guard.rs` | 新模块不引入平台字面量，无需改允许清单 |
| `web/dispatch.rs` 已暴露全部 git 命令 | `web/dispatch.rs:1141+` | 需要显式拒绝 WSL 路径，否则 Web 端变相获得发行版 Git 权限 |

## 3. 架构与分派

```
前端（不变）
  └─ ipc.gitStatus / gitDiff / gitStage / … ─┐
                                             ▼
git.rs  Tauri 命令
  ├─ parse_wsl_unc(path)? ── 是 ──▶ git_wsl::*（async，发行版内 git）
  └─ 否 ──────────────────────────▶ 既有 git2 实现（spawn_blocking，不变）

files.rs::search_text
  ├─ parse_wsl_unc(path)? ── 是 ──▶ wsl_index::search（rg --json）
  │                                   └─ RG_MISSING ──▶ 回退既有 UNC 遍历
  └─ 否 ──────────────────────────▶ 既有实现
```

要点：

- 分派发生在**命令入口**，不在 UI 层：`git.rs` 的每条命令先判断路径形状，WSL 路径走异步实现，其余保持原同步实现与调用方式；
- `git_wsl` 只经 `wsl_transport`（`local_transport` + `run_script_output`）执行，模块内不出现 `wsl.exe` / UNC 字面量；
- 分派依据只有路径形状（`\\wsl.localhost\…` / `\\wsl$\…` / `\\?\UNC\…`）。插件登记的 SSH 远程工作区路径是 Linux 路径或 UNC + `meta.wsl`，UNC 形状的远程工作区会被本机接管——这与既有 `wsl_index`、文件索引的判定一致，不新增第二套规则。

## 4. 命令矩阵与解析

所有脚本都是「发行版内一次短调用」，**永远 `exit 0`**，结果走 stdout 哨兵（非零退出会被传输层统一成 `WSL_SHORT_CALL_FAILED`，丢掉 git 的真实错误）：

```
__CCGUI__GIT_ROOT <base64 仓库根>        # 解析后的 repo root
__CCGUI__GIT_NOT_REPO                     # 不在仓库内
__CCGUI__GIT_NO_GIT                       # 发行版内没有 git
__CCGUI__GIT_OUT <base64 主输出>          # 结构化数据（各命令不同）
__CCGUI__GIT_ERR <base64 stderr>          # git 失败时的原始 stderr
```

base64 用于路径/文本：路径可能含换行、空格、引号与中文，NUL 分隔字符串经传输层 lossy 解码不安全。

### 4.1 `git_status`

脚本：

```sh
cd -- <linux path> || { print NOT_REPO; exit 0; }
command -v git >/dev/null 2>&1 || { print NO_GIT; exit 0; }
root=$(git rev-parse --show-toplevel 2>/dev/null) || { print NOT_REPO; exit 0; }
printf '__CCGUI__GIT_ROOT %s\n' "$(printf '%s' "$root" | base64 -w0)"
git -C "$root" status --porcelain=v2 --branch -z --untracked-files=all | base64 -w0; printf '\n'
git -C "$root" diff --cached --numstat -z | base64 -w0; printf '\n'
git -C "$root" diff --numstat -z | base64 -w0; printf '\n'
# untracked 行数：只统计 ≤1 MiB 的普通文件，最多 500 个，xargs 一次 wc -l
```

Rust 侧解析：

- `# branch.head <name>` → `branch`；`(detached)` → `HEAD`；
- `# branch.ab +A -B` → `ahead/behind`；无 upstream（没有该行）→ `None`（与主机「无 upstream 不显示 0/0」一致）；
- `1 XY … path` / `2 XY … path\0orig` / `? path`：
  - `?` → untracked（`status: "added"`，行数由统计块给出）；
  - `X` 侧非 `.` → staged；`Y` 侧非 `.` → unstaged；
  - 状态标签按单侧字母取优先级 `D > R > A > T > M`（对齐主机 `status_label`）；
  - rename 记录额外消费一个 NUL 字段（新路径 + 原路径），列表只呈现新路径（与主机 `entry.path()` 一致）；
- 行统计：`--numstat` 的普通记录 `add\tdel\tpath`，rename 记录 `add\tdel\t\0old\0new`（映射到新路径）；`-`（二进制）按主机的 `Some(0) + Some(0)` 处理；
- untracked 行数按路径匹配回填；超过 1 MiB 或未统计到 → `None`（主机同规则）。

### 4.2 `git_diff`

| 场景 | 命令 |
| --- | --- |
| staged | `git diff --cached --no-color -U3 -- <file>` |
| unstaged 已跟踪 | `git diff --no-color -U3 -- <file>` |
| unstaged 且输出为空且文件 untracked | `git diff --no-index --no-color -U3 -- /dev/null <file>`（退出码 1 是「有差异」，不是错误） |

- 输出整体截断到 `MAX_DIFF_PATCH_BYTES`（2 MiB，与主机一致），补 `[... diff truncated: file too large to preview ...]` 标记；
- CLI 补丁与 libgit2 补丁的 `+`/`-`/空格行格式一致，前端 `annotateDiff` 无需改动；
- 脚本内用 `head -c 2097152` 限流，避免 IPC 传超长文本。

### 4.3 变更操作

| IPC | 发行版实现 | 说明 |
| --- | --- | --- |
| `git_stage(files)` | `git -C root add -A -- <files…>` | 与主机「存在则 add、缺失则 remove」等价 |
| `git_unstage(files)` | HEAD 存在 → `git reset -q HEAD -- <files…>`；无 HEAD → `git rm --cached -q -- <files…>` | 对齐主机对 unborn 分支的处理 |
| `git_discard(files)` | 逐文件：在索引中 → `git checkout -q -- <file>`；不在索引 → `rm -rf` | 对齐主机「restore --worktree + clean」语义 |
| `git_commit(message)` | `printf '%s' <base64> \| base64 -d \| git -C root commit -F -` | 提交信息不进 argv；返回 `git rev-parse HEAD` |
| `git_push` | `git -C root push origin <branch>` | 网络操作，超时 180s |
| `git_pull` | `git -C root fetch origin <branch>` + `git -C root merge --ff-only FETCH_HEAD` | 与主机「只做 fast-forward，不自动合并」一致；冲突/本地修改以 git 原始 stderr 上报 |
| `git_branches` | `git -C root for-each-ref --format='%(refname:short)%09%(refname)' refs/heads refs/remotes` | 本地在前、remote 在后；跳过 `refs/remotes/*/HEAD` 符号引用 |
| `git_checkout(branch)` | 本地存在 → `git checkout <branch>`；仅 remote 存在 → 本地同名存在则切本地，否则 `git checkout -b <local> --track <remote>`；否则报错 | 与主机「remote 分支物化为本地跟踪分支」一致 |
| `git_create_branch(name)` | `git -C root checkout -b <name>` | 对齐主机「建分支 + 切过去」 |

- 所有写操作失败时上报 `git` 的 stderr（哨兵 `GIT_ERR`），Rust 侧分类见 §7；
- 分支/提交信息等文本都走 base64 或 `-F -`，不进 argv。

### 4.4 路径与引号

- 发行版路径一律 `wsl_transport::sh_quote` 包裹（允许空格、中文、引号，与 V1 的 argv 语义一致）；
- 文件参数（`files`）来自 status 输出（仓库相对路径），同样逐个 `sh_quote`；`..` 段在脚本内拒绝（防御性，正常来源不会有）。

## 5. 文件树装饰（`git_tree_status`）

前端在文件树展开时批量请求已加载目录的徽标（`files/store.ts` 一次 `gitTreeStatus(levels)`）。WSL 分支：

- 对 `levels` 逐个处理，**一次短调用**跑完所有目录：每个目录解析仓库根（`git rev-parse --show-toplevel`）、取一次 status（同仓库根复用）、输出该目录下的颜色映射与仓库根摘要；
- 颜色语义与主机 `file_tree_colors` 完全一致：`??` 或索引新增 → `untracked`（绿），其余有变更 → `modified`（黄），父目录按「modified 优先」向上传播；直接子目录自身是仓库根（存在 `.git`）→ `repository`（蓝）；
- 每个 level 的 `path` 是 UNC；脚本里转成 Linux 路径执行，输出按 level 序号回填；
- 仓库摘要 `RepositorySummary { path, branch, changed, untracked }`：path 用 UNC 形态（与主机返回的路径形态一致），分支取 `--abbrev-ref HEAD`，计数按 status 条目去重（同主机口径：untracked 单列，其余计入 changed）。

纯函数拆分（可单测）：`parse_status_entries(raw)`、`colors_from_entries(prefix, entries, files)`、`summarize_entries(entries)`——主机与 WSL 两套实现共用同一套映射规则，避免颜色规则漂移。

## 6. 全文搜索（`search_text`）

`files.rs::search_text` 增加 WSL 分支：

- 先 `ensure_allowed(path, db)`（授权边界与主机一致，不因换后端而放宽）；
- 发行版内脚本（复用 `wsl_index` 的哨兵与 `RG_MISSING` 约定）：

```sh
cd -- <linux path> || exit 61
command -v rg >/dev/null 2>&1 || { echo __CCGUI__NO_RG >&2; exit 127; }
rg --json --no-messages --fixed-strings --ignore-case -e <query> .
```

- 结果解析 `{"type":"match","data":{"path":{"text":…},"line_number":…,"lines":{"text":…}}}`：`path` 相对 cwd → 绝对 UNC（`wsl_path::to_wsl_unc(distro, join(linux, rel))`）；
- **必须显式给 `rg` 路径 `.`**：脚本经 stdin 送进 `bash -s`，rg 看到非 tty 的 stdin 会把它当成输入源，不写路径就永远搜不到文件（实机验收时发现的真实缺陷，已修并加单测）；
- `text` 与主机一致：`trim()` 后截断 200 字符；总条数上限 `MAX_SEARCH_RESULTS`（200）；
- `--fixed-strings` + `--ignore-case` 对齐主机 `contains_case_insensitive` 语义；默认忽略规则（.gitignore/隐藏文件）与主机遍历的跳过规则对齐；
- `rg` 缺失（`RG_MISSING`）→ **回退主机 UNC 遍历**（现有 `search_text_blocking`），并仅记日志，不弹错误：搜索仍可用、只是慢；
- 空查询直接返回空（主机同）。

## 7. 错误契约与超时

| 情况 | 返回 | 前端 |
| --- | --- | --- |
| 不在 git 仓库内 | `NOT_A_REPO`（复用主机字符串） | `useGitStore.isNotARepo` 直接识别，面板显示「不是仓库」 |
| 发行版内没有 git | `WSL_GIT_MISSING` | 新增 i18n：「发行版内没有 git…」 |
| 认证/凭据失败（push/pull stderr 含 auth/publickey/permission denied） | `WSL_GIT_AUTH_FAILED:<detail>` | 新增 i18n：「Git 认证失败：检查凭据 / SSH key（{{message}}）」 |
| 其余 git 失败 | `WSL_GIT_FAILED:<detail>` | 新增 i18n：「Git 操作失败：{{message}}」；detail 是 git 原始 stderr（与主机返回 libgit2 原文同规则） |
| 工作目录不存在 | `WSL_CWD_NOT_FOUND:<path>` | 复用既有映射 |
| 脚本超时 | `WSL_SHORT_CALL_TIMEOUT:<secs>` | 复用既有映射 |

超时：普通 git 命令沿用 30s；`push` / `pull` 用 180s（大仓库网络操作），新增 `run_script_output_with_timeout(transport, script, duration)`，不改变既有 `run_script_output` 语义。

Web 端：`web/dispatch.rs` 的 git 分支增加守卫——路径是 WSL UNC 时返回 `WSL_GIT_DESKTOP_ONLY`（i18n：「WSL 工作区的 Git 只在桌面端可用」）。理由与既有 D3 一致：Web token 不应获得发行版内任意 git 写操作的能力；`git_tree_status` 按 levels 里任一 path 判断。

## 8. 边界与安全

- `git_wsl.rs` 不出现 `wsl.exe` / `wsl.localhost` / `wsl$` 字面量（守卫已允许该文件，但实现不需要）；
- 提交信息、分支名、文件路径都经 base64 或 stdin 传，不拼进命令行文本以外的地方；文件路径经 `sh_quote`；
- 不做 `--force` push、不做 `reset --hard`、不自动合并（pull 只 fast-forward）；
- 授权：Git 命令沿用主机现有语义（不新增 `ensure_allowed` 之外的检查）；`search_text` 保留 `ensure_allowed`；
- 发行版名过 `is_safe_distro`（由 `parse_wsl_unc` 与 `local_transport` 保证）。

## 9. 测试与验收

### 9.1 Rust 单测（纯函数为主）

- `parse_status_v2`：branch/ab、staged/unstaged/untracked 分桶、rename 双 NUL、detached HEAD；
- `parse_numstat`：普通/rename/二进制（`-`）三类记录；
- `line_label_precedence`：`D > R > A > T > M`；
- `colors_from_entries`：直接命中、父目录传播、modified 优先、仓库根蓝标；
- `summarize_entries`：changed/untracked 去重计数；
- `search_json_parse`：match 事件、非 UTF-8 行（`bytes` 字段时跳过）、相对路径 → UNC；
- `script_quotes_paths`：含空格/中文路径的脚本文本断言；脚本永远 `exit 0` 并带哨兵；
- `web_dispatch_rejects_wsl_git`（若 dispatch 有可测入口）；
- `cargo test --test wsl_boundary_guard`。

### 9.2 实机矩阵（Windows + WSL2，发行版内有 git）

| 场景 | 预期 |
| --- | --- |
| 打开 WSL 工作区 → Git 面板 | 分支、ahead/behind 正确；staged/unstaged/untracked 三组与 `git status` 一致 |
| 行统计 | 修改文件的 +N/−M 与 `git diff --stat` 一致；新文件显示行数 |
| 点开差异 | 已跟踪/新增/untracked 文件都能预览；大文件出现截断标记 |
| stage / unstage | 状态与 `git status` 同步刷新；unstage 在无提交的仓库也可用 |
| discard | 已跟踪文件还原、untracked 文件被删除；已 staged 的改动保留 |
| commit | 提交成功、返回 HEAD；中文/多行提交信息完整；author 来自发行版 git config |
| push / pull | 与发行版内 `git push/pull` 结果一致；认证失败显示本地化提示 |
| checkout / 新建分支 | 本地分支、远端分支（物化为本地跟踪分支）都可切换 |
| 文件树徽标 | 修改/新增/删除/未跟踪颜色正确；嵌套仓库显示蓝标与分支摘要 |
| 非仓库目录 | 面板显示「不是仓库」，无错误串 |
| 发行版内没有 git（临时改 PATH 模拟） | 提示缺 git，不崩 |
| 全文搜索（经 IPC/插件或 Web） | 返回命中行号与文本；无 `rg` 时回退 UNC 且结果不变（慢） |
| Web 访问端打开 WSL 工作区 Git | 明确提示「只在桌面端可用」 |
| 主机工作区（回归） | Git 面板、文件树徽标、搜索行为与改动前一致 |

### 9.3 构建与既有测试

- `pnpm build`；
- `cargo test --lib wsl`、`cargo test --lib git`（新增纯函数测试）、`cargo test --test wsl_boundary_guard`；
- 前端无需新用例；既有 `ChangesPanel` / `DiffView` / `files/store` 测试保持全绿。

## 10. 风险与备选

| 风险 | 影响 | 缓解 | 备选 |
| --- | --- | --- | --- |
| 每个 git 操作一次 `wsl.exe`（约 0.7s 启动） | 面板刷新比主机慢 | 面板本身有 30s TTL + 单飞；只在变更后强制刷新；tree status 一次批量调用 | 常驻发行版内 git 服务（复杂度高，不做） |
| porcelain 解析遗漏边界（rename/copy、`-z` 双字段） | 状态列表错乱 | 实测样本进单测；解析函数纯函数化 | 改用 v1 简单格式（丢失 rename 区分，不推荐） |
| `git pull` 行为与主机不完全一致 | 冲突时文案不同 | 只做 ff-only，失败透传 git stderr | 手工 fetch+merge 分析（过度设计） |
| untracked 行数统计拖慢大目录 | 面板首次刷新变慢 | 只统计 ≤1 MiB、最多 500 个文件；超出显示未知 | 完全不算（丢失 +N） |
| 大仓库 status 输出巨大 | 单次 IPC 文本过长 | git 自身快（33ms 级）；输出上限由 `head -c` 兜底 | 分页（现有 UI 一次全量，不做） |
| Web 端误获发行版 Git | 越权写操作 | dispatch 显式拒绝 WSL 路径 | 依赖授权边界（暂无，不做） |
| `git_tree_status` 多 level 一次脚本过长 | 脚本复杂度 | 单脚本 + 序号哨兵；levels 通常 1–5 个 | 每 level 一次调用（更慢，不做） |

## 11. 实施顺序

1. `git_wsl.rs` 纯函数与解析（TDD：先写解析单测）；
2. `git.rs` 分派 + 命令实现（status → diff → 变更操作 → branches/checkout）；
3. `run_script_output_with_timeout` + push/pull；
4. `git_tree_status` 分派与批量脚本；
5. `files.rs::search_text` + `wsl_index::search`；
6. `web/dispatch.rs` 守卫 + i18n；
7. 实机验收（§9.2）+ 截图自审 Git 面板/文件树/差异页。

## 12. 评审修订记录（2026-10-26）

评审后已同批修复并复验：

- **路径校验**：`validate_repo_relative` 拒绝空串、`.`、绝对路径与 `..` 段，`stage / unstage / discard / diff` 统一在脚本前校验（§4.4 的防御要求落实，避免 `rm -rf` 越出仓库根）。
- **错误码**：`repo_prelude` 的 `cd` 失败改发 `WSL_CWD_NOT_FOUND:<path>`，与「不是仓库」分开（§7）。
- **树装饰发行版选择**：改为 `first_wsl_unc` 取第一个 WSL level，混合列表不再因首项是主机路径而整批为空。
- **文档同步**：非目标补 `git_file_colors` / `git_repository_summaries` / `git_branch_merged` 与合并冲突不展示的边界；搜索参数与实现一致。
- **补测试**：路径穿越拒绝、cwd/NOT_A_REPO/NO_GIT 分类、`first_wsl_unc`、`web_guard_wsl_path`（UNC 三种形态 + 主机路径）。
- **剩余验收项已实测**：staged/untracked diff、非仓库、目录不存在、无 git（临时移走 git 后恢复）、push/pull（本地裸远端 fast-forward）、rename 状态；路径穿越被拒绝且哨兵文件未删。Web 拒绝以 `web_guard_wsl_path` 单测与 dispatch 守卫代码为准。


# 幽灵会话治理：sessions 表死行 GC 设计

日期：2026-10-26
状态：已实现，实机验收通过
对应上游 issue：[#1083](https://github.com/zhukunpenglinyutong/desktop-cc-gui/issues/1083)（根因分析）、[#1086](https://github.com/zhukunpenglinyutong/desktop-cc-gui/issues/1086)、[#1103](https://github.com/zhukunpenglinyutong/desktop-cc-gui/issues/1103)、[#1104](https://github.com/zhukunpenglinyutong/desktop-cc-gui/issues/1104)、[#1107](https://github.com/zhukunpenglinyutong/desktop-cc-gui/issues/1107)

## 1. 背景与问题定义

侧边栏会话列表来自后端 `sessions` 表的 `list_sessions` 全表查询。索引行的唯一
移除路径是 `delete_session_blocking`（应用内删除，同事务清 6 张表）。但**源文件
在应用外消失**的场景没有任何清理路径：

- 用户在 CLI 侧删除/重建会话（`--resume` 后清理、手动删 jsonl）；
- 引擎 home 迁移或卸载重装（旧 rollout 不再被枚举）；
- 旧版本（≤0.9.x）残留的死行升级到新版后无人清理；
- 删除流程曾经失败/被中断的历史遗留。

后果：死行永久列在侧边栏，点击打开报错（hydrate 空/文件不存在），即上游报告的
「删除的会话复活 / 幽灵会话」。v0.8.8 的 #1083 已指出同类根因（session_index
无 GC），v1.x 架构重做后删除了索引残留问题（删除链路已同事务清行），但
**GC 缺口本身原样遗留**在 `scanner.rs::upsert_rows`：只 INSERT/UPDATE，
从不 DELETE 消失的行。

## 2. 现状核对（#1083 四点根因的当前状态）

| #1083 根因 | 当前状态 |
|---|---|
| 删除只删文件不删索引行 | 已修：`delete_session_blocking` 持 SCAN_LOCK 同事务删 sessions/session_models/session_efforts/session_providers/session_archives/accepted_internal_frames + plan_reviews |
| 索引无垃圾回收 | **未修**：`upsert_rows`（scanner.rs:510）只增不改删 |
| 同步条件永不自愈 | **未修**：残留行无任何被清理的路径 |
| 前端快照缓存写回 | 已修：sessions_changed 事件驱动，无持久化快照写回 |

## 3. 修复方案：扫描时死行 GC

### 3.1 触发时机与安全性论证

扫描由 `stat_all` 的全局签名门控（tier1_gate）：**任一候选文件的 (path,size,mtime)
变化都会使签名变化并放行扫描**。文件删除 → 候选列表中该路径消失 → 签名变化 →
扫描触发。因此「扫描已放行」等价于「文件系统状态发生了值得核对的变化」，GC 只
在放行的扫描里执行，签名未变的空闲期不做任何文件系统探测。

### 3.2 删除判据（三条件同时满足才删）

对 `sessions` 表中 `file_path` 非空的行：

1. **不在本次候选路径全集**——注意必须是 `gather_candidates` 的候选全集，
   而非 `upsert_rows` 的 rows（rows 只含变化/新增候选，未变化的 reused 行
   不在其中，用它差分会误删全部未变化行）；
2. **文件确实不存在**：对该行 `file_path` 执行 `fs::metadata`，错误种类必须是
   `ErrorKind::NotFound`；其它任何错误（权限不足、设备未就绪、网络路径不可用）
   一律跳过——这是防误删的关键：引擎 home 整体不可用时（SMB 断开、移动硬盘
   未挂载、WSL 未启动），候选枚举为空但绝不能清库；
3. **不是远程/合成路径**：
   - UNC 形状排除（`\\server\share`、`\\wsl.localhost\...`），存在性语义不可靠；
     注意 `\\?\C:\...` 是本地扩展长度路径，**不能**按 UNC 排除；
   - **OpenCode 合成地址排除**（自审发现的致命点）：opencode ≥1.18 的 db 型
     会话行 file_path 是 `opencode.db#session_id` 虚拟地址（mod.rs
     `opencode_db_session_path`），不是真实文件——`fs::metadata` 对它永远
     NotFound，不排除会把全部 opencode 会话误删。用 `split_opencode_db_path`
     识别并跳过。

### 3.3 挂载点与事务边界

自审修订：metadata 文件探测**放在 db 锁外**做（先 SELECT 候选行 → 锁外逐行
stat → 锁内按已验证列表 DELETE 短事务），避免文件 I/O 拉长写锁——上游
#1393 的教训正是 SQLite 写锁阻塞 UI 线程。GC 与 upsert 在同一扫描阶段顺序
执行但非同一事务：GC 失败不阻断已完成的 upsert，残留死行下一轮扫描自愈。

```
scan_inner
  candidates = gather_candidates(workspaces)          // 全集
  ... stat_all / tier1_gate ...
  Phase A: parse（已有，不变）
  Phase B: upsert_rows 事务（不变）
  Phase B 追加 prune_missing_file_sessions：
      1. 短锁 SELECT (engine, session_id, file_path) WHERE file_path <> ''
      2. 锁外判据过滤（候选全集 / NotFound / UNC / opencode 合成地址）
      3. 短锁 DELETE 通过判据的行 + plan_reviews（CASCADE 自动清
         session_messages/messages_fts）
  既有 prune_stale_sessions / codex_titles::sync（不变）
```

GC 期间无并发删除风险：SCAN_LOCK 已由 scan/delete 全程持有。

### 3.4 与既有 prune 的关系

`prune_stale_sessions`（codex home 外、隐藏子代理、opencode hidden）是按规则
主动清理，本方案是按文件存在性兜底，两者互补不重叠。

### 3.5 各引擎行为矩阵

| 引擎 | 行 file_path 指向 | 文件删 | home 整体不可用 |
|---|---|---|---|
| claude/kimi/grok/minimax/agy/qoder | 每会话 jsonl/db | GC 删行 ✓ | metadata 非 NotFound → 保留 ✓ |
| codex/pi/omp | rollout/head 文件 | GC 删行 ✓ | 同上 ✓ |
| dsh | jsonl.zstd（含旧世代同目录） | 旧世代行 NotFound 删 ✓ | 同上 ✓ |
| opencode | 共享 db 文件 | db 在则全保留（安全方向） | 同上 ✓ |
| WSL/远程 | 不进 sessions 表 | 不受影响 ✓ | — |

## 4. 非目标（范围外）

- **#1175 / #1068 列表重复**：(engine, session_id) 主键唯一，同表不会两行同
  id；重复只能来自前端多源合并（本地行 + 插件远程源同 id）或 pending→native
  迁移残留，是独立链路，需单独复现（开子代理场景），单独立项。
- opencode 行级消失（会话从共享 db 中删除但 db 文件还在）无法被文件级 GC 感知，
  维持既有 `delete_opencode_db_session` 显式删除路径。
- 不为 GC 增加独立的定时器/后台任务：扫描触发已覆盖全部合法场景。

## 5. 测试计划

单元测试（scanner.rs tests，scratch 环境）：

1. 外部删除 transcript 后扫描：行从 sessions 表移除，list_sessions 不再返回；
2. 引擎 home 整体不可用时扫描：行全部保留（metadata 非 NotFound 错误一律跳过，
   逻辑审查 + 错误分类分支注释覆盖）；
3. UNC 形状 file_path 的行：任何情况下不删（含 `\\?\C:\...` 本地扩展路径仍被
   GC 正常处理的区分用例）；
4. reused（未变化）候选的行不被 GC 误删（回归保护：rows 非全集的陷阱）；
5. **opencode 合成地址行不删**（`db#session-id` 虚拟路径即使 metadata 永远
   NotFound 也必须跳过）；
6. delete_session_blocking 行为不变（既有测试全绿）。

实机验收：

1. 在 CLI 侧手动删除一个已索引会话的 jsonl → 触发扫描（或重启）→ 侧边栏消失；
2. 应用内删除会话 → 立即消失且重启不复发（既有行为不回退）；
3. 用户真实环境存在旧死行时，升级后一次扫描自动清掉。

## 6. 风险与缓解

| 风险 | 缓解 |
|---|---|
| metadata 错误种类误判导致批量误删 | 只认 ErrorKind::NotFound；其它错误跳过；测试 2 覆盖 |
| reused 行误删 | GC 用候选全集差分，不用 rows；测试 4 覆盖 |
| 用户把引擎 home 放在偶尔断开的盘上 | 断开时 metadata 非 NotFound → 保留 ✓；但「文件真被删且盘在读」的语义无法与正常删除区分——这正是 GC 的目的行为 |
| GC 期间用户正在删除会话 | SCAN_LOCK 串行化 scan 与 delete；GC 在锁内事务执行 |

## 7. 提交信息要点

修复上游 #1083 / #1086 / #1103 / #1104 / #1107（提及 issue 链接），范围说明中
注明 #1175 / #1068（列表重复）不在本次范围。

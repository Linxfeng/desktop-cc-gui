import { ipc, type SessionMeta, type WslNotice } from "@/lib/ipc";
import { isWeb } from "@/lib/platform";
import { parseWslUncPath } from "@/lib/wsl-path";
import { externalRowToMeta } from "@/features/plugins/runtime/session-source";

/**
 * 本机 WSL 工作区的宿主内建会话源。
 *
 * 设计稿 §5.5:发行版内的 Claude / Codex 转录本由 `wsl_list_sessions` 在
 * 发行版内扫描(UNC 遍历实测 6–8s),返回的行与插件会话源同形。这里把它们
 * 并进侧栏会话目录 —— 不注册成插件源,因为本机 WSL 是宿主能力,不依赖
 * 插件是否启用;两条链路共用同一套 `remote`/`remotePath` 行语义,打开与
 * 删除不需要第二种前端模型。
 *
 * 失败只记日志并返回空表:一次扫描失败(发行版关停、探测超时)不能让整个
 * 侧栏刷新失败。
 */

/** 单轮刷新里 await 的工作区上限:每个工作区一次 `wsl.exe` 调用约 0.7s
 *  (V17),几十个工作区串行扫会明显拖慢首次刷新。其余工作区后台补扫,
 *  下一轮刷新命中缓存。 */
const MAX_AWAITED_WORKSPACES = 2;

/** 已知工作区里的本机 WSL 路径。 */
export function wslWorkspacePaths(paths: Iterable<string>): string[] {
  const out: string[] = [];
  for (const path of paths) {
    if (parseWslUncPath(path)) out.push(path);
  }
  return out;
}

const inFlight = new Set<string>();
const cached = new Map<string, SessionMeta[]>();
/** 注销/重新登记时递增:在途扫描的旧结果不得写回缓存(§10 P1-10)。 */
const generation = new Map<string, number>();
/** 后台补扫节流:刷新是高频路径,不必每次刷新都开一个 `wsl.exe`。 */
const lastScanAt = new Map<string, number>();
const BACKGROUND_SCAN_TTL_MS = 15_000;

function needsBackgroundScan(workspacePath: string): boolean {
  return Date.now() - (lastScanAt.get(workspacePath) ?? 0) > BACKGROUND_SCAN_TTL_MS;
}

/** 扫描本机 WSL 工作区并返回可合并的 SessionMeta 行。
 *
 *  已扫描过的工作区用缓存先顶上(刷新是高频路径,侧栏不该等 0.7s×N),
 *  同时后台补扫更新缓存;从未扫描过的才 await —— 且最多两个,其余交给
 *  后台,避免第一次打开应用时刷新被拖住。
 */
export async function listWslSessionMetas(
  workspacePaths: Iterable<string>,
): Promise<SessionMeta[]> {
  // 本机 WSL 只在桌面壳里存在;Web 访问端的 dispatch 没有这些命令,直接跳过。
  if (isWeb || typeof ipc.wslListSessions !== "function") return [];
  const paths = wslWorkspacePaths(workspacePaths);
  if (paths.length === 0) return [];
  const rows: SessionMeta[] = [];
  let awaited = 0;
  await Promise.all(
    paths.map(async (workspacePath) => {
      const hit = cached.get(workspacePath);
      if (hit) {
        rows.push(...hit);
        if (needsBackgroundScan(workspacePath)) void scan(workspacePath);
        return;
      }
      if (awaited < MAX_AWAITED_WORKSPACES) {
        awaited += 1;
        rows.push(...(await scan(workspacePath)));
        return;
      }
      void scan(workspacePath);
    }),
  );
  return rows;
}

/** 扫描一个工作区并写回缓存。并发请求合并(同一轮的 init + refresh)。 */
async function scan(workspacePath: string): Promise<SessionMeta[]> {
  if (inFlight.has(workspacePath)) return cached.get(workspacePath) ?? [];
  const startedAt = generation.get(workspacePath) ?? 0;
  inFlight.add(workspacePath);
  lastScanAt.set(workspacePath, Date.now());
  try {
    const listed = await ipc.wslListSessions(workspacePath);
    // 扫描期间工作区被注销/重新登记:丢弃这次结果,避免已删除的会话复活。
    if ((generation.get(workspacePath) ?? 0) !== startedAt) return [];
    const metas = listed.flatMap((row) => {
      const meta = externalRowToMeta(row);
      return meta ? [meta] : [];
    });
    cached.set(workspacePath, metas);
    return metas;
  } catch (error) {
    console.error(`[wsl] listing sessions failed for ${workspacePath}`, error);
    if ((generation.get(workspacePath) ?? 0) !== startedAt) return [];
    return cached.get(workspacePath) ?? [];
  } finally {
    if ((generation.get(workspacePath) ?? 0) === startedAt) {
      inFlight.delete(workspacePath);
    }
  }
}

/** 工作区注销后丢弃它的扫描结果(重新登记时重新扫描)。
 *  同时使在途扫描失效:它完成后不得把旧行写回缓存(§10 P1-10)。 */
export function forgetWslWorkspace(workspacePath: string): void {
  cached.delete(workspacePath);
  lastScanAt.delete(workspacePath);
  generation.set(workspacePath, (generation.get(workspacePath) ?? 0) + 1);
  inFlight.delete(workspacePath);
}

/** 取走运行期提示(回收未确认 / 缺 rg);取走即清空,不重复提示。 */
export async function takeWslNotices(): Promise<WslNotice[]> {
  // Web 访问端没有这些命令(mock 里也可能缺):当作没有提示。
  if (isWeb || typeof ipc.wslTakeNotices !== "function") return [];
  return ipc.wslTakeNotices().catch(() => [] as WslNotice[]);
}

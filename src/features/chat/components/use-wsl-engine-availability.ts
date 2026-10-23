import { useEffect, useState, useSyncExternalStore } from "react";
import { ipc } from "@/lib/ipc";
import { isWeb } from "@/lib/platform";
import { isWslUncWorkspace } from "@/lib/wsl-path";

/** 设置页保存覆盖/「重新检测」后,让已挂载的聊天页重新取一次可用性。
 *  只依赖工作区路径的 effect 不会因为设置变化而重跑(§10 P1-1)。 */
let availabilityRevision = 0;
const revisionListeners = new Set<() => void>();

export function invalidateWslEngineAvailability(): void {
  availabilityRevision += 1;
  for (const listener of revisionListeners) listener();
}

function subscribeRevision(listener: () => void): () => void {
  revisionListeners.add(listener);
  return () => {
    revisionListeners.delete(listener);
  };
}

function getRevision(): number {
  return availabilityRevision;
}

/**
 * 本机 WSL 工作区的引擎可用表(设计稿 §5.4)。
 *
 * 本机探针(`list_engines`)只看 Windows 侧 PATH:发行版里装了 CLI、Windows
 * 侧没装时 `available=false`,菜单会把引擎藏掉 —— 用户明明能在该工作区里
 * 用它。这里改用发行版内 `bash -ic` 的探测结果,判断口径与发送路径
 * (`wsl_probe`)完全一致。
 *
 * 返回 `string[] | null`:`null` = 非 WSL 工作区(调用方沿用本机探针);
 * 数组 = 该工作区里可用的引擎 id(可能为空,表示真的一个都没装)。
 *
 * 探测有 2.4s 冷启动(V5):先按 `null` 展示(菜单沿用本机探针,不闪空白),
 * 结果到达后再收窄。失败同样保持 `null` —— 宁可多列一个不可用的引擎,
 * 也不要把能用的藏起来;真正的失败会在发送时给出可诊断的错误。
 */
export function useWslEngineAvailability(
  workspacePath: string | undefined,
): string[] | null {
  const isWsl = isWslUncWorkspace(workspacePath);
  const revision = useSyncExternalStore(subscribeRevision, getRevision);
  const [state, setState] = useState<{ ws: string; engines: string[] } | null>(
    null,
  );

  useEffect(() => {
    if (!isWsl || !workspacePath) return;
    let cancelled = false;
    // 切换工作区时先回到"未探测",避免拿上一个发行版的可用表过滤。
    setState((prev) => (prev?.ws === workspacePath ? prev : null));
    if (isWeb || typeof ipc.wslEngineAvailability !== "function") return;
    ipc
      .wslEngineAvailability(workspacePath)
      .then((engines) => {
        if (!cancelled && Array.isArray(engines)) {
          setState({ ws: workspacePath, engines });
        }
      })
      .catch((error) => {
        // 保持 null,错误只进控制台:探测失败不是用户动作。调用方必须把
        // null 理解为「结果未知」而不是「按本机探针过滤」(见 enginesDelegated)。
        console.error("[wsl] engine availability probe failed", error);
      });
    return () => {
      cancelled = true;
    };
  }, [isWsl, workspacePath, revision]);

  if (!isWsl) return null;
  // 结果属于另一个工作区(刚切换)时同样按未探测处理。
  return state && state.ws === workspacePath ? state.engines : null;
}

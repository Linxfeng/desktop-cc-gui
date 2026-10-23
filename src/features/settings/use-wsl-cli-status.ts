import { useCallback, useEffect, useRef, useState } from "react";
import { errorText } from "@/lib/errors";
import { ipc, type WslCliStatus } from "@/lib/ipc";

/** 最近一次读取失败；reason 决定页面用哪条文案。 */
export interface WslCliStatusError {
  message: string;
  reason: "load" | "rescan" | "save";
}

interface LoadedState {
  /** 这份 rows 属于哪个发行版；与当前 distro 不一致时按「未加载」处理。 */
  distro: string | null;
  rows: WslCliStatus[] | null;
}

interface ErrorState {
  distro: string;
  error: WslCliStatusError;
}

/**
 * 读取某发行版内受支持引擎的 CLI 状态。
 *
 * - 切换发行版时立即按「未加载」处理（渲染期用 distro 匹配判断，不等
 *   effect），不把上一个发行版的数据显示成新的；
 * - `reload()` 保留旧列表，新结果到达再替换（重新检测 / 保存后刷新不闪空）；
 * - 请求序号丢弃晚到结果；
 * - `reload()` 失败时同时写入 `error` 并 reject，调用方只负责吞掉 rethrow，
 *   展示统一由 `error` 决定。
 */
export function useWslCliStatus(distro: string | null): {
  statuses: WslCliStatus[] | null;
  loading: boolean;
  error: WslCliStatusError | null;
  reload: (reason?: "rescan" | "save") => Promise<void>;
} {
  const [loaded, setLoaded] = useState<LoadedState>({ distro: null, rows: null });
  const [errorState, setErrorState] = useState<ErrorState | null>(null);
  const [pending, setPending] = useState(false);
  /** 每次读取 +1；切换发行版 / 卸载也 +1，晚到的结果直接丢弃。 */
  const seq = useRef(0);
  /** 渲染期同步的当前发行版：切换后，旧发行版在途的 reload 必须整段失效。 */
  const currentDistro = useRef(distro);
  currentDistro.current = distro;

  const load = useCallback(
    async (reason: WslCliStatusError["reason"], clear: boolean) => {
      if (!distro || currentDistro.current !== distro) return;
      const id = ++seq.current;
      setPending(true);
      if (clear) setLoaded({ distro, rows: null });
      try {
        const rows = await ipc.wslCliStatus(distro);
        if (id !== seq.current || currentDistro.current !== distro) return;
        setLoaded({ distro, rows: Array.isArray(rows) ? rows : [] });
        setErrorState(null);
      } catch (cause) {
        if (id !== seq.current || currentDistro.current !== distro) return;
        setErrorState({ distro, error: { message: errorText(cause), reason } });
        throw cause;
      } finally {
        if (id === seq.current && currentDistro.current === distro) {
          setPending(false);
        }
      }
    },
    [distro],
  );

  useEffect(() => {
    seq.current += 1; // 让 previous distro 的在途请求全部失效
    setErrorState(null);
    if (!distro) {
      setPending(false);
      setLoaded({ distro: null, rows: null });
      return;
    }
    void load("load", true).catch(() => undefined);
    return () => {
      seq.current += 1;
    };
  }, [distro, load]);

  const reload = useCallback(
    (reason: "rescan" | "save" = "rescan") => load(reason, false),
    [load],
  );

  // 渲染期就按 distro 匹配，切发行版的第一帧也不会显示旧数据。
  const statuses = loaded.distro === distro ? loaded.rows : null;
  const error = errorState?.distro === distro ? errorState.error : null;
  const loading = distro !== null && (pending || loaded.distro !== distro);

  return { statuses, loading, error, reload };
}

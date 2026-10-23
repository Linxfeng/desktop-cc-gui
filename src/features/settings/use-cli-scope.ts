import { useSyncExternalStore } from "react";
import { errorText } from "@/lib/errors";
import { ipc } from "@/lib/ipc";
import { IS_WINDOWS, isWeb } from "@/lib/platform";
import type { EngineId } from "./providers";

/**
 * CLI 页的「本机 / WSL 发行版」作用域。
 *
 * 作用域要被 `CliConfigSection` 与页头 `CliHeaderActions` 同时读取，所以做成
 * 模块级外部 store（`useSyncExternalStore`）而不是组件局部 state：页头在
 * SettingsPage 里渲染，和页面主体不在同一棵子树。
 *
 * 元数据（发行版列表 + 后端能力表）30 秒缓存、single-flight；读取在订阅时
 * 启动，绝不在 `getSnapshot` 里发 IPC —— React 可能在渲染期多次调用它。
 */

export type CliScope = "host" | "wsl";

const SCOPE_KEY = "ccgui-next.cliScope:v1";
const DISTRO_KEY = "ccgui-next.wslCliDistro:v1";
const META_TTL_MS = 30_000;

interface CliScopeSnapshot {
  /** 用户上次选择，持久化；元数据未就绪时也保留。 */
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

export interface CliScopeView extends CliScopeSnapshot {
  /** 当前引擎是否应该显示作用域控件。 */
  visible: boolean;
  /** 当前引擎实际生效的作用域（不受支持 / 无发行版时回落 host）。 */
  active: CliScope;
  /** 用户上次选 WSL，但元数据还没回来：先别挂载 HostCliConfig。 */
  pending: boolean;
  setScope(next: CliScope): void;
  setDistro(next: string): void;
  reloadMeta(): void;
}

/**
 * jsdom（没有 `__TAURI_INTERNALS__`，`isWeb` 为真）与 Web 访问端都不算桌面；
 * 两个常量都是模块加载时的值，测试要覆盖 WSL 分支必须 mock 平台模块。
 */
function onDesktopWindows(): boolean {
  return typeof window !== "undefined" && !isWeb && IS_WINDOWS;
}

function readKey(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeKey(key: string, value: string | null): void {
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    // 隐私模式 / 配额满：作用域记忆是 best-effort，不能因此让设置页崩。
  }
}

let snapshot: CliScopeSnapshot | null = null;
let metaLoadedAt = 0;
let metaInFlight: Promise<void> | null = null;
const listeners = new Set<() => void>();

function baseSnapshot(): CliScopeSnapshot {
  if (!snapshot) {
    snapshot = {
      requested: readKey(SCOPE_KEY) === "wsl" ? "wsl" : "host",
      distro: readKey(DISTRO_KEY) || null,
      distros: [],
      engines: [],
      ready: false,
      metaError: null,
    };
  }
  return snapshot;
}

/** 稳定引用：`useSyncExternalStore` 只在 emit 后看到新对象。 */
function getSnapshot(): CliScopeSnapshot {
  return baseSnapshot();
}

function emit(next: CliScopeSnapshot): void {
  snapshot = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  void ensureMeta();
  return () => {
    listeners.delete(listener);
  };
}

function ensureMeta(force = false): Promise<void> {
  if (!onDesktopWindows()) return Promise.resolve();
  // 只缓存成功结果：失败后下一次挂载/重试要能立刻再读（`metaError` 非空
  // 时即使 ready 为真也重新加载）。
  if (
    !force &&
    snapshot?.ready &&
    !snapshot.metaError &&
    Date.now() - metaLoadedAt < META_TTL_MS
  ) {
    return Promise.resolve();
  }
  if (metaInFlight) return metaInFlight;
  metaInFlight = loadMeta().finally(() => {
    metaInFlight = null;
    metaLoadedAt = Date.now();
  });
  return metaInFlight;
}

async function loadMeta(): Promise<void> {
  const [distrosResult, capsResult] = await Promise.allSettled([
    ipc.wslDistros(),
    ipc.wslCliCapabilities(),
  ]);
  if (distrosResult.status === "rejected" || capsResult.status === "rejected") {
    const reason =
      distrosResult.status === "rejected"
        ? distrosResult.reason
        : capsResult.status === "rejected"
          ? capsResult.reason
          : null;
    emit({
      ...baseSnapshot(),
      distros: [],
      engines: [],
      ready: true,
      metaError: errorText(reason),
    });
    return;
  }

  const rawDistros = distrosResult.status === "fulfilled" ? distrosResult.value : [];
  const rawCaps = capsResult.status === "fulfilled" ? capsResult.value : null;
  const distros = Array.isArray(rawDistros)
    ? rawDistros.filter(
        (value): value is string => typeof value === "string" && value.length > 0,
      )
    : [];
  // SettingsPage.test 的 ipc Proxy 对未知方法返回 null：按形状兜底，
  // 不能把 null 灌进快照。
  const engines = Array.isArray(rawCaps?.engines)
    ? rawCaps.engines.filter(
        (value): value is string => typeof value === "string",
      )
    : [];

  const current = baseSnapshot();
  let requested = current.requested;
  let distro = current.distro;
  if (distros.length === 0) {
    // 没有发行版时退回本机，并清掉记忆：否则装好发行版后会突然跳回 WSL。
    requested = "host";
    distro = null;
    writeKey(SCOPE_KEY, null);
    writeKey(DISTRO_KEY, null);
  } else if (!distro || !distros.includes(distro)) {
    distro = distros[0];
    writeKey(DISTRO_KEY, distro);
  }

  emit({
    ...current,
    distros,
    engines,
    requested,
    distro,
    ready: true,
    metaError: null,
  });
}

function setScope(next: CliScope): void {
  const current = baseSnapshot();
  if (next === "wsl") {
    const distro =
      current.distro && current.distros.includes(current.distro)
        ? current.distro
        : current.distros[0];
    if (!distro) return; // 作用域控件只有在有发行版时才渲染
    writeKey(DISTRO_KEY, distro);
    writeKey(SCOPE_KEY, "wsl");
    emit({ ...current, requested: "wsl", distro });
    return;
  }
  writeKey(SCOPE_KEY, "host");
  emit({ ...current, requested: "host" });
}

function setDistro(next: string): void {
  const current = baseSnapshot();
  if (!current.distros.includes(next) || current.distro === next) return;
  writeKey(DISTRO_KEY, next);
  emit({ ...current, distro: next });
}

function reloadMeta(): void {
  void ensureMeta(true);
}

/**
 * 「设置 → WSL」重新检测后调用：发行版可能刚装上/卸载，CLI 作用域要能立刻
 * 看到。挂载快照不调用它，否则 30 秒缓存永远命中不了。
 */
export function invalidateWslCliMeta(): void {
  metaLoadedAt = 0;
  const reload = () => {
    void ensureMeta(true);
  };
  if (metaInFlight) {
    void metaInFlight.finally(reload);
    return;
  }
  reload();
}

/** Store seam: the hook is a thin `useSyncExternalStore` view over this. */
export const cliScopeStore = {
  subscribe,
  getSnapshot,
  ensureMeta,
  setScope,
  setDistro,
  reloadMeta,
};

export function useCliScope(engine: EngineId): CliScopeView {
  const current = useSyncExternalStore(
    cliScopeStore.subscribe,
    cliScopeStore.getSnapshot,
    cliScopeStore.getSnapshot,
  );
  const desktop = onDesktopWindows();
  const visible =
    desktop &&
    current.ready &&
    current.distros.length > 0 &&
    current.engines.includes(engine);
  const active: CliScope = visible ? current.requested : "host";
  // 只有桌面环境才需要「等元数据」：Web / 非 Windows 永远走本机，不该闪加载。
  const pending = desktop && !current.ready && current.requested === "wsl";
  return {
    ...current,
    visible,
    active,
    pending,
    setScope: cliScopeStore.setScope,
    setDistro: cliScopeStore.setDistro,
    reloadMeta: cliScopeStore.reloadMeta,
  };
}

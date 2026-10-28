import { useSyncExternalStore } from "react";
import type {
  Disposer,
  WorktreeBadge,
  WorktreeBadgeHandle,
  WorktreeBadgeTarget,
  WorktreeBadgeTone,
} from "@ccgui/plugin-sdk";
import { runAsPlugin } from "./hardening";
import { listWorktreeTargets, subscribeWorktreeTargets } from "./workspace-bridge";

/**
 * 侧栏 worktree 子行徽标（SDK 0.3.22，权限 `ui:worktree-badge`）。
 *
 * 推送式扩展点：插件注册一个「来源」，用 `set(workspaceId, badge)` 把自己
 * 的标签贴到某一行上——宿主不回调插件去算文本，因此徽标可以在没有任何
 * 行事件（PR 检查结果、任务计数）时由插件自己刷新。
 *
 * 放在 runtime 而不是 `packages/plugin-sdk`：它是宿主渲染状态（快照 + 订阅），
 * 插件只该看见句柄接口；把 store 摆进公共包等于把内部状态当契约发布。
 *
 * 归一化与上限都在写入侧完成（不是渲染侧）：坏数据进不来，快照永远是
 * 可直接渲染的不可变对象，渲染组件不做防御性判断。
 */

/** 每行最多显示的徽标数；超出按 order / 注册先后截断。 */
export const MAX_BADGES_PER_ROW = 2;
/** label 截断长度（按码点，避免把 emoji / 代理对劈开）。 */
const MAX_BADGE_LABEL = 6;
/** tooltip 截断长度（纯文本）。 */
const MAX_BADGE_TOOLTIP = 300;

const TONES: readonly WorktreeBadgeTone[] = [
  "neutral",
  "blue",
  "cyan",
  "green",
  "lime",
  "yellow",
  "rose",
  "purple",
];

const EMPTY: readonly ResolvedWorktreeBadge[] = Object.freeze([]);

/** 一块可渲染的徽标：已归一化，`onClick` 已绑定到具体行。 */
export interface ResolvedWorktreeBadge {
  /** 来源 key（同一行内唯一，作 React key）。 */
  key: string;
  label: string;
  tone: WorktreeBadgeTone;
  tooltip?: string;
  onClick?: () => void;
}

interface BadgeSource {
  /** 排序主键（缺省排在最后）。 */
  order: number;
  /** 同 order 时的注册先后。 */
  seq: number;
  badges: Map<string, WorktreeBadge>;
  /** 原始 onClick；行 id 在点击时解析成完整 target。 */
  onClick?: (workspaceId: string) => void;
}

function truncateCodePoints(text: string, max: number): string {
  const points = [...text];
  return points.length <= max ? text : points.slice(0, max).join("");
}

/** 归一化一块徽标；空 label / 非法形状 → null（= 不显示）。 */
export function normalizeWorktreeBadge(
  badge: WorktreeBadge | null | undefined,
): WorktreeBadge | null {
  if (!badge || typeof badge.label !== "string") return null;
  const label = truncateCodePoints(badge.label.trim(), MAX_BADGE_LABEL);
  if (!label) return null;
  const tone = TONES.includes(badge.tone) ? badge.tone : "neutral";
  const tooltip =
    typeof badge.tooltip === "string"
      ? truncateCodePoints(badge.tooltip.trim(), MAX_BADGE_TOOLTIP)
      : "";
  return { label, tone, ...(tooltip ? { tooltip } : {}) };
}

/** 行快照：未变化时复用上一份数组，别的行改徽标不让本行重渲染。 */
function sameRow(a: readonly ResolvedWorktreeBadge[], b: readonly ResolvedWorktreeBadge[]): boolean {
  return (
    a.length === b.length &&
    a.every(
      (badge, index) =>
        badge.key === b[index]!.key &&
        badge.label === b[index]!.label &&
        badge.tone === b[index]!.tone &&
        badge.tooltip === b[index]!.tooltip,
    )
  );
}

/** 插件徽标的状态容器：来源注册 → 行快照 → useSyncExternalStore。 */
export class WorktreeBadgeStore {
  private sources = new Map<string, BadgeSource>();
  private snapshot: Readonly<Record<string, readonly ResolvedWorktreeBadge[]>> = Object.freeze({});
  private listeners = new Set<() => void>();
  private seq = 0;

  /** 注册（或刷新）一个来源。同 key 重复注册保留已有徽标与排序位置：
   *  插件热重载/重新 activate 不该让自己的标签闪一下再回来。
   *  返回 source 对象，供 removeSource 做归属校验（过期 disposer 不能
   *  删掉同 key 的新注册，与 Registry 的 identity 检查一致）。 */
  registerSource(
    key: string,
    def: { order?: number; onClick?: (workspaceId: string) => void },
  ): BadgeSource {
    const existing = this.sources.get(key);
    const source: BadgeSource = {
      order: def.order ?? Number.MAX_SAFE_INTEGER,
      seq: existing?.seq ?? this.seq++,
      badges: existing?.badges ?? new Map(),
      onClick: def.onClick,
    };
    this.sources.set(key, source);
    this.emit();
    return source;
  }

  set(sourceKey: string, workspaceId: string, badge: WorktreeBadge | null): void {
    const source = this.sources.get(sourceKey);
    if (!source) return;
    const normalized = normalizeWorktreeBadge(badge);
    const previous = source.badges.get(workspaceId);
    if (normalized) {
      // Plugins often push the same badge on every backend tick; an identical
      // write must not wake every worktree row.
      if (
        previous &&
        previous.label === normalized.label &&
        previous.tone === normalized.tone &&
        previous.tooltip === normalized.tooltip
      ) {
        return;
      }
      source.badges.set(workspaceId, normalized);
    } else {
      if (!previous) return;
      source.badges.delete(workspaceId);
    }
    this.emit();
  }

  /** 清掉一个来源的全部徽标（订阅与来源本身保留）。 */
  clear(sourceKey: string): void {
    const source = this.sources.get(sourceKey);
    if (!source || source.badges.size === 0) return;
    source.badges.clear();
    this.emit();
  }

  /** 卸载：来源、徽标、排序位置一起消失。传 source 时只删同一次注册。 */
  removeSource(sourceKey: string, source?: BadgeSource): void {
    if (source && this.sources.get(sourceKey) !== source) return;
    if (!this.sources.delete(sourceKey)) return;
    this.emit();
  }

  getSnapshot = (): Readonly<Record<string, readonly ResolvedWorktreeBadge[]>> => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** 测试用：清空全部状态（不通知订阅者）。 */
  reset(): void {
    this.sources.clear();
    this.snapshot = Object.freeze({});
    this.seq = 0;
  }

  private emit(): void {
    const previous = this.snapshot;
    const rows = new Map<string, { badge: ResolvedWorktreeBadge; order: number; seq: number }[]>();
    for (const [key, source] of this.sources) {
      for (const [workspaceId, badge] of source.badges) {
        const resolved: ResolvedWorktreeBadge = Object.freeze({
          key,
          label: badge.label,
          tone: badge.tone,
          ...(badge.tooltip ? { tooltip: badge.tooltip } : {}),
          ...(source.onClick ? { onClick: () => source.onClick!(workspaceId) } : {}),
        });
        const list = rows.get(workspaceId) ?? [];
        list.push({ badge: resolved, order: source.order, seq: source.seq });
        rows.set(workspaceId, list);
      }
    }
    const next: Record<string, readonly ResolvedWorktreeBadge[]> = {};
    for (const [workspaceId, list] of rows) {
      list.sort((a, b) => a.order - b.order || a.seq - b.seq);
      const badges = Object.freeze(list.slice(0, MAX_BADGES_PER_ROW).map((entry) => entry.badge));
      const prior = previous[workspaceId];
      next[workspaceId] = prior && sameRow(prior, badges) ? prior : badges;
    }
    this.snapshot = Object.freeze(next);
    for (const listener of this.listeners) listener();
  }
}

export const worktreeBadgeStore = new WorktreeBadgeStore();

/** 某行当前应显示的徽标（已排序、已截断）；无徽标返回稳定空数组。 */
export function useWorktreeBadges(workspaceId: string | null | undefined): readonly ResolvedWorktreeBadge[] {
  return useSyncExternalStore(worktreeBadgeStore.subscribe, () =>
    workspaceId ? (worktreeBadgeStore.getSnapshot()[workspaceId] ?? EMPTY) : EMPTY,
  );
}

export interface WorktreeBadgeHandleArgs {
  pluginId: string;
  /** 来源 key（scopedPluginId(id, def.key)）。 */
  sourceKey: string;
  /** manifest 是否声明了 host:workspace（list/onChange 的额外门禁）。 */
  canReadWorkspaces: boolean;
  order?: number;
  /** 原始 onClick；宿主负责 runAsPlugin 与 target 解析。 */
  onClick?: (target: WorktreeBadgeTarget) => void;
  /** 插件 disposer 栈（卸载时兜底回收）。 */
  track: (disposer: Disposer) => Disposer;
}

/** `ctx.ui.registerWorktreeBadges` 的宿主实现。 */
export function createWorktreeBadgeHandle(args: WorktreeBadgeHandleArgs): WorktreeBadgeHandle {
  const { pluginId, sourceKey, canReadWorkspaces, order, onClick, track } = args;
  const source = worktreeBadgeStore.registerSource(sourceKey, {
    order,
    onClick: onClick
      ? (workspaceId) => {
          const target = listWorktreeTargets().find((row) => row.workspaceId === workspaceId);
          if (!target) return;
          // 同 onChange：插件同步抛错不能冒进宿主点击路径。
          try {
            runAsPlugin(() => onClick(target));
          } catch (error) {
            console.error(`[plugins] "${pluginId}" worktree badge onClick threw`, error);
          }
        }
      : undefined,
  });

  const subscriptions = new Set<Disposer>();
  let disposed = false;
  const requireWorkspace = (method: string) => {
    if (!canReadWorkspaces) {
      throw new Error(
        `[plugins] "${pluginId}" worktree badges ${method}() requires "host:workspace" in permissions`,
      );
    }
  };
  const assertLive = (method: string) => {
    if (disposed) {
      throw new Error(`[plugins] "${pluginId}" worktree badges ${method}() called after dispose()`);
    }
  };
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    for (const off of subscriptions) off();
    subscriptions.clear();
    worktreeBadgeStore.removeSource(sourceKey, source);
  };

  const handle: WorktreeBadgeHandle = {
    list() {
      requireWorkspace("list");
      assertLive("list");
      return listWorktreeTargets();
    },
    onChange(cb) {
      requireWorkspace("onChange");
      assertLive("onChange");
      if (typeof cb !== "function") {
        throw new Error(`[plugins] "${pluginId}" worktree badges onChange() expects a callback`);
      }
      const off = subscribeWorktreeTargets((targets) => {
        // 插件回调抛错不能截断 chat store 的通知链（排在后面的宿主订阅者
        // 会收不到这次更新）；与 pluginBus / hooks 的逐回调隔离一致。
        try {
          runAsPlugin(() => cb(targets));
        } catch (error) {
          console.error(`[plugins] "${pluginId}" worktree badges onChange threw`, error);
        }
      });
      const unsubscribe = (): void => {
        subscriptions.delete(off);
        off();
      };
      subscriptions.add(off);
      return track(unsubscribe);
    },
    set(workspaceId, badge) {
      assertLive("set");
      if (typeof workspaceId !== "string" || workspaceId.trim() === "") {
        throw new Error(`[plugins] "${pluginId}" worktree badges set() expects a workspace id`);
      }
      worktreeBadgeStore.set(sourceKey, workspaceId, badge);
    },
    clear() {
      assertLive("clear");
      worktreeBadgeStore.clear(sourceKey);
    },
    dispose,
  };
  track(dispose);
  return handle;
}

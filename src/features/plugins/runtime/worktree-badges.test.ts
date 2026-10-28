import { beforeEach, describe, expect, it, vi } from "vitest";

const mockBridge = vi.hoisted(() => ({
  targets: [] as {
    workspaceId: string;
    parentWorkspaceId: string;
    path: string;
    branch: string;
    prNumber: number | null;
  }[],
  listeners: [] as ((targets: unknown[]) => void)[],
}));

vi.mock("./workspace-bridge", () => ({
  listWorktreeTargets: () => mockBridge.targets,
  subscribeWorktreeTargets: (cb: (targets: unknown[]) => void) => {
    mockBridge.listeners.push(cb);
    return () => {
      mockBridge.listeners = mockBridge.listeners.filter((entry) => entry !== cb);
    };
  },
}));

import {
  MAX_BADGES_PER_ROW,
  WorktreeBadgeStore,
  createWorktreeBadgeHandle,
  normalizeWorktreeBadge,
  worktreeBadgeStore,
  type ResolvedWorktreeBadge,
} from "./worktree-badges";

function labelsOf(store: WorktreeBadgeStore, workspaceId: string): string[] {
  return (store.getSnapshot()[workspaceId] ?? []).map((badge) => badge.label);
}

describe("normalizeWorktreeBadge", () => {
  it("trims the label and truncates by code point, not UTF-16 unit", () => {
    expect(normalizeWorktreeBadge({ label: "  PR ready  ", tone: "blue" })).toEqual({
      label: "PR rea",
      tone: "blue",
    });
    expect(normalizeWorktreeBadge({ label: "🔥🔥🔥🔥🔥🔥🔥", tone: "green" })?.label).toBe(
      "🔥🔥🔥🔥🔥🔥",
    );
  });

  it("falls back to neutral for tones outside the whitelist", () => {
    expect(normalizeWorktreeBadge({ label: "x", tone: "magenta" as never })?.tone).toBe("neutral");
    expect(normalizeWorktreeBadge({ label: "x", tone: "purple" })?.tone).toBe("purple");
  });

  it("truncates tooltips to 300 characters and treats an empty label as no badge", () => {
    const tooltip = "a".repeat(400);
    expect(normalizeWorktreeBadge({ label: "x", tone: "cyan", tooltip })?.tooltip).toHaveLength(300);
    expect(normalizeWorktreeBadge({ label: "x", tone: "cyan", tooltip: "   " })).toEqual({
      label: "x",
      tone: "cyan",
    });
    expect(normalizeWorktreeBadge({ label: "    ", tone: "cyan" })).toBeNull();
    expect(normalizeWorktreeBadge(null)).toBeNull();
  });
});

describe("WorktreeBadgeStore", () => {
  let store: WorktreeBadgeStore;

  beforeEach(() => {
    store = new WorktreeBadgeStore();
  });

  it("sorts by order then registration, and caps each row at two badges", () => {
    store.registerSource("plugin.c", {});
    store.registerSource("plugin.b", { order: 20 });
    store.registerSource("plugin.a", { order: 10 });
    store.set("plugin.c", "wt", { label: "C", tone: "rose" });
    store.set("plugin.b", "wt", { label: "B", tone: "blue" });
    store.set("plugin.a", "wt", { label: "A", tone: "green" });
    expect(labelsOf(store, "wt")).toEqual(["A", "B"]);
    expect(store.getSnapshot()["wt"]).toHaveLength(MAX_BADGES_PER_ROW);
  });

  it("freezes snapshots and reuses a row array when that row did not change", () => {
    store.registerSource("plugin.a", {});
    store.set("plugin.a", "wt-1", { label: "A", tone: "blue" });
    const first = store.getSnapshot();
    store.registerSource("plugin.b", {});
    store.set("plugin.b", "wt-2", { label: "B", tone: "rose" });
    const second = store.getSnapshot();
    expect(second).not.toBe(first);
    expect(second["wt-1"]).toBe(first["wt-1"]);
    expect(Object.isFrozen(second["wt-1"])).toBe(true);
    expect(Object.isFrozen(second["wt-1"]![0])).toBe(true);
  });

  it("keeps the plugin's snapshot copy detached from the store", () => {
    store.registerSource("plugin.a", {});
    store.set("plugin.a", "wt-1", { label: "A", tone: "blue" });
    const snapshot = store.getSnapshot()["wt-1"]!;
    expect(() => (snapshot as ResolvedWorktreeBadge[]).push(snapshot[0]!)).toThrow();
    expect(store.getSnapshot()["wt-1"]).toHaveLength(1);
  });

  it("clear() drops one source's badges; removeSource() drops the source entirely", () => {
    store.registerSource("plugin.a", {});
    store.registerSource("plugin.b", {});
    store.set("plugin.a", "wt-1", { label: "A", tone: "blue" });
    store.set("plugin.b", "wt-1", { label: "B", tone: "rose" });
    store.clear("plugin.a");
    expect(labelsOf(store, "wt-1")).toEqual(["B"]);
    store.removeSource("plugin.b");
    expect(labelsOf(store, "wt-1")).toEqual([]);
  });

  it("setting null removes just that row's badge", () => {
    store.registerSource("plugin.a", {});
    store.set("plugin.a", "wt-1", { label: "A", tone: "blue" });
    store.set("plugin.a", "wt-2", { label: "B", tone: "cyan" });
    store.set("plugin.a", "wt-1", null);
    expect(store.getSnapshot()["wt-1"]).toBeUndefined();
    expect(labelsOf(store, "wt-2")).toEqual(["B"]);
  });

  it("notifies subscribers on mutations and ignores identical writes", () => {
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    store.registerSource("plugin.a", {});
    store.set("plugin.a", "wt-1", { label: "A", tone: "blue" });
    // 插件常见做法：每次后端 tick 都推同一块徽标——不能每次都惊动所有行。
    store.set("plugin.a", "wt-1", { label: "A", tone: "blue" });
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
    store.clear("plugin.a");
    expect(listener).toHaveBeenCalledTimes(2);
  });
});

describe("createWorktreeBadgeHandle", () => {
  beforeEach(() => {
    worktreeBadgeStore.reset();
    mockBridge.targets = [];
    mockBridge.listeners = [];
  });

  it("gates list()/onChange() on host:workspace but still allows set()", () => {
    const handle = createWorktreeBadgeHandle({
      pluginId: "test-plugin",
      sourceKey: "test-plugin",
      canReadWorkspaces: false,
      track: (disposer) => disposer,
    });
    expect(() => handle.list()).toThrow(/host:workspace/);
    expect(() => handle.onChange(() => {})).toThrow(/host:workspace/);
    handle.set("wt-1", { label: "ok", tone: "blue" });
    expect(worktreeBadgeStore.getSnapshot()["wt-1"]?.[0]?.label).toBe("ok");
    handle.dispose();
  });

  it("resolves the clicked row into a full target", () => {
    const target = {
      workspaceId: "wt-1",
      parentWorkspaceId: "parent",
      path: "/repo-wt/branch",
      branch: "branch",
      prNumber: 42,
    };
    mockBridge.targets = [target];
    const onClick = vi.fn();
    const handle = createWorktreeBadgeHandle({
      pluginId: "test-plugin",
      sourceKey: "test-plugin",
      canReadWorkspaces: true,
      onClick,
      track: (disposer) => disposer,
    });
    handle.set("wt-1", { label: "PR", tone: "purple" });
    worktreeBadgeStore.getSnapshot()["wt-1"]![0]!.onClick?.();
    expect(onClick).toHaveBeenCalledWith(target);
    handle.dispose();
  });

  it("does not call onClick when the row disappeared before the click", () => {
    const onClick = vi.fn();
    const handle = createWorktreeBadgeHandle({
      pluginId: "test-plugin",
      sourceKey: "test-plugin",
      canReadWorkspaces: true,
      onClick,
      track: (disposer) => disposer,
    });
    handle.set("gone", { label: "PR", tone: "purple" });
    worktreeBadgeStore.getSnapshot()["gone"]![0]!.onClick?.();
    expect(onClick).not.toHaveBeenCalled();
    handle.dispose();
  });

  it("subscribes through the bridge and unsubscribes on dispose", () => {
    const handle = createWorktreeBadgeHandle({
      pluginId: "test-plugin",
      sourceKey: "test-plugin",
      canReadWorkspaces: true,
      track: (disposer) => disposer,
    });
    const onChange = vi.fn();
    handle.onChange(onChange);
    expect(mockBridge.listeners).toHaveLength(1);
    handle.set("wt-1", { label: "A", tone: "blue" });
    handle.dispose();
    expect(mockBridge.listeners).toHaveLength(0);
    expect(worktreeBadgeStore.getSnapshot()["wt-1"]).toBeUndefined();
    expect(() => handle.set("wt-1", { label: "B", tone: "blue" })).toThrow(/dispose/);
  });

  it("isolates onClick errors from the host click path", () => {
    mockBridge.targets = [
      { workspaceId: "wt-1", parentWorkspaceId: "p", path: "/x", branch: "b", prNumber: 1 },
    ];
    const handle = createWorktreeBadgeHandle({
      pluginId: "test-plugin",
      sourceKey: "test-plugin",
      canReadWorkspaces: true,
      onClick: () => {
        throw new Error("click boom");
      },
      track: (disposer) => disposer,
    });
    handle.set("wt-1", { label: "A", tone: "blue" });
    expect(() => worktreeBadgeStore.getSnapshot()["wt-1"]![0]!.onClick?.()).not.toThrow();
    handle.dispose();
  });

  it("isolates onChange callback errors from the chat store notifier", () => {
    const handle = createWorktreeBadgeHandle({
      pluginId: "test-plugin",
      sourceKey: "test-plugin",
      canReadWorkspaces: true,
      track: (disposer) => disposer,
    });
    handle.onChange(() => {
      throw new Error("boom");
    });
    expect(() => {
      for (const listener of mockBridge.listeners) listener([]);
    }).not.toThrow();
    handle.dispose();
  });

  it("a stale handle's dispose() cannot remove a newer registration", () => {
    const make = () =>
      createWorktreeBadgeHandle({
        pluginId: "test-plugin",
        sourceKey: "test-plugin",
        canReadWorkspaces: true,
        track: (disposer) => disposer,
      });
    const first = make();
    first.set("wt-1", { label: "A", tone: "blue" });
    const second = make();
    second.set("wt-2", { label: "B", tone: "rose" });
    first.dispose();
    expect(worktreeBadgeStore.getSnapshot()["wt-2"]?.[0]?.label).toBe("B");
    second.set("wt-3", { label: "C", tone: "green" });
    expect(worktreeBadgeStore.getSnapshot()["wt-3"]?.[0]?.label).toBe("C");
    second.dispose();
    expect(worktreeBadgeStore.getSnapshot()["wt-2"]).toBeUndefined();
  });

  it("clear() keeps subscriptions alive", () => {
    const handle = createWorktreeBadgeHandle({
      pluginId: "test-plugin",
      sourceKey: "test-plugin",
      canReadWorkspaces: true,
      track: (disposer) => disposer,
    });
    handle.onChange(() => {});
    handle.set("wt-1", { label: "A", tone: "blue" });
    handle.clear();
    expect(worktreeBadgeStore.getSnapshot()["wt-1"]).toBeUndefined();
    expect(mockBridge.listeners).toHaveLength(1);
    handle.dispose();
  });
});

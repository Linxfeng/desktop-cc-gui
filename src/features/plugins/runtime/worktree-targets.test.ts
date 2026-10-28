import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorktreeBadgeTarget } from "@ccgui/plugin-sdk";

const chat = vi.hoisted(() => ({
  state: { workspaces: [] as Record<string, unknown>[] },
  listeners: new Set<() => void>(),
}));

vi.mock("@/features/chat/store", () => ({
  useChatStore: {
    getState: () => chat.state,
    subscribe: (listener: () => void) => {
      chat.listeners.add(listener);
      return () => {
        chat.listeners.delete(listener);
      };
    },
  },
}));

import { listWorktreeTargets, subscribeWorktreeTargets } from "./workspace-bridge";

function worktree(
  id: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id,
    path: `/repo-worktrees/${id}`,
    name: id,
    kind: "worktree",
    parentId: "parent",
    groupId: null,
    lastOpenedAt: null,
    meta: { worktree: { branch: `branch-${id}` } },
    ...overrides,
  };
}

function setWorkspaces(next: Record<string, unknown>[]): void {
  chat.state = { workspaces: next };
  for (const listener of chat.listeners) listener();
}

beforeEach(() => {
  chat.listeners.clear();
  chat.state = { workspaces: [] };
});

describe("listWorktreeTargets", () => {
  it("projects only worktree children and normalises a missing PR to null", () => {
    chat.state = {
      workspaces: [
        { id: "plain", path: "/repo", name: "repo", groupId: null, lastOpenedAt: 1 },
        worktree("wt-plain"),
        worktree("wt-pr", { meta: { worktree: { branch: "pr-9", prNumber: 9 } } }),
        worktree("wt-broken", { meta: { worktree: {} } }),
      ],
    };
    expect(listWorktreeTargets()).toEqual<WorktreeBadgeTarget[]>([
      {
        workspaceId: "wt-plain",
        parentWorkspaceId: "parent",
        path: "/repo-worktrees/wt-plain",
        branch: "branch-wt-plain",
        prNumber: null,
      },
      {
        workspaceId: "wt-pr",
        parentWorkspaceId: "parent",
        path: "/repo-worktrees/wt-pr",
        branch: "pr-9",
        prNumber: 9,
      },
    ]);
  });

  it("returns a fresh array the plugin cannot use to mutate the store", () => {
    chat.state = { workspaces: [worktree("wt")] };
    const first = listWorktreeTargets();
    first.push({
      workspaceId: "injected",
      parentWorkspaceId: "parent",
      path: "/x",
      branch: "x",
      prNumber: null,
    });
    expect(listWorktreeTargets()).toHaveLength(1);
  });
});

describe("subscribeWorktreeTargets", () => {
  it("ignores changes that do not touch worktree rows, branch, path or PR", () => {
    chat.state = { workspaces: [worktree("wt")] };
    const cb = vi.fn();
    const unsubscribe = subscribeWorktreeTargets(cb);

    // Rename / group / last-opened churn (sidebar reorder, unread badge) must
    // not wake every badge-owning plugin.
    setWorkspaces([
      worktree("wt", { name: "renamed", groupId: "g1", lastOpenedAt: 123 }),
      { id: "plain", path: "/repo", name: "repo", groupId: null, lastOpenedAt: null },
    ]);
    expect(cb).not.toHaveBeenCalled();

    unsubscribe();
  });

  it("fires when a worktree is added, removed, or its branch/path/PR changes", () => {
    chat.state = { workspaces: [worktree("wt")] };
    const cb = vi.fn();
    const unsubscribe = subscribeWorktreeTargets(cb);

    setWorkspaces([worktree("wt"), worktree("wt-2")]);
    expect(cb).toHaveBeenLastCalledWith([
      expect.objectContaining({ workspaceId: "wt" }),
      expect.objectContaining({ workspaceId: "wt-2" }),
    ]);

    setWorkspaces([
      worktree("wt", { path: "/elsewhere/wt" }),
      worktree("wt-2"),
    ]);
    expect(cb).toHaveBeenCalledTimes(2);

    setWorkspaces([
      worktree("wt", {
        path: "/elsewhere/wt",
        meta: { worktree: { branch: "branch-wt", prNumber: 11 } },
      }),
      worktree("wt-2"),
    ]);
    expect(cb).toHaveBeenCalledTimes(3);

    setWorkspaces([worktree("wt")]);
    expect(cb).toHaveBeenCalledTimes(4);

    unsubscribe();
  });

  it("stops notifying after unsubscribe", () => {
    chat.state = { workspaces: [worktree("wt")] };
    const cb = vi.fn();
    subscribeWorktreeTargets(cb)();
    setWorkspaces([worktree("wt"), worktree("wt-2")]);
    expect(cb).not.toHaveBeenCalled();
  });
});

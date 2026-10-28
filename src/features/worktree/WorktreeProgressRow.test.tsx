import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vitest";
import i18n from "@/lib/i18n";
import type { PendingCreation } from "./store";
import { WorktreeProgressRow } from "./WorktreeProgressRow";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function failed(over: Partial<PendingCreation>): PendingCreation {
  return {
    creationId: "c1",
    parentWorkspaceId: "w1",
    parentPath: "/repo",
    branch: "feat",
    stage: "failed",
    args: {
      repoPath: "/repo",
      parentWorkspaceId: "w1",
      branch: "feat",
      worktreePath: "/repo-worktrees/feat",
      baseRef: null,
      prNumber: null,
      prTitle: null,
      prUrl: null,
      existingBranch: false,
    },
    openSessionAfter: false,
    ...over,
  };
}

let container: HTMLDivElement;
let root: Root;

beforeEach(async () => {
  await i18n.changeLanguage("zh");
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

it("shows why a repository that exists could not be opened", () => {
  const cause = "GIT_UNSAFE_REPO:repository path '/repo' is not owned by current user";
  act(() => root.render(<WorktreeProgressRow pending={failed({ errorKind: "repo_open_failed", error: cause })} />));

  const text = container.querySelector('[role="alert"]')!.textContent!;
  expect(text).toContain("所有权不受信任");
  expect(text).not.toContain("不是 Git 仓库");
  expect(text).not.toContain("GIT_UNSAFE_REPO");
  // The row truncates to one line; the full reason stays readable on hover.
  const line = container.querySelector<HTMLElement>("span[title]")!;
  expect(line.title).toContain("safe.directory");
});

it("keeps the not-a-repository wording for a plain directory", () => {
  act(() => root.render(<WorktreeProgressRow pending={failed({ errorKind: "not_a_repo", error: "/repo is not a git repository" })} />));

  expect(container.querySelector('[role="alert"]')!.textContent).toContain("当前工作区不是 Git 仓库");
});

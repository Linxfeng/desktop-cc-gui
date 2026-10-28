import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AiChatSidebar, type AiChatRepo } from "./ai-chat-sidebar";
import { worktreeBadgeStore } from "@/features/plugins/runtime/worktree-badges";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  initReactI18next: { type: "3rdParty", init: () => {} },
}));

let node: HTMLDivElement;
let root: Root;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  localStorage.clear();
  worktreeBadgeStore.reset();
  node = document.createElement("div");
  document.body.append(node);
  root = createRoot(node);
});

afterEach(async () => {
  await act(async () => root.unmount());
  node.remove();
  worktreeBadgeStore.reset();
});

const WORKTREE_ID = "a::pr-1865";

function repos(): AiChatRepo[] {
  return [
    {
      id: "a",
      label: "a",
      defaultOpen: true,
      threads: [],
      worktrees: [
        {
          id: WORKTREE_ID,
          label: "pr-1865-fix",
          threads: [],
          worktree: { branch: "pr-1865-fix", prNumber: 1865 },
        },
      ],
    },
  ];
}

async function render(): Promise<HTMLElement> {
  await act(async () => {
    root.render(<AiChatSidebar repos={repos()} />);
  });
  const row = node.querySelector<HTMLElement>('button[aria-label="pr-1865-fix"]');
  if (!row) throw new Error("no worktree child row");
  return row;
}

it("无徽标时 worktree 行不产生任何额外 DOM", async () => {
  const toggle = await render();
  const row = toggle.parentElement!;
  const before = row.innerHTML;
  expect(row.children).toHaveLength(2); // toggle + PR# chip

  // 另一个 worktree 的徽标变化不该在本行留下痕迹（也不该多包一层容器）。
  await act(async () => {
    worktreeBadgeStore.registerSource("plugin.other", {});
    worktreeBadgeStore.set("plugin.other", "a::other", { label: "OTHER", tone: "blue" });
  });
  expect(row.innerHTML).toBe(before);
});

it("徽标渲染在分支名之后、PR# 之前，并带 tone 视觉", async () => {
  const toggle = await render();
  const row = toggle.parentElement!;
  await act(async () => {
    worktreeBadgeStore.registerSource("plugin.git-tasks", {});
    worktreeBadgeStore.set("plugin.git-tasks", WORKTREE_ID, {
      label: "TASK",
      tone: "cyan",
      tooltip: "task #12",
    });
  });

  const children = [...row.children];
  const chip = children.find((el) => el.textContent === "TASK");
  const prChip = children.find((el) => el.textContent === "worktree.prBadge");
  if (!chip || !prChip) throw new Error("missing chip or PR badge");
  expect(children.indexOf(chip)).toBe(children.indexOf(toggle) + 1);
  expect(children.indexOf(chip)).toBeLessThan(children.indexOf(prChip));
  expect(chip.className).toContain("bg-status-cyan-background");
  expect(chip.className).toContain("text-caption-2-medium");
  expect(chip.getAttribute("title")).toBe("task #12");
});

it("可点徽标是真按钮：点击调用插件回调但不展开行，且可键盘聚焦", async () => {
  const toggle = await render();
  const onClick = vi.fn();
  await act(async () => {
    worktreeBadgeStore.registerSource("plugin.git-tasks", { onClick });
    worktreeBadgeStore.set("plugin.git-tasks", WORKTREE_ID, { label: "TASK", tone: "blue" });
  });

  const chip = [...toggle.parentElement!.children].find(
    (el) => el.textContent === "TASK",
  ) as HTMLButtonElement | undefined;
  if (!chip) throw new Error("missing clickable chip");
  expect(chip.tagName).toBe("BUTTON");
  expect(toggle.getAttribute("aria-expanded")).toBe("false");

  await act(async () => chip.click());
  expect(onClick).toHaveBeenCalledTimes(1);
  expect(toggle.getAttribute("aria-expanded")).toBe("false");

  chip.focus();
  expect(document.activeElement).toBe(chip);
});

it("不可点徽标是 span，不进入 tab 顺序", async () => {
  const toggle = await render();
  await act(async () => {
    worktreeBadgeStore.registerSource("plugin.readonly", {});
    worktreeBadgeStore.set("plugin.readonly", WORKTREE_ID, { label: "1/3", tone: "neutral" });
  });
  const chip = [...toggle.parentElement!.children].find(
    (el) => el.textContent === "1/3",
  );
  if (!chip) throw new Error("missing static chip");
  expect(chip.tagName).toBe("SPAN");
  expect(chip.className).toContain("bg-background-tertiary-default");
});

it("每行最多两个徽标", async () => {
  const toggle = await render();
  await act(async () => {
    worktreeBadgeStore.registerSource("plugin.a", { order: 1 });
    worktreeBadgeStore.registerSource("plugin.b", { order: 2 });
    worktreeBadgeStore.registerSource("plugin.c", { order: 3 });
    worktreeBadgeStore.set("plugin.a", WORKTREE_ID, { label: "AA", tone: "blue" });
    worktreeBadgeStore.set("plugin.b", WORKTREE_ID, { label: "BB", tone: "rose" });
    worktreeBadgeStore.set("plugin.c", WORKTREE_ID, { label: "CC", tone: "lime" });
  });
  const texts = [...toggle.parentElement!.children].map((el) => el.textContent);
  expect(texts).toContain("AA");
  expect(texts).toContain("BB");
  expect(texts).not.toContain("CC");
});

"use client";

import type { WorktreeBadgeTone } from "@ccgui/plugin-sdk";
import { useWorktreeBadges } from "@/features/plugins/runtime/worktree-badges";
import { cx } from "@/utils/cx";

/**
 * 侧栏 worktree 子行上的插件徽标（SDK 0.3.22，`ctx.ui.registerWorktreeBadges`）。
 *
 * 视觉与同行的「PR#n」「目录已丢失」一致：`rounded-sm px-1 py-px` +
 * `text-caption-2-medium`，底色/文字取自 `status-<tone>-*` token（neutral 用
 * 中性背景，与线程计数 pill 同款）。没有徽标时渲染 null——行 DOM 与没有
 * 这个扩展点时完全一致。
 *
 * 可点徽标用真 `<button>`，因此挂在行的展开按钮**外面**（同级 sibling），
 * 并按 `stopPropagation` 阻止行展开：交互元素不能嵌在 `<button>` 里
 * （repo-tree 的图标/＋按钮同样是 sibling，见该文件的行注释）。
 */
const TONE_CLASS: Record<WorktreeBadgeTone, string> = {
  neutral: "bg-background-tertiary-default text-text-secondary",
  blue: "bg-status-blue-background text-status-blue-text",
  cyan: "bg-status-cyan-background text-status-cyan-text",
  green: "bg-status-green-background text-status-green-text",
  lime: "bg-status-lime-background text-status-lime-text",
  yellow: "bg-status-yellow-background text-status-yellow-text",
  rose: "bg-status-rose-background text-status-rose-text",
  purple: "bg-status-purple-background text-status-purple-text",
};

const CHIP_CLASS =
  "max-w-[9rem] shrink-0 truncate rounded-sm px-1 py-px text-caption-2-medium";

export function WorktreeBadgeChips({ workspaceId }: { workspaceId?: string }) {
  const badges = useWorktreeBadges(workspaceId);
  if (badges.length === 0) return null;
  return (
    <>
      {badges.map((badge) =>
        badge.onClick ? (
          <button
            key={badge.key}
            type="button"
            title={badge.tooltip}
            onClick={(event) => {
              event.stopPropagation();
              badge.onClick?.();
            }}
            className={cx(
              CHIP_CLASS,
              TONE_CLASS[badge.tone],
              "cursor-pointer outline-none transition-opacity duration-150 ease hover:opacity-80 focus-visible:ring-2 focus-visible:ring-border-focus-ring",
            )}
          >
            {badge.label}
          </button>
        ) : (
          <span
            key={badge.key}
            title={badge.tooltip}
            className={cx(CHIP_CLASS, TONE_CLASS[badge.tone])}
          >
            {badge.label}
          </span>
        ),
      )}
    </>
  );
}

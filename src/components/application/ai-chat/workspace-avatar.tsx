import { useState, type ReactNode } from "react";
import { useWorkspaceAvatarUrl } from "@/features/chat/workspace-avatars";
import { cx } from "@/utils/cx";

/**
 * Leading identity tile of a workspace row: the GitHub owner avatar behind
 * the repo's `origin` remote when there is one, otherwise the caller's
 * fallback (the folder glyph). The fallback stays underneath while the image
 * loads, so a slow network or an offline machine never shows a broken image
 * or an empty slot. Purely decorative — the row label carries the identity.
 */
export function WorkspaceAvatar({
  path,
  fallback,
  className,
}: {
  /** Workspace path, the cache key for the resolved GitHub owner. */
  path?: string;
  /** Shown until the avatar loads, and whenever no owner resolves. */
  fallback: ReactNode;
  className?: string;
}) {
  const src = useWorkspaceAvatarUrl(path, 20);
  // Tracked per URL instead of a flag: a reordered/recycled row can swap
  // workspaces without remounting, and a different repo deserves a new try.
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const showImage = src !== null && src !== failedSrc;
  return (
    <span
      className={cx("relative flex size-5 shrink-0 items-center justify-center", className)}
    >
      {fallback}
      {showImage ? (
        <img
          src={src}
          alt=""
          referrerPolicy="no-referrer"
          draggable={false}
          onError={() => setFailedSrc(src)}
          className="absolute inset-0 size-full rounded-[5px] object-cover"
        />
      ) : null}
    </span>
  );
}

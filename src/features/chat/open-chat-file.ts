import { useMemo } from "react";
import { useFilesStore } from "@/features/files/store";
import { resolveFilePath } from "@/lib/fileLinks";
import { resolveChatFileLink } from "./file-link-resolution";

/**
 * Open a path the transcript names (a file chip, a markdown file link) in the
 * center editor. Async on purpose: a path that only exists nested below the
 * workspace root (outer folder opened as workspace) is found through the index
 * fallback instead of dead-ending in a not-found tab.
 *
 * Resolution can reject only by returning null, so an unresolvable path is a
 * silent no-op — the same contract the markdown links already rely on.
 */
export function openChatFilePath(rawPath: string, workspacePath: string): void {
  void resolveChatFileLink(rawPath, workspacePath).then((path) => {
    if (!path) return;
    void useFilesStore.getState().openFile(path);
  });
}

/** Opener bound to one session workspace, handed down to the tool chips. */
export interface ChatFileOpener {
  /** False for paths the resolver rejects outright (`~/`, `../`): a chip for
   *  them would be a button that never opens anything. */
  canOpen: (rawPath: string) => boolean;
  open: (rawPath: string) => void;
}

/** Null without a workspace root: a relative tool path has nothing to anchor
 *  on, and an affordance that always no-ops is worse than no affordance.
 *  Memoized on the root — the opener reaches memoized tool rows, and a fresh
 *  object per render would re-render every settled row on each stream flush. */
export function useChatFileOpener(workspacePath: string): ChatFileOpener | null {
  const root = workspacePath.trim();
  return useMemo(
    () =>
      root
        ? {
            canOpen: (rawPath: string) => resolveFilePath(rawPath, root) !== null,
            open: (rawPath: string) => openChatFilePath(rawPath, root),
          }
        : null,
    [root],
  );
}

import {
  isEditableShortcutTarget,
  matchesShortcutForPlatform,
} from "@/features/shortcuts/shortcuts";
import { useFilesStore } from "./store";
import { useFileTreeVirtualList } from "./useFileTreeVirtualList";
import { useFileTreeOperations } from "./useFileTreeOperations";
import { FileTreeBody } from "./FileTreeBody";
import { FileTreeOverlays } from "./FileTreeOverlays";
import { COLLAPSE_ALL_SHORTCUT, EXPAND_LOADED_SHORTCUT } from "./tree-shortcuts";

/** The tree itself carries no chrome: its bulk actions (refresh / expand
 *  loaded / collapse all) live on the synthetic root row, revealed on that
 *  row's hover, so the list starts directly under the panel's tab strip. */
export function FileTree() {
  const { parentRef, virtualizer, visible } = useFileTreeVirtualList();
  const ops = useFileTreeOperations();
  const expandLoadedDirs = useFilesStore((s) => s.expandLoadedDirs);
  const collapseAllDirs = useFilesStore((s) => s.collapseAllDirs);

  return (
    // tabIndex -1: WebKit (the macOS app) does not focus a clicked <button>
    // but the nearest focusable ancestor, so without it a mouse click on a
    // row leaves focus outside the tree and the keys never arrive here.
    <div
      tabIndex={-1}
      className="relative flex min-h-0 flex-1 flex-col outline-none"
      onKeyDown={(event) => {
        if (isEditableShortcutTarget(event.target)) return;
        if (matchesShortcutForPlatform(event.nativeEvent, EXPAND_LOADED_SHORTCUT)) expandLoadedDirs();
        else if (matchesShortcutForPlatform(event.nativeEvent, COLLAPSE_ALL_SHORTCUT)) collapseAllDirs();
        else return;
        event.preventDefault();
      }}
    >
      <div ref={parentRef} className="min-h-0 flex-1 overflow-auto py-1">
        <FileTreeBody
          virtualizer={virtualizer}
          visible={visible}
          onContextMenu={ops.openContextMenu}
        />
        <FileTreeOverlays ops={ops} />
      </div>
    </div>
  );
}

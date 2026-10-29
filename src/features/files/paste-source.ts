import type { ClipboardFileSnapshot } from "@/lib/ipc";
import type { TreeClipboard } from "./store";

export type PasteSource = "tree" | "system" | "none";

/**
 * Which clipboard a file-tree Paste copies from.
 *
 * The tree item wins while the OS clipboard still reports the generation its
 * Copy recorded: nothing was copied anywhere since, so whatever the OS holds
 * is either that same item (at its pre-rename path) or an older list a
 * failed write left behind. It also wins when no generation can be compared
 * (Linux, the web bridge, or a Copy that never learned one), because it is
 * then the newest copy this app knows of. Once the generation moved, the OS
 * clipboard holds a newer copy: paste its files, or nothing when that newer
 * copy is only text.
 */
export function choosePasteSource(
  snapshot: ClipboardFileSnapshot,
  tree: TreeClipboard | null,
): PasteSource {
  if (tree) {
    const comparable = snapshot.changeCount !== null && tree.osChangeCount != null;
    if (!comparable || snapshot.changeCount === tree.osChangeCount) return "tree";
  }
  return snapshot.paths.length > 0 ? "system" : "none";
}

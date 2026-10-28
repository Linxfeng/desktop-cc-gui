import { useCallback, useEffect, useState, type MouseEvent } from "react";
import { useTranslation } from "react-i18next";
import FileText from "lucide-react/dist/esm/icons/file-text";
import FolderOpen from "lucide-react/dist/esm/icons/folder-open";
import Globe from "lucide-react/dist/esm/icons/globe";
import Link2 from "lucide-react/dist/esm/icons/link-2";
import { ContextMenu, type ContextMenuEntry } from "@/components/context-menu";
import { copyText } from "@/lib/clipboard";
import { ipc, type GitFileEntry } from "@/lib/ipc";
import { isWeb } from "@/lib/platform";
import { canOpenInBrowser } from "@/features/files/editor-view-mode";
import { joinPath, useFilesStore } from "@/features/files/store";

export interface ChangesFileMenuState {
  x: number;
  y: number;
  /** Repo-relative path as listed by `git status`. */
  path: string;
  /** Absolute path, resolved against the repository the row belonged to
   *  when the menu opened — a later repo switch cannot retarget it. */
  absolutePath: string;
  /** Deleted rows have nothing on disk to open, show or reveal. */
  deleted: boolean;
}

export type ChangesFileMenuOpener = (event: MouseEvent<HTMLElement>, entry: GitFileEntry) => void;

/** Menu state for changes-panel file rows. `openMenu` is stable so the
 *  memoized rows do not re-render when the panel does; hiding the panel
 *  drops an open menu instead of resurrecting it on the next show. */
export function useChangesFileMenu(repoPath: string, visible: boolean) {
  const [menu, setMenu] = useState<ChangesFileMenuState | null>(null);
  useEffect(() => {
    if (!visible) setMenu(null);
  }, [visible]);
  const openMenu = useCallback<ChangesFileMenuOpener>(
    (event, entry) => {
      event.preventDefault();
      setMenu({
        x: event.clientX,
        y: event.clientY,
        path: entry.path,
        absolutePath: joinPath(repoPath, entry.path),
        deleted: entry.status === "deleted",
      });
    },
    [repoPath],
  );
  const closeMenu = useCallback(() => setMenu(null), []);
  return { menu, openMenu, closeMenu };
}

/**
 * Right-click menu for a changes-panel file row: the read-only file actions
 * of the file tree menu, plus "在浏览器中打开" for HTML on desktop. Native
 * failures go through `run`, the panel's header error surface.
 */
export function ChangesFileContextMenu({
  menu,
  run,
  onClose,
}: {
  menu: ChangesFileMenuState;
  run: (key: string, action: () => Promise<unknown>) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const path = menu.absolutePath;

  const isMac = navigator.platform.includes("Mac");
  const isWindows = navigator.platform.includes("Win");
  const revealLabel = isMac
    ? t("files.revealInFinder")
    : isWindows
      ? t("files.revealInExplorer")
      : t("files.revealInFileManager");

  const entries: ContextMenuEntry[] = [
    {
      id: "open-file",
      label: t("files.openFile"),
      icon: <FileText className="size-4" aria-hidden />,
      disabled: menu.deleted,
      onSelect: () => void useFilesStore.getState().openFile(path),
    },
    ...(canOpenInBrowser(path, !isWeb)
      ? [
          {
            id: "open-in-browser",
            label: t("files.openInBrowser"),
            icon: <Globe className="size-4" aria-hidden />,
            disabled: menu.deleted,
            onSelect: () => run("open-in-browser", () => ipc.openInBrowser(path)),
          },
        ]
      : []),
    {
      id: "copy-path",
      label: t("files.copyPath"),
      icon: <Link2 className="size-4" aria-hidden />,
      onSelect: () =>
        run("copy-path", async () => {
          if (!(await copyText(path))) {
            throw new Error(t("files.opFailed", { message: t("files.copyPath") }));
          }
        }),
    },
    {
      id: "reveal",
      label: revealLabel,
      icon: <FolderOpen className="size-4" aria-hidden />,
      disabled: menu.deleted,
      onSelect: () => run("reveal", () => ipc.revealInFileManager(path)),
    },
  ];

  return (
    <ContextMenu x={menu.x} y={menu.y} ariaLabel={menu.path} entries={entries} onClose={onClose} />
  );
}

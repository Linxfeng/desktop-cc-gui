import { useCallback, useEffect, useRef, useState, type MouseEvent } from "react";
import { useTranslation } from "react-i18next";
import { copyText } from "@/lib/clipboard";
import { ipc, type ClipboardFileSnapshot } from "@/lib/ipc";
import { errorText } from "@/lib/errors";
import { joinPath, parentPath, useFilesStore, type TreeClipboard } from "./store";
import { choosePasteSource, type PasteSource } from "./paste-source";
import type { FileTreeMenuState } from "./FileTreeContextMenu";
import type { VisibleNode } from "./FileTreeRow";
import { useChatStore } from "@/features/chat/store";

interface PromptState {
  kind: "newFile" | "newFolder" | "rename";
  /** Parent dir for newFile/newFolder; the item itself for rename. */
  path: string;
  isDir: boolean;
}

interface TrashTarget {
  path: string;
  isDir: boolean;
}

export interface FileTreeOperations {
  clipboard: TreeClipboard | null;
  /** Paste has a source, decided like Paste itself (`choosePasteSource`)
   *  from the snapshot read when the menu opened: the tree item while it is
   *  the newest copy, else the OS clipboard's files. Before that read lands,
   *  or when it fails, the tree item alone enables it. */
  canPaste: boolean;
  menu: FileTreeMenuState | null;
  prompt: PromptState | null;
  trashTarget: TrashTarget | null;
  notice: string | null;
  openContextMenu: (event: MouseEvent<HTMLElement>, node: VisibleNode) => void;
  closeMenu: () => void;
  startNewFile: (dir: string) => void;
  startNewFolder: (dir: string) => void;
  copyItem: () => void;
  paste: (dir: string) => void;
  duplicate: () => void;
  startRename: () => void;
  copyPath: () => void;
  sendPath: () => void;
  openInBrowser: () => void;
  revealInFileManager: () => void;
  startTrash: () => void;
  submitPrompt: (name: string) => void;
  cancelPrompt: () => void;
  confirmTrash: () => void;
  cancelTrash: () => void;
  dismissNotice: () => void;
}

/** Which clipboard Paste copies from, given the tree item as it stands. */
async function readPasteSource(item: TreeClipboard | null): Promise<PasteSource> {
  try {
    return choosePasteSource(await ipc.clipboardFileSnapshot(), item);
  } catch (error) {
    // Another program holds the clipboard open (Windows). The generation
    // needs no open: if it still equals what this item's Copy recorded,
    // nothing newer was copied anywhere and the tree item is the source.
    if (item?.osChangeCount != null) {
      const generation = await ipc.clipboardChangeCount().catch(() => null);
      if (generation === item.osChangeCount) return "tree";
    }
    throw error;
  }
}

/**
 * Context-menu and file-operation state for the tree: menu/prompt/trash
 * dialog targets, the auto-dismissing failure notice, and every action the
 * menu entries trigger.
 */
export function useFileTreeOperations(): FileTreeOperations {
  const { t } = useTranslation();
  const clipboard = useFilesStore((s) => s.clipboard);
  const revealDir = useFilesStore((s) => s.revealDir);
  const invalidateDir = useFilesStore((s) => s.invalidateDir);
  const selectPath = useFilesStore((s) => s.selectPath);

  const copyIdRef = useRef(0);
  /** Tail of the serialized Copy writes; never rejects. */
  const clipboardWriteRef = useRef<Promise<void>>(Promise.resolve());
  const clipboardProbeRef = useRef(0);
  const mountedRef = useRef(true);
  const [menu, setMenu] = useState<FileTreeMenuState | null>(null);
  const [prompt, setPrompt] = useState<PromptState | null>(null);
  const [trashTarget, setTrashTarget] = useState<TrashTarget | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  /** OS clipboard snapshot read when the menu opened; `null` until that
   *  probe resolves, or when it failed. Only gates Paste's enabled state —
   *  the paste itself re-reads the clipboard, which can change while the
   *  menu is up. */
  const [menuSnapshot, setMenuSnapshot] = useState<ClipboardFileSnapshot | null>(null);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 4000);
    return () => clearTimeout(timer);
  }, [notice]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      copyIdRef.current += 1;
      clipboardProbeRef.current += 1;
    };
  }, []);

  const opFailed = useCallback(
    (e: unknown) => {
      if (mountedRef.current) setNotice(t("files.opFailed", { message: errorText(e) }));
    },
    [t],
  );

  const openContextMenu = useCallback(
    (event: MouseEvent<HTMLElement>, node: VisibleNode) => {
      event.preventDefault();
      selectPath(node.path, node.isDir);
      setMenu({ x: event.clientX, y: event.clientY, path: node.path, isDir: node.isDir });
      // Only the latest open may update Paste; closing invalidates the probe.
      const probeId = ++clipboardProbeRef.current;
      setMenuSnapshot(null);
      // Like Paste, read only after the latest Copy's write settled: an
      // earlier snapshot would not match the generation that Copy records.
      void clipboardWriteRef.current
        .then(() => ipc.clipboardFileSnapshot())
        .then((snapshot) => {
          if (mountedRef.current && clipboardProbeRef.current === probeId) {
            setMenuSnapshot(snapshot);
          }
        })
        // A failed probe leaves the snapshot unknown; the tree item alone
        // then enables Paste, which re-reads the clipboard when clicked.
        .catch(() => {});
    },
    [selectPath],
  );

  /** Refresh the (loaded) parent listing, expand it and every folder above
   *  it (a merged single-chain row may hold closed middle folders), and
   *  select the operation result so the user sees what changed. */
  const revealInTree = useCallback(
    async (dir: string, target: string | null, isDir: boolean) => {
      if (dir) await revealDir(dir);
      await invalidateDir(dir);
      if (target) selectPath(target, isDir);
    },
    [revealDir, invalidateDir, selectPath],
  );

  const closeMenu = useCallback(() => {
    clipboardProbeRef.current += 1;
    setMenu(null);
  }, []);

  const submitPrompt = useCallback(
    async (name: string) => {
      const p = prompt;
      setPrompt(null);
      if (!p) return;
      if (name.includes("/") || name.includes("\\")) {
        setNotice(t("files.opFailed", { message: name }));
        return;
      }
      try {
        if (p.kind === "rename") {
          const parent = parentPath(p.path);
          const to = joinPath(parent, name);
          if (to !== p.path) {
            await ipc.renameItem(p.path, to);
            useFilesStore.getState().remapTreePath(p.path, to);
            await invalidateDir(parent);
            selectPath(to, p.isDir);
          }
          return;
        }
        const target = joinPath(p.path, name);
        if (p.kind === "newFile") {
          await ipc.createFile(target);
          await revealInTree(p.path, target, false);
        } else {
          await ipc.createDir(target);
          await revealInTree(p.path, target, true);
        }
      } catch (e) {
        opFailed(e);
      }
    },
    [prompt, t, invalidateDir, selectPath, revealInTree, opFailed],
  );

  const confirmTrash = useCallback(async () => {
    const target = trashTarget;
    setTrashTarget(null);
    if (!target) return;
    try {
      await ipc.trashItem(target.path);
      useFilesStore.getState().removeTreePath(target.path);
      await invalidateDir(parentPath(target.path));
    } catch (e) {
      opFailed(e);
    }
  }, [trashTarget, invalidateDir, opFailed]);

  const handlePaste = useCallback(
    async (targetDir: string) => {
      try {
        let source: PasteSource;
        for (;;) {
          const copyId = copyIdRef.current;
          // The latest Copy's write must settle and record its generation
          // before the comparison below means anything.
          await clipboardWriteRef.current;
          // The host reads its own snapshot inside pasteClipboardItems;
          // renderer-supplied source paths never enter the paste command.
          source = await readPasteSource(useFilesStore.getState().clipboard);
          // A Copy that arrived meanwhile changes both clipboards: decide again.
          if (copyIdRef.current === copyId) break;
        }
        if (!mountedRef.current) return;
        const item = useFilesStore.getState().clipboard;
        if (source === "tree" && item) {
          const result = await ipc.pasteItem(item.path, targetDir);
          await revealInTree(targetDir, result.path, result.isDir);
          return;
        }
        if (source === "system") {
          const { created, failed } = await ipc.pasteClipboardItems(targetDir);
          if (created.length > 0) {
            const last = created[created.length - 1];
            await revealInTree(targetDir, last.path, last.isDir);
          }
          if (!mountedRef.current) return;
          if (failed.length > 0) {
            setNotice(t("files.opFailed", { message: failed.join("; ") }));
          } else if (created.length === 0) {
            setNotice(t("files.pasteUnavailable"));
          }
          return;
        }
        setNotice(t("files.pasteUnavailable"));
      } catch (e) {
        opFailed(e);
      }
    },
    [t, revealInTree, opFailed],
  );

  const handleDuplicate = useCallback(async () => {
    if (!menu) return;
    try {
      const result = await ipc.duplicateItem(menu.path);
      await revealInTree(parentPath(menu.path), result.path, result.isDir);
    } catch (e) {
      opFailed(e);
    }
  }, [menu, revealInTree, opFailed]);

  const copyItem = useCallback(() => {
    if (!menu) return;
    const item: TreeClipboard = { path: menu.path, isDir: menu.isDir };
    const id = ++copyIdRef.current;
    useFilesStore.getState().setClipboard(item);
    // Serialize native writes: a late write for an older Copy must not
    // overwrite the newer item.
    clipboardWriteRef.current = clipboardWriteRef.current.then(async () => {
      if (copyIdRef.current !== id) return;
      // A refused write (clipboard held by another program, no native bridge
      // on Linux) is not an error for the tree: the generation read below
      // still tells Paste whether this item is the newest copy.
      await ipc.setClipboardFilePaths([item.path]).catch(() => {});
      // Reading the generation does not open the clipboard, so it answers
      // even while another program holds it.
      const osChangeCount = await ipc.clipboardChangeCount().catch(() => undefined);
      if (osChangeCount === undefined) return;
      const store = useFilesStore.getState();
      // A newer Copy replaced the item meanwhile; it records its own.
      if (store.clipboard === item) store.setClipboard({ ...item, osChangeCount });
    });
  }, [menu]);

  const copyPath = useCallback(() => {
    if (!menu) return;
    void copyText(menu.path).then((ok) => {
      if (!ok) opFailed(new Error("Failed to copy path"));
    }).catch(opFailed);
  }, [menu, opFailed]);

  const sendPath = useCallback(() => {
    if (!menu) return;
    useChatStore.getState().requestMention(menu.path);
  }, [menu]);

  const openInBrowser = useCallback(() => {
    if (!menu) return;
    void ipc.openInBrowser(menu.path).catch(opFailed);
  }, [menu, opFailed]);

  const revealInFileManager = useCallback(() => {
    if (!menu) return;
    void ipc.revealInFileManager(menu.path).catch(opFailed);
  }, [menu, opFailed]);

  return {
    clipboard,
    canPaste: menuSnapshot
      ? choosePasteSource(menuSnapshot, clipboard) !== "none"
      : clipboard !== null,
    menu,
    prompt,
    trashTarget,
    notice,
    openContextMenu,
    closeMenu,
    startNewFile: useCallback(
      (dir: string) => setPrompt({ kind: "newFile", path: dir, isDir: true }),
      [],
    ),
    startNewFolder: useCallback(
      (dir: string) => setPrompt({ kind: "newFolder", path: dir, isDir: true }),
      [],
    ),
    copyItem,
    paste: useCallback((dir: string) => void handlePaste(dir), [handlePaste]),
    duplicate: useCallback(() => void handleDuplicate(), [handleDuplicate]),
    startRename: useCallback(() => {
      if (menu) setPrompt({ kind: "rename", path: menu.path, isDir: menu.isDir });
    }, [menu]),
    copyPath,
    sendPath,
    openInBrowser,
    revealInFileManager,
    startTrash: useCallback(() => {
      if (menu) setTrashTarget({ path: menu.path, isDir: menu.isDir });
    }, [menu]),
    submitPrompt: useCallback((name: string) => void submitPrompt(name), [submitPrompt]),
    cancelPrompt: useCallback(() => setPrompt(null), []),
    confirmTrash: useCallback(() => void confirmTrash(), [confirmTrash]),
    cancelTrash: useCallback(() => setTrashTarget(null), []),
    dismissNotice: useCallback(() => setNotice(null), []),
  };
}

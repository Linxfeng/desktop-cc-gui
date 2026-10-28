import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ipc } from "@/lib/ipc";
import { FileLinkContextMenu, type FileLinkMenuState } from "./FileLinkContextMenu";

const platform = vi.hoisted(() => ({ isWeb: false }));
vi.mock("@/lib/platform", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/platform")>(),
  get isWeb() {
    return platform.isWeb;
  },
}));
vi.mock("react-i18next", async (importOriginal) => ({
  ...await importOriginal<typeof import("react-i18next")>(),
  useTranslation: () => ({ t: (key: string) => key }),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("FileLinkContextMenu open in browser", () => {
  let container: HTMLDivElement;
  let root: Root;
  const openInBrowser = vi.spyOn(ipc, "openInBrowser");
  const listDir = vi.spyOn(ipc, "listDir");
  const listFileIndex = vi.spyOn(ipc, "listFileIndex");
  const noop = () => {};

  const render = (menu: Omit<FileLinkMenuState, "x" | "y">) =>
    act(() =>
      root.render(<FileLinkContextMenu menu={{ x: 10, y: 10, ...menu }} onClose={noop} />),
    );
  const items = () =>
    [...document.body.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
  const labels = () => items().map((button) => button.textContent);
  const clickItem = async (label: string) => {
    const item = items().find((button) => button.textContent === label);
    expect(item).toBeDefined();
    await act(async () => item!.click());
  };

  beforeEach(() => {
    platform.isWeb = false;
    openInBrowser.mockReset().mockResolvedValue(undefined);
    listDir.mockReset().mockResolvedValue([]);
    listFileIndex.mockReset().mockResolvedValue([]);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("offers it for an HTML link, right after 打开文件", () => {
    render({
      path: "/repo/docs/pr-flow-design.html",
      resolvedPath: "/repo/docs/pr-flow-design.html",
      workspacePath: "/repo",
    });

    const all = labels();
    const index = all.indexOf("files.openInBrowser");
    expect(index).toBe(all.indexOf("files.openFile") + 1);
  });

  it("opens the path resolved on disk, not the link text", async () => {
    // Relative link whose file only exists nested below the workspace root:
    // the sync candidate misses, the index fallback finds it.
    listDir.mockRejectedValueOnce(new Error("missing"));
    listFileIndex.mockResolvedValueOnce([
      { rel: "nested/docs/pr-flow-design.html", isDir: false },
    ]);
    render({
      path: "docs/pr-flow-design.html",
      resolvedPath: "/repo/docs/pr-flow-design.html",
      workspacePath: "/repo",
    });

    await clickItem("files.openInBrowser");
    await vi.waitFor(() =>
      expect(openInBrowser).toHaveBeenCalledWith("/repo/nested/docs/pr-flow-design.html"),
    );
  });

  it("omits it for other files and for web access", () => {
    render({
      path: "/repo/docs/notes.md",
      resolvedPath: "/repo/docs/notes.md",
      workspacePath: "/repo",
    });
    expect(labels()).not.toContain("files.openInBrowser");

    platform.isWeb = true;
    render({
      path: "/repo/docs/pr-flow-design.html",
      resolvedPath: "/repo/docs/pr-flow-design.html",
      workspacePath: "/repo",
    });
    expect(labels()).not.toContain("files.openInBrowser");
  });

  it("keeps it visible but disabled when the link does not resolve", () => {
    render({ path: "~/docs/pr-flow-design.html", resolvedPath: null, workspacePath: "/repo" });

    const entry = items().find((button) => button.textContent === "files.openInBrowser");
    expect(entry?.disabled).toBe(true);
  });
});

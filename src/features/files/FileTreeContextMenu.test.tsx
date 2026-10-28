import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FileTreeContextMenu, type FileTreeMenuState } from "./FileTreeContextMenu";

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

describe("FileTreeContextMenu open in browser", () => {
  let container: HTMLDivElement;
  let root: Root;
  const onOpenInBrowser = vi.fn();
  const noop = () => {};

  const render = (menu: Omit<FileTreeMenuState, "x" | "y">) =>
    act(() =>
      root.render(
        <FileTreeContextMenu
          menu={{ x: 10, y: 10, ...menu }}
          pasteDisabled
          onClose={noop}
          onNewFile={noop}
          onNewFolder={noop}
          onSearchFiles={noop}
          onCopy={noop}
          onPaste={noop}
          onDuplicate={noop}
          onRename={noop}
          onCopyPath={noop}
          onSendPath={noop}
          onOpenInBrowser={onOpenInBrowser}
          onReveal={noop}
          onTrash={noop}
        />,
      ),
    );
  const labels = () =>
    [...document.body.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent);

  beforeEach(() => {
    platform.isWeb = false;
    onOpenInBrowser.mockClear();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("offers it for an HTML file, between send-path and reveal", () => {
    render({ path: "/repo/docs/pr-flow-design.html", isDir: false });

    const all = labels();
    const index = all.indexOf("files.openInBrowser");
    expect(all[index - 1]).toBe("files.sendPathToComposer");
    expect(all[index + 1]).toBe("files.revealInFileManager");

    const entry = [...document.body.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')][index];
    act(() => entry.click());
    expect(onOpenInBrowser).toHaveBeenCalledTimes(1);
  });

  it("omits it for other files, HTML-named folders and web access", () => {
    render({ path: "/repo/README.md", isDir: false });
    expect(labels()).not.toContain("files.openInBrowser");

    render({ path: "/repo/site.html", isDir: true });
    expect(labels()).not.toContain("files.openInBrowser");

    platform.isWeb = true;
    render({ path: "/repo/docs/pr-flow-design.html", isDir: false });
    expect(labels()).not.toContain("files.openInBrowser");
  });
});

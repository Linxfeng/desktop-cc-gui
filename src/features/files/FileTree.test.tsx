import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import "@/lib/i18n";
import { useFilesStore } from "./store";
import { FileTree } from "./FileTree";

vi.mock("./useFileTreeVirtualList", () => ({
  useFileTreeVirtualList: () => ({ parentRef: { current: null }, virtualizer: {}, visible: [] }),
}));
vi.mock("./useFileTreeOperations", () => ({
  useFileTreeOperations: () => ({ openContextMenu: vi.fn() }),
}));
vi.mock("./FileTreeBody", () => ({ FileTreeBody: () => <button>树节点</button> }));
vi.mock("./FileTreeOverlays", () => ({ FileTreeOverlays: () => null }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
const expandLoadedDirs = vi.fn();
const collapseAllDirs = vi.fn();

beforeEach(() => {
  expandLoadedDirs.mockClear();
  collapseAllDirs.mockClear();
  useFilesStore.setState({ root: "/repo", expandLoadedDirs, collapseAllDirs });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root.render(<FileTree />));
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

it("文件树内快捷键执行批量展开与收起", () => {
  const tree = container.firstElementChild as HTMLElement;
  act(() => {
    tree.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", altKey: true, shiftKey: true, bubbles: true }));
    tree.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", altKey: true, shiftKey: true, bubbles: true }));
  });
  expect(expandLoadedDirs).toHaveBeenCalledTimes(1);
  expect(collapseAllDirs).toHaveBeenCalledTimes(1);
});

it("容器保留 tabindex=-1，鼠标点击后快捷键仍能被接住", () => {
  const tree = container.firstElementChild as HTMLElement;
  // jsdom reports tabIndex -1 for any div; the attribute is what counts.
  expect(tree.getAttribute("tabindex")).toBe("-1");
  act(() => {
    tree.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", altKey: true, shiftKey: true, bubbles: true }));
  });
  expect(expandLoadedDirs).toHaveBeenCalledTimes(1);
  expect(collapseAllDirs).not.toHaveBeenCalled();
});

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ipc } from "@/lib/ipc";
import { useFilesStore } from "@/features/files/store";
import { ChangesPanel } from "./ChangesPanel";
import { useGitStore } from "./store";

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
vi.mock("./ChangesPanelHeader", () => ({
  ChangesPanelHeader: ({ error }: { error?: string }) => <header>{error}</header>,
}));
vi.mock("./CommitFooter", () => ({ CommitFooter: () => <footer /> }));
vi.mock("react-aria-components", () => ({
  Focusable: ({ children }: { children: ReactNode }) => children,
  Checkbox: ({ isSelected, onChange, ...props }: any) => (
    <input
      type="checkbox"
      checked={!!isSelected}
      onChange={(e) => onChange?.(e.target.checked)}
      aria-label={props["aria-label"]}
    />
  ),
}));
vi.mock("@/components/base/tooltip/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => children,
  TooltipContent: () => null,
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("changes panel file context menu", () => {
  let container: HTMLDivElement;
  let root: Root;

  const render = (visible = true) =>
    act(() => root.render(<ChangesPanel workspacePath="/repo" repoPath="/repo" visible={visible} />));
  const row = (path: string) =>
    [...container.querySelectorAll("li")].find((li) => li.textContent?.includes(path))!;
  const rightClick = (path: string) =>
    act(() => {
      row(path).dispatchEvent(
        new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 40, clientY: 60 }),
      );
    });
  const menu = () => document.body.querySelector<HTMLElement>('[role="menu"]');
  const item = (label: string) =>
    [...(menu()?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [])].find(
      (button) => button.textContent === label,
    );
  const labels = () =>
    [...(menu()?.querySelectorAll('[role="menuitem"]') ?? [])].map((button) => button.textContent);

  beforeEach(() => {
    platform.isWeb = false;
    useGitStore.setState({
      statusByWorkspace: {
        "/repo": {
          branch: "main",
          staged: [{ path: "src/main.ts", status: "modified" }],
          unstaged: [{ path: "docs/old.html", status: "deleted" }],
          untracked: [{ path: "docs/pr-flow-design.html", status: "added" }],
        },
      },
      refresh: vi.fn().mockResolvedValue(undefined),
      loadBranches: vi.fn().mockResolvedValue(undefined),
      openDiff: vi.fn(),
    });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    render();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  it("opens an HTML row in the browser by its absolute path", async () => {
    const openInBrowser = vi.spyOn(ipc, "openInBrowser").mockResolvedValue(undefined);

    rightClick("pr-flow-design.html");

    expect(labels()).toEqual([
      "files.openFile",
      "files.openInBrowser",
      "files.copyPath",
      "files.revealInFileManager",
    ]);
    await act(async () => item("files.openInBrowser")!.click());
    expect(openInBrowser).toHaveBeenCalledWith("/repo/docs/pr-flow-design.html");
    expect(menu()).toBeNull();
    // Right-click must not also open the diff the row's left click opens.
    expect(useGitStore.getState().openDiff).not.toHaveBeenCalled();
  });

  it("offers no browser entry for non-HTML rows or over web access", () => {
    rightClick("main.ts");
    expect(labels()).not.toContain("files.openInBrowser");
    expect(labels()).toContain("files.copyPath");

    act(() => document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    platform.isWeb = true;
    rightClick("pr-flow-design.html");
    expect(labels()).not.toContain("files.openInBrowser");
  });

  it("disables on-disk actions for a deleted row but still copies its path", () => {
    rightClick("old.html");
    expect(item("files.openFile")!.disabled).toBe(true);
    expect(item("files.openInBrowser")!.disabled).toBe(true);
    expect(item("files.revealInFileManager")!.disabled).toBe(true);
    expect(item("files.copyPath")!.disabled).toBe(false);
  });

  it("surfaces a browser launch failure in the panel header", async () => {
    vi.spyOn(ipc, "openInBrowser").mockRejectedValue(new Error("Not an HTML file"));

    rightClick("pr-flow-design.html");
    await act(async () => item("files.openInBrowser")!.click());

    expect(container.querySelector("header")!.textContent).toContain("Not an HTML file");
  });

  it("routes open file and reveal to the row's absolute path", async () => {
    const openFile = vi.spyOn(useFilesStore.getState(), "openFile").mockResolvedValue(undefined);
    const reveal = vi.spyOn(ipc, "revealInFileManager").mockResolvedValue(undefined);

    rightClick("main.ts");
    await act(async () => item("files.openFile")!.click());
    rightClick("main.ts");
    await act(async () => item("files.revealInFileManager")!.click());

    expect(openFile).toHaveBeenCalledWith("/repo/src/main.ts");
    expect(reveal).toHaveBeenCalledWith("/repo/src/main.ts");
  });

  it("drops an open menu when the panel is hidden", () => {
    rightClick("pr-flow-design.html");
    expect(menu()).not.toBeNull();

    render(false);
    render(true);

    expect(menu()).toBeNull();
  });
});

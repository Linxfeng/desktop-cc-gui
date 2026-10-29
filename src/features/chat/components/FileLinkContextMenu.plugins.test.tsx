import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as sdk from "@ccgui/plugin-sdk";

const mocks = vi.hoisted(() => ({
  resolve: vi.fn(),
  openWorkspaceIn: vi.fn().mockResolvedValue(undefined),
  revealInFileManager: vi.fn().mockResolvedValue(undefined),
  openFile: vi.fn(),
  crash: vi.fn(),
}));
vi.mock("@/lib/ipc", () => ({ ipc: {
  openWorkspaceIn: mocks.openWorkspaceIn, revealInFileManager: mocks.revealInFileManager,
} }));
vi.mock("@/features/files/store", () => ({
  useFilesStore: { getState: () => ({ openFile: mocks.openFile }) },
}));
vi.mock("@/features/chat/file-link-resolution", () => ({ resolveChatFileLink: mocks.resolve }));
vi.mock("@/features/plugins/runtime/loader", () => ({
  reportPluginCrash: mocks.crash, notePluginRenderOk: vi.fn(),
}));
vi.mock("@/lib/i18n", () => ({ default: { t: (key: string) => key } }));
// Desktop host: the HTML-only "Open in Browser" row is gated on !isWeb.
vi.mock("@/lib/platform", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/platform")>(),
  isWeb: false,
}));
vi.mock("react-i18next", () => ({ useTranslation: () => ({
  t: (key: string, options?: { app: string }) => key === "files.openInApp"
    ? `Open in ${options?.app}` : key,
}) }));

import { FileLinkContextMenu } from "./FileLinkContextMenu";

describe("file-link menu plugin entries", () => {
  const environment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const previousActEnvironment = environment.IS_REACT_ACT_ENVIRONMENT;
  beforeAll(() => { environment.IS_REACT_ACT_ENVIRONMENT = true; });
  afterAll(() => { environment.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment; });
  let container: HTMLDivElement;
  let root: Root;
  let disposers: (() => void)[];
  const path = "C:/vault/Новая папка/Note & #1.md";
  const workspacePath = "C:/vault";
  const rows = () => [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
  const row = (label: string) => rows().find(button => button.textContent === label)!;
  const register = (def: Partial<sdk.FileLinkMenuItemDef> = {}) => {
    const dispose = sdk.fileLinkMenuRegistry.register({
      id: "plugin:obsidian-bridge:open", label: () => "Open in Obsidian", run: vi.fn(), ...def,
    });
    disposers.push(dispose);
    return dispose;
  };
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    mocks.resolve.mockResolvedValue(path);
    disposers = [];
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    disposers.forEach(dispose => dispose());
    container.remove();
    vi.restoreAllMocks();
  });
  async function render(
    resolvedPath: string | null = "C:/vault/Note & #1.md",
    linkPath = "Note & #1.md",
  ) {
    await act(async () => root.render(<FileLinkContextMenu menu={{
      x: 30, y: 30, path: linkPath, resolvedPath, workspacePath,
    }} onClose={() => {}} />));
  }
  it("inserts ordered plugin rows between Open File and the selected editor", async () => {
    register({ id: "plugin:z", label: () => "Second", order: 2 });
    register({ id: "plugin:a", label: () => "First", order: 1 });
    await render();
    expect(rows().map(button => button.textContent).slice(0, 4)).toEqual([
      "files.openFile", "First", "Second", "Open in VS Code",
    ]);
  });
  it("places plugin rows after Open in Browser on HTML links", async () => {
    register({ label: () => "Open in Obsidian" });
    await render("C:/vault/page.html", "page.html:12");
    expect(rows().map(button => button.textContent).slice(0, 4)).toEqual([
      "files.openFile", "files.openInBrowser", "Open in Obsidian", "Open in VS Code",
    ]);
  });
  it("drops blank labels instead of rendering an unnamed row", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    register({ id: "plugin:empty", label: () => "" });
    register({ id: "plugin:spaces", label: () => "   " });
    await render();
    expect(rows().map(button => button.textContent).slice(0, 2)).toEqual([
      "files.openFile", "Open in VS Code",
    ]);
  });
  it("passes the clicked link's actual resolved path and workspace to run", async () => {
    const run = vi.fn(); register({ run }); await render();
    await act(async () => row("Open in Obsidian").click());
    expect(run).toHaveBeenCalledWith({ path: "Note & #1.md", resolvedPath: path, workspacePath });
    expect(mocks.openWorkspaceIn).not.toHaveBeenCalled();
  });
  it("disables plugin rows for unresolvable paths", async () => {
    const run = vi.fn(); register({ run }); await render(null);
    expect(row("Open in Obsidian").disabled).toBe(true);
    row("Open in Obsidian").click(); expect(run).not.toHaveBeenCalled();
  });
  it("does not dispatch when asynchronous resolution returns null", async () => {
    mocks.resolve.mockResolvedValue(null);
    const run = vi.fn(); register({ run }); await render();
    await act(async () => row("Open in Obsidian").click());
    expect(run).not.toHaveBeenCalled();
  });
  it("removes an unregistered contribution from an open menu", async () => {
    const dispose = register(); await render();
    await act(async () => dispose());
    expect(row("Open in Obsidian")).toBeUndefined();
    expect(row("Open in VS Code")).toBeDefined();
  });
  it("does not dispatch a contribution unloaded while its path resolves", async () => {
    let resolve!: (path: string) => void;
    mocks.resolve.mockImplementation(() => new Promise<string>(done => { resolve = done; }));
    const run = vi.fn(); const dispose = register({ run }); await render();
    await act(async () => row("Open in Obsidian").click());
    await act(async () => { dispose(); resolve(path); });
    expect(run).not.toHaveBeenCalled();
  });
  it("isolates throwing labels and visibility predicates from built-in entries", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    register({ label: () => { throw Error("label failed"); } });
    register({ id: "plugin:broken", visible: () => { throw Error("visibility failed"); } });
    await render();
    expect(row("Open in VS Code")).toBeDefined();
    expect(rows()).toHaveLength(4);
  });
  it("catches asynchronous plugin action failures", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    register({ run: async () => { throw Error("launch failed"); } }); await render();
    await act(async () => row("Open in Obsidian").click());
    expect(error).toHaveBeenCalled();
  });
  it("drops invalid labels and prevents one contribution mutating other targets", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    register({ id: "plugin:a", label: () => ({ invalid: true }) as unknown as string });
    register({ id: "plugin:b", label: target => {
      (target as { path: string }).path = "another-file.md";
      return "Mutator";
    } });
    const label = vi.fn(() => "Valid");
    register({ id: "plugin:c", label }); await render();
    expect(rows().map(button => button.textContent).slice(0, 3)).toEqual([
      "files.openFile", "Valid", "Open in VS Code",
    ]);
    expect(label).toHaveBeenCalledWith(expect.objectContaining({ path: "Note & #1.md" }));
  });
  it("isolates a crashing plugin icon", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    register({ icon: () => { throw Error("icon failed"); } }); await render();
    expect(row("Open in VS Code")).toBeDefined();
    expect(mocks.crash).toHaveBeenCalledWith("obsidian-bridge", expect.any(Error));
  });
});

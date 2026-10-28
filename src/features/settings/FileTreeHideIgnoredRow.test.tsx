import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getAppSettings = vi.fn();
const updateAppSettings = vi.fn();
vi.mock("@/lib/ipc", () => ({
  ipc: {
    getAppSettings: () => getAppSettings(),
    updateAppSettings: (settings: unknown) => updateAppSettings(settings),
  },
}));

import "@/lib/i18n";
import i18n from "@/lib/i18n";
import { useFileTreePreferencesStore } from "@/features/files/tree-preferences";
import { FileTreeHideIgnoredRow } from "./FileTreeHideIgnoredRow";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  getAppSettings.mockReset();
  updateAppSettings.mockReset();
  useFileTreePreferencesStore.setState({ hideIgnored: false });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function render() {
  await act(async () => {
    root.render(<FileTreeHideIgnoredRow />);
  });
}

function toggle(): HTMLInputElement {
  const label = i18n.t("settings.fileTreeHideIgnored");
  const element = container.querySelector<HTMLInputElement>(
    `input[role="switch"][aria-label="${label}"]`,
  );
  if (!element) throw new Error("switch not rendered");
  return element;
}

async function click(element: HTMLElement) {
  await act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
}

describe("FileTreeHideIgnoredRow", () => {
  it("starts off when settings have no value (ignored entries stay listed)", async () => {
    getAppSettings.mockResolvedValue({});
    await render();
    expect(toggle().checked).toBe(false);
    expect(container.querySelector("[data-setting-anchor='fileTreeHideIgnored']")).not.toBeNull();
  });

  it("reflects the persisted value", async () => {
    getAppSettings.mockResolvedValue({ fileTreeHideIgnored: true });
    await render();
    expect(toggle().checked).toBe(true);
  });

  it("turning it on hides at once and persists onto the latest settings", async () => {
    getAppSettings.mockResolvedValue({ theme: "dark" });
    updateAppSettings.mockResolvedValue(undefined);
    await render();
    await click(toggle());
    expect(useFileTreePreferencesStore.getState().hideIgnored).toBe(true);
    expect(updateAppSettings).toHaveBeenCalledWith({ theme: "dark", fileTreeHideIgnored: true });
    expect(container.querySelector("[role='alert']")).toBeNull();
  });

  it("a failed save rolls the switch back and says so", async () => {
    getAppSettings.mockResolvedValue({});
    updateAppSettings.mockRejectedValue(new Error("disk full"));
    await render();
    await click(toggle());
    expect(useFileTreePreferencesStore.getState().hideIgnored).toBe(false);
    expect(toggle().checked).toBe(false);
    expect(container.querySelector("[role='alert']")?.textContent).toContain("disk full");
  });
});

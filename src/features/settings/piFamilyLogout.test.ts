import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { getAppSettings, terminalHostInfo, terminalWrite, piFamilyAuthList, newTab, closeTab } =
  vi.hoisted(() => ({
    getAppSettings: vi.fn(async () => ({})),
    terminalHostInfo: vi.fn(async () => ({ platform: "macos", shellPath: "/bin/zsh" })),
    terminalWrite: vi.fn(async () => {}),
    piFamilyAuthList: vi.fn(),
    newTab: vi.fn(),
    closeTab: vi.fn(),
  }));

vi.mock("@/lib/ipc", () => ({
  ipc: { getAppSettings, terminalHostInfo, terminalWrite, piFamilyAuthList },
}));
vi.mock("@/features/chat/store", () => ({
  useChatStore: { getState: () => ({ active: { workspacePath: "/project" } }) },
}));
vi.mock("@/features/terminal/store", () => ({
  useTerminalStore: {
    getState: () => ({
      open: true,
      newTab,
      closeTab,
      tabsByWorkspace: { "/project": [{ id: "existing" }, { id: "term-1" }] },
      activeByWorkspace: { "/project": "term-1" },
    }),
  },
}));
vi.mock("@/features/terminal/sessions", () => ({
  ensureTerminalOutputListener: vi.fn(),
  hasTerminalSession: () => true,
  terminalBacklog: () => "",
}));

import { launchPiFamilyLogout, waitForPiFamilyLogout } from "./piFamilyLogin";

beforeEach(() => {
  getAppSettings.mockClear();
  terminalHostInfo.mockClear();
  terminalWrite.mockClear();
  piFamilyAuthList.mockReset();
  newTab.mockClear();
  closeTab.mockClear();
});

afterEach(() => vi.useRealTimers());

describe("Pi family subscription logout", () => {
  it("runs OMP logout for the selected credential id in a new terminal tab", async () => {
    expect(await launchPiFamilyLogout("omp", "openai-codex")).toBe(true);
    expect(newTab).toHaveBeenCalledWith("/project");
    expect(terminalWrite).toHaveBeenCalledWith(
      "term-1",
      "omp auth-broker logout openai-codex\r",
    );
  });

  it("does not report a launched logout when the terminal write fails", async () => {
    terminalWrite.mockRejectedValueOnce(new Error("terminal closed"));
    await expect(launchPiFamilyLogout("omp", "anthropic")).rejects.toThrow("terminal closed");
  });

  it("opens the Pi logout picker without choosing an account", async () => {
    vi.useFakeTimers();
    expect(await launchPiFamilyLogout("pi", "openai-codex")).toBe(true);
    expect(terminalWrite).toHaveBeenCalledWith("term-1", "pi\r");
    await vi.advanceTimersByTimeAsync(1500);
    expect(terminalWrite).toHaveBeenCalledWith("term-1", "/logout\r");
  });

  it("quotes a custom binary for the host Git Bash shell", async () => {
    getAppSettings.mockResolvedValueOnce({ ompBin: "C:\\Tools\\it's here\\omp.exe" });
    terminalHostInfo.mockResolvedValueOnce({
      platform: "windows",
      shellPath: "C:\\Program Files\\Git\\bin\\bash.exe",
    });
    expect(await launchPiFamilyLogout("omp", "anthropic")).toBe(true);
    expect(terminalWrite).toHaveBeenCalledWith(
      "term-1",
      "'C:\\Tools\\it'\\''s here\\omp.exe' auth-broker logout anthropic\r",
    );
  });

  it("accepts logout only after every credential id for the row disappears", async () => {
    vi.useFakeTimers();
    piFamilyAuthList
      .mockResolvedValueOnce({ oauthProviders: ["openai-codex"] })
      .mockResolvedValueOnce({ oauthProviders: [] });
    const result = waitForPiFamilyLogout("pi", ["openai", "openai-codex"]);
    await vi.advanceTimersByTimeAsync(2000);
    await expect(result).resolves.toBe(true);
  });
});

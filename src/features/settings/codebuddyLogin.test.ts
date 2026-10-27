import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  active: null as null | { workspacePath: string },
  workspaces: [] as { path: string }[],
  getAppSettings: vi.fn(),
  terminalHostInfo: vi.fn(),
  openDedicatedTerminalTab: vi.fn(),
  runCliLogin: vi.fn(),
  waitForSession: vi.fn(),
  closeTab: vi.fn(),
}));

vi.mock("@/lib/ipc", () => ({
  ipc: {
    getAppSettings: mocks.getAppSettings,
    terminalHostInfo: mocks.terminalHostInfo,
  },
}));
vi.mock("@/features/chat/store", () => ({
  useChatStore: {
    getState: () => ({ active: mocks.active, workspaces: mocks.workspaces }),
  },
}));
vi.mock("@/features/terminal/store", () => ({
  useTerminalStore: { getState: () => ({ closeTab: mocks.closeTab }) },
}));
vi.mock("./terminalLogin", () => ({
  openDedicatedTerminalTab: mocks.openDedicatedTerminalTab,
  runCliLogin: mocks.runCliLogin,
  shellQuote: (value: string) => value,
  waitForSession: mocks.waitForSession,
}));

import { launchCodeBuddyLogin } from "./codebuddyLogin";

beforeEach(() => {
  mocks.active = { workspacePath: "/project" };
  mocks.workspaces = [];
  mocks.getAppSettings.mockReset().mockResolvedValue({ codebuddyBin: "codebuddy" });
  mocks.terminalHostInfo
    .mockReset()
    .mockResolvedValue({ platform: "macos", shellPath: "/bin/zsh" });
  mocks.openDedicatedTerminalTab.mockReset().mockReturnValue("login-tab");
  mocks.runCliLogin.mockReset().mockResolvedValue(true);
  mocks.waitForSession.mockReset().mockResolvedValue(true);
  mocks.closeTab.mockReset();
});

describe("CodeBuddy terminal login", () => {
  it("requires an active workspace instead of mounting an inactive workspace dock", async () => {
    mocks.active = null;
    mocks.workspaces = [{ path: "/inactive-project" }];

    await expect(launchCodeBuddyLogin()).resolves.toEqual({
      ok: false,
      reason: "no-workspace",
    });
    expect(mocks.openDedicatedTerminalTab).not.toHaveBeenCalled();
  });

  it("does not resolve success before the two-stage login flow finishes", async () => {
    const delivery = Promise.withResolvers<boolean>();
    mocks.runCliLogin.mockReturnValue(delivery.promise);
    let settled = false;
    const result = launchCodeBuddyLogin().then((outcome) => {
      settled = true;
      return outcome;
    });
    await vi.waitFor(() => expect(mocks.runCliLogin).toHaveBeenCalledOnce());
    expect(settled).toBe(false);

    delivery.resolve(true);
    await expect(result).resolves.toEqual({ ok: true });
    expect(mocks.closeTab).not.toHaveBeenCalled();
  });

  it("returns terminal-unavailable and cleans up only its tab on write or readiness failure", async () => {
    mocks.runCliLogin.mockResolvedValue(false);

    await expect(launchCodeBuddyLogin()).resolves.toEqual({
      ok: false,
      reason: "terminal-unavailable",
    });
    expect(mocks.closeTab).toHaveBeenCalledExactlyOnceWith("/project", "login-tab");
  });

  it("does not close an existing terminal when a dedicated tab could not be created", async () => {
    mocks.openDedicatedTerminalTab.mockReturnValue(null);

    await expect(launchCodeBuddyLogin()).resolves.toEqual({
      ok: false,
      reason: "terminal-unavailable",
    });
    expect(mocks.closeTab).not.toHaveBeenCalled();
    expect(mocks.runCliLogin).not.toHaveBeenCalled();
  });
});

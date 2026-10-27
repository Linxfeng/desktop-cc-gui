import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TerminalHostInfo } from "@/lib/ipc";

const mocks = vi.hoisted(() => ({
  backlogs: new Map<string, string>(),
  sessions: new Set<string>(),
  terminalWrite: vi.fn(),
  toggle: vi.fn(),
  newTab: vi.fn(),
  closeTab: vi.fn(),
  terminalState: {
    open: true,
    tabsByWorkspace: {} as Record<string, { id: string }[]>,
    activeByWorkspace: {} as Record<string, string>,
  },
}));

vi.mock("@/lib/ipc", () => ({ ipc: { terminalWrite: mocks.terminalWrite } }));
vi.mock("@/features/terminal/sessions", () => ({
  ensureTerminalOutputListener: vi.fn(),
  hasTerminalSession: (id: string) => mocks.sessions.has(id),
  terminalBacklog: (id: string) => mocks.backlogs.get(id) ?? "",
}));
vi.mock("@/features/terminal/store", () => ({
  useTerminalStore: {
    getState: () => ({
      ...mocks.terminalState,
      toggle: mocks.toggle,
      newTab: mocks.newTab,
      closeTab: mocks.closeTab,
    }),
  },
}));

import {
  openDedicatedTerminalTab,
  runCliLogin,
  settleTerminalBacklog,
  shellQuote,
  waitForCliReady,
} from "./terminalLogin";

const MAC_HOST: TerminalHostInfo = { platform: "macos", shellPath: "/bin/zsh" };
const WINDOWS_HOST: TerminalHostInfo = {
  platform: "windows",
  shellPath: "C:\\Windows\\System32\\cmd.exe",
};

beforeEach(() => {
  mocks.backlogs.clear();
  mocks.sessions.clear();
  mocks.sessions.add("term-1");
  for (const mock of [mocks.terminalWrite, mocks.toggle, mocks.newTab, mocks.closeTab]) {
    mock.mockReset();
  }
  mocks.terminalWrite.mockResolvedValue(undefined);
  Object.assign(mocks.terminalState, {
    open: true,
    tabsByWorkspace: {},
    activeByWorkspace: { "/project": "term-1" },
  });
});

afterEach(() => vi.useRealTimers());

describe("shellQuote", () => {
  it("leaves plain command names and safe paths unquoted", () => {
    expect(shellQuote("pi", MAC_HOST)).toBe("pi");
    expect(shellQuote("/usr/local/bin/codebuddy", MAC_HOST)).toBe("/usr/local/bin/codebuddy");
  });

  it("uses the remote host shell rather than the browser platform", () => {
    expect(shellQuote("/opt/$HOME;rm -rf /", MAC_HOST)).toBe("'/opt/$HOME;rm -rf /'");
    expect(shellQuote("C:\\Tools\\my cli.exe", WINDOWS_HOST)).toBe(
      '"C:\\Tools\\my cli.exe"',
    );
  });

  it("uses POSIX quoting for Git Bash on a Windows host", () => {
    const host: TerminalHostInfo = {
      platform: "windows",
      shellPath: "C:\\Program Files\\Git\\bin\\bash.exe",
    };
    expect(shellQuote("C:\\Tools\\it's here\\codebuddy.exe", host)).toBe(
      "'C:\\Tools\\it'\\''s here\\codebuddy.exe'",
    );
  });

  it("keeps POSIX shell metacharacters literal", () => {
    for (const value of ["/opt/$HOME;rm -rf /", "/opt/`whoami`", "/opt/a|b&c"]) {
      expect(shellQuote(value, MAC_HOST)).toBe(`'${value}'`);
    }
  });
});

describe("terminal login outcomes", () => {
  it("does not create a second tab when opening an empty closed dock", () => {
    mocks.terminalState.open = false;
    expect(openDedicatedTerminalTab("/project")).toBe("term-1");
    expect(mocks.toggle).toHaveBeenCalledOnce();
    expect(mocks.newTab).not.toHaveBeenCalled();
  });

  it("creates one dedicated tab when the dock already has a shell", () => {
    mocks.terminalState.open = false;
    mocks.terminalState.tabsByWorkspace = { "/project": [{ id: "existing" }] };
    openDedicatedTerminalTab("/project");
    expect(mocks.toggle).toHaveBeenCalledOnce();
    expect(mocks.newTab).toHaveBeenCalledOnce();
  });

  it("does not treat a silent terminal as settled", async () => {
    vi.useFakeTimers();
    let settled = false;
    const result = settleTerminalBacklog("term-1", 500).then((value) => {
      settled = true;
      return value;
    });
    await vi.advanceTimersByTimeAsync(250);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(250);
    await expect(result).resolves.toBe(0);
  });

  it("settles after observed output has a quiet period", async () => {
    vi.useFakeTimers();
    const result = settleTerminalBacklog("term-1", 1000);
    await vi.advanceTimersByTimeAsync(100);
    mocks.backlogs.set("term-1", "shell prompt");
    await vi.advanceTimersByTimeAsync(400);
    await expect(result).resolves.toBe("shell prompt".length);
  });

  it("fails readiness when the user closes the PTY", async () => {
    vi.useFakeTimers();
    const result = waitForCliReady("term-1", 0, 3, 1000);
    mocks.sessions.delete("term-1");
    await vi.advanceTimersByTimeAsync(200);
    await expect(result).resolves.toBe(false);
  });

  it("delivers the slash command only after readiness output", async () => {
    vi.useFakeTimers();
    mocks.backlogs.set("term-1", "prompt");
    mocks.terminalWrite.mockImplementation(async () => {
      mocks.backlogs.set("term-1", "x".repeat(200));
    });
    const result = runCliLogin("term-1", "codebuddy", "/login");
    await vi.advanceTimersByTimeAsync(400);
    await expect(result).resolves.toBe(true);
    expect(mocks.terminalWrite.mock.calls).toEqual([
      ["term-1", "codebuddy\r"],
      ["term-1", "/login\r"],
    ]);
  });

  it("fails instead of reporting success when the first write rejects", async () => {
    vi.useFakeTimers();
    mocks.backlogs.set("term-1", "prompt");
    mocks.terminalWrite.mockRejectedValueOnce(new Error("PTY closed"));
    const result = runCliLogin("term-1", "codebuddy", "/login");
    await vi.advanceTimersByTimeAsync(400);
    await expect(result).resolves.toBe(false);
    expect(mocks.terminalWrite).toHaveBeenCalledOnce();
  });

  it("fails instead of reporting success when the login write rejects", async () => {
    vi.useFakeTimers();
    mocks.backlogs.set("term-1", "prompt");
    mocks.terminalWrite
      .mockImplementationOnce(async () => {
        mocks.backlogs.set("term-1", "x".repeat(200));
      })
      .mockRejectedValueOnce(new Error("PTY closed"));
    const result = runCliLogin("term-1", "codebuddy", "/login");
    await vi.advanceTimersByTimeAsync(400);
    await expect(result).resolves.toBe(false);
    expect(mocks.terminalWrite).toHaveBeenCalledTimes(2);
  });

  it("does not write login after readiness times out", async () => {
    vi.useFakeTimers();
    mocks.backlogs.set("term-1", "prompt");
    const result = runCliLogin("term-1", "codebuddy", "/login");
    await vi.advanceTimersByTimeAsync(16_000);
    await expect(result).resolves.toBe(false);
    expect(mocks.terminalWrite).toHaveBeenCalledOnce();
  });

  it("does not write login into a replacement shell after the tab closes", async () => {
    vi.useFakeTimers();
    mocks.backlogs.set("term-1", "prompt");
    mocks.terminalWrite.mockImplementationOnce(async () => {
      mocks.sessions.delete("term-1");
    });
    const result = runCliLogin("term-1", "codebuddy", "/login");
    await vi.advanceTimersByTimeAsync(400);
    await expect(result).resolves.toBe(false);
    expect(mocks.terminalWrite).toHaveBeenCalledOnce();
  });
});

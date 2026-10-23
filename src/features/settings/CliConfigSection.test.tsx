import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  wslDistros: vi.fn(),
  wslCliCapabilities: vi.fn(),
  wslCliStatus: vi.fn(),
  getCliConfig: vi.fn(),
  checkCcSwitch: vi.fn(),
  getWslEnginePaths: vi.fn(),
  setWslEnginePath: vi.fn(),
  wslReprobe: vi.fn(),
}));

vi.mock("@/lib/ipc", () => ({ ipc: mocks }));
// jsdom 里 isWeb 为真、IS_WINDOWS 为假：作用域只在桌面 Windows 出现，
// 这里显式模拟桌面（只改 UA 无效，isWeb 是常量）。
vi.mock("@/lib/platform", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/platform")>();
  return { ...actual, IS_WINDOWS: true, isWeb: false };
});
vi.mock("@/lib/errors", () => ({
  errorText: (error: unknown) => String(error),
}));

// jsdom has no ResizeObserver; PillTabList measures its thumb with one.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal("ResizeObserver", ResizeObserverStub);

// React 18's act() requires this flag.
declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

type SectionModule = typeof import("./CliConfigSection");
type ScopeModule = typeof import("./use-cli-scope");

let CliConfigSection: SectionModule["CliConfigSection"];
let store: ScopeModule["cliScopeStore"];
let container: HTMLDivElement;
let root: Root;

/** 模块级 store 每个用例从冷状态开始：resetModules 后重新 import。 */
async function boot() {
  vi.resetModules();
  await import("@/lib/i18n");
  store = (await import("./use-cli-scope")).cliScopeStore;
  CliConfigSection = (await import("./CliConfigSection")).CliConfigSection;
}

async function flush() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

async function render(engine: "claude" | "grok" = "claude") {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(<CliConfigSection engine={engine} />);
    await flush();
  });
}

beforeEach(async () => {
  localStorage.clear();
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.wslDistros.mockResolvedValue(["Ubuntu-24.04"]);
  mocks.wslCliCapabilities.mockResolvedValue({ engines: ["claude", "kimi"] });
  mocks.wslCliStatus.mockResolvedValue([
    {
      engine: "claude",
      distro: "Ubuntu-24.04",
      bin: "/usr/bin/claude",
      version: "2.1.280",
      source: "probe",
      probedAgoSecs: 12,
    },
  ]);
  mocks.getCliConfig.mockRejectedValue(new Error("host config"));
  mocks.checkCcSwitch.mockResolvedValue({ installed: false });
  mocks.getWslEnginePaths.mockResolvedValue([]);
  mocks.setWslEnginePath.mockResolvedValue(undefined);
  mocks.wslReprobe.mockResolvedValue([]);
  await boot();
});

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
});

describe("CliConfigSection scope", () => {
  it("defaults to the host scope and never reads WSL CLI status", async () => {
    await store.ensureMeta();
    await render("claude");

    expect(container.textContent).toContain("本机 Windows");
    expect(mocks.getCliConfig).toHaveBeenCalled();
    expect(mocks.wslCliStatus).not.toHaveBeenCalled();
  });

  it("swaps to the WSL panel without reading host CLI config", async () => {
    await store.ensureMeta();
    store.setScope("wsl");
    await render("claude");

    expect(mocks.wslCliStatus).toHaveBeenCalledWith("Ubuntu-24.04");
    expect(mocks.getCliConfig).not.toHaveBeenCalled();
    expect(container.textContent).toContain("/usr/bin/claude");
    expect(container.textContent).toContain("2.1.280");
  });

  it("does not render the scope switch for an engine the backend cannot run", async () => {
    mocks.wslCliCapabilities.mockResolvedValue({ engines: ["claude"] });
    await store.ensureMeta();
    await render("grok");

    expect(container.textContent).not.toContain("本机 Windows");
    expect(mocks.getCliConfig).toHaveBeenCalled();
    expect(mocks.wslCliStatus).not.toHaveBeenCalled();
  });

  it("falls back to the host page when metadata fails while WSL was remembered", async () => {
    localStorage.clear();
    await boot();
    localStorage.setItem("ccgui-next.cliScope:v1", "wsl");
    await boot();
    mocks.wslDistros.mockRejectedValue(new Error("wsl missing"));
    await store.ensureMeta();
    await render("claude");

    expect(container.textContent).toContain("无法读取 WSL 信息");
    expect(mocks.getCliConfig).toHaveBeenCalled();
  });
});

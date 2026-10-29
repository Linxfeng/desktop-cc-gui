import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  cliVersionStatus: vi.fn(),
  cliUpdate: vi.fn(),
  wslDistros: vi.fn(),
  wslCliCapabilities: vi.fn(),
}));

vi.mock("@/lib/ipc", () => ({ ipc: mocks }));
vi.mock("@/lib/platform", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/platform")>();
  return { ...actual, IS_WINDOWS: true, isWeb: false };
});

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

type HeaderModule = typeof import("./CliHeaderActions");
type ScopeModule = typeof import("./use-cli-scope");

let CliHeaderActions: HeaderModule["CliHeaderActions"];
let store: ScopeModule["cliScopeStore"];
let container: HTMLDivElement;
let root: Root | null = null;

// 同 CliConfigSection.test.tsx:resetModules 后的冷导入在慢机器上会超过默认
// 10 秒的 hook 超时,只放宽准备步骤的时限。
beforeEach(async () => {
  localStorage.clear();
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.cliVersionStatus.mockResolvedValue({
    engine: "claude",
    installed: true,
    localVersion: "2.1.228",
    latestVersion: "2.1.267",
    updateAvailable: true,
    updateKind: "native",
  });
  mocks.wslDistros.mockResolvedValue(["Ubuntu-24.04"]);
  mocks.wslCliCapabilities.mockResolvedValue({ engines: ["claude"] });

  vi.resetModules();
  await import("@/lib/i18n");
  store = (await import("./use-cli-scope")).cliScopeStore;
  CliHeaderActions = (await import("./CliHeaderActions")).CliHeaderActions;
}, 30_000);

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  root = null;
});

async function render() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<CliHeaderActions engine="claude" />);
    await Promise.resolve();
  });
}

describe("CliHeaderActions in the WSL scope", () => {
  it("keeps only the docs entry and never probes the host CLI", async () => {
    await store.ensureMeta();
    store.setScope("wsl");
    await render();

    expect(mocks.cliVersionStatus).not.toHaveBeenCalled();
    expect(container.querySelector('[aria-label="官方文档"]')).not.toBeNull();
    expect(container.textContent ?? "").not.toContain("更新至");
    expect(container.textContent ?? "").not.toContain("2.1.228");
  });
});

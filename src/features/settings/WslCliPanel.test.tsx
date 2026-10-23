import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  wslReprobe: vi.fn(),
  wslCliStatus: vi.fn(),
  getWslEnginePaths: vi.fn(),
  setWslEnginePath: vi.fn(),
  getCliConfig: vi.fn(),
  setEngineEnabled: vi.fn(),
  wslCliConfigRead: vi.fn(),
  wslCliConfigWrite: vi.fn(),
}));

vi.mock("@/lib/ipc", () => ({ ipc: mocks }));
vi.mock("@/lib/platform", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/platform")>();
  return { ...actual, IS_WINDOWS: true, isWeb: false };
});
vi.mock("@/lib/errors", () => ({
  errorText: (error: unknown) =>
    error instanceof Error ? error.message : String(error),
}));

import "@/lib/i18n";
import { WslCliPanel } from "./WslCliPanel";

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const DISTRO = "Ubuntu-24.04";

function status(over: Record<string, unknown> = {}) {
  return {
    engine: "claude",
    distro: DISTRO,
    bin: "/usr/bin/claude",
    version: "2.1.280",
    source: "probe",
    configPath: "/home/me/.claude/settings.json",
    probedAgoSecs: 12,
    ...over,
  };
}

let container: HTMLDivElement;
let root: Root | null = null;

async function flush() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

async function render(canEditOfficial = true) {
  container = document.createElement("div");
  document.body.appendChild(container);
  const nextRoot = createRoot(container);
  root = nextRoot;
  await act(async () => {
    nextRoot.render(
      <WslCliPanel
        engine="claude"
        distro={DISTRO}
        canEditOfficial={canEditOfficial}
        onManageHost={() => {}}
      />,
    );
    await flush();
  });
}

function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value",
  )!.set!;
  setter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function overrideInput(): HTMLInputElement {
  const input = container.querySelector<HTMLInputElement>(
    'input[aria-label*="路径覆盖"]',
  );
  expect(input).toBeTruthy();
  return input as HTMLInputElement;
}

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.wslCliStatus.mockResolvedValue([status()]);
  mocks.getWslEnginePaths.mockResolvedValue([]);
  mocks.setWslEnginePath.mockResolvedValue(undefined);
  mocks.wslReprobe.mockResolvedValue([]);
  mocks.getCliConfig.mockResolvedValue({
    claude: { providers: {}, current: null },
  });
  mocks.setEngineEnabled.mockResolvedValue(undefined);
  mocks.wslCliConfigRead.mockResolvedValue([
    {
      key: "settings",
      path: "/home/me/.claude/settings.json",
      format: "json",
      secret: false,
      exists: true,
      tooLarge: false,
      content: "{\n  \"theme\": \"dark\"\n}\n",
      hash: "abc123",
    },
  ]);
  mocks.wslCliConfigWrite.mockResolvedValue(undefined);
});

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  root = null;
});

describe("WslCliPanel", () => {
  it("shows probe path/version, the engine switch and app-level channel notes", async () => {
    await render();
    const text = container.textContent ?? "";
    expect(text).toContain("/usr/bin/claude");
    expect(text).toContain("2.1.280");
    expect(text).toContain("自动探测");
    expect(text).toContain("启用 Claude Code");
    expect(text).toContain("供应商渠道为应用级");
    expect(text).toContain("切回本机管理");
    expect(text).toContain("/home/me/.claude/settings.json");
  });

  it("toggles the engine through the app-level switch", async () => {
    await render();
    const toggle = container.querySelector('[role="switch"]');
    expect(toggle).toBeTruthy();
    await act(async () => {
      (toggle as HTMLElement).click();
      await flush();
    });
    expect(mocks.setEngineEnabled).toHaveBeenCalledWith("claude", false);
  });

  it("shows an override path without borrowing the probed version", async () => {
    mocks.wslCliStatus.mockResolvedValue([
      status({ bin: "/opt/claude", source: "override", version: null }),
    ]);
    await render();
    const text = container.textContent ?? "";
    expect(text).toContain("/opt/claude");
    expect(text).toContain("路径覆盖");
    expect(text).not.toContain("2.1.280");
  });

  it("rescan reprobes the distro and rereads the status", async () => {
    await render();
    expect(mocks.wslCliStatus).toHaveBeenCalledTimes(1);

    const rescan = [...container.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("重新检测"),
    );
    expect(rescan).toBeTruthy();
    await act(async () => {
      rescan!.click();
      await flush();
    });

    expect(mocks.wslReprobe).toHaveBeenCalledWith(DISTRO);
    expect(mocks.wslCliStatus).toHaveBeenCalledTimes(2);
  });

  it("reports a failed status read after a successful rescan without a success check", async () => {
    mocks.wslCliStatus.mockResolvedValueOnce([status()]);
    mocks.wslCliStatus.mockRejectedValueOnce(new Error("probe went away"));
    await render();

    const rescan = [...container.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("重新检测"),
    );
    await act(async () => {
      rescan!.click();
      await flush();
    });

    expect(container.textContent).toContain("读取 CLI 状态失败");
    expect(container.textContent).toContain("probe went away");
  });

  it("shows save validation errors inline", async () => {
    mocks.setWslEnginePath.mockRejectedValue(
      new Error("WSL_CLI_PATH_INVALID:notAbsolute"),
    );
    await render();

    const input = overrideInput();
    await act(async () => {
      setInputValue(input, "/mnt/c/claude");
      input.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
      await flush();
    });

    const alert = container.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("WSL_CLI_PATH_INVALID");
  });

  it("says saved-but-not-refreshed instead of blaming the path", async () => {
    mocks.wslCliStatus.mockResolvedValueOnce([status()]);
    mocks.wslCliStatus.mockRejectedValueOnce(new Error("read failed"));
    await render();

    const input = overrideInput();
    await act(async () => {
      setInputValue(input, "/opt/claude");
      input.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
      await flush();
    });

    expect(mocks.setWslEnginePath).toHaveBeenCalledWith(
      DISTRO,
      "claude",
      "/opt/claude",
    );
    expect(container.textContent).toContain("已保存，但读取状态失败");
    expect(container.textContent).not.toContain("路径无效");
  });

  it("opens the official-config editor and saves with the read hash", async () => {
    await render();

    const edit = [...container.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("编辑"),
    );
    expect(edit).toBeTruthy();
    await act(async () => {
      edit!.click();
      await flush();
    });

    // ModalShell portals to document.body
    expect(document.body.textContent).toContain("/home/me/.claude/settings.json");
    expect(document.body.textContent).toContain('"theme": "dark"');

    const textarea = document.body.querySelector("textarea");
    expect(textarea).toBeTruthy();
    const confirm = [...document.body.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("确认"),
    );
    expect(confirm).toBeTruthy();
    await act(async () => {
      confirm!.click();
      await flush();
    });

    expect(mocks.wslCliConfigWrite).toHaveBeenCalledWith(DISTRO, "claude", [
      {
        key: "settings",
        content: "{\n  \"theme\": \"dark\"\n}\n",
        expectedHash: "abc123",
      },
    ]);
    // 保存成功后关闭弹窗（面板卡上仍有路径,所以用弹窗标题判断）
    expect(document.body.textContent).not.toContain(
      "编辑 Claude Code 官方配置（发行版内）",
    );
  });

  it("shows a conflict with a re-read action", async () => {
    mocks.wslCliConfigWrite.mockRejectedValue(
      new Error("WSL_CLI_CONFIG_CONFLICT:settings"),
    );
    await render();

    const edit = [...container.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("编辑"),
    );
    await act(async () => {
      edit!.click();
      await flush();
    });
    const confirm = [...document.body.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("确认"),
    );
    await act(async () => {
      confirm!.click();
      await flush();
    });

    // errors 被 mock,errorText 返回原始错误串;真机上映射为「已被修改」。
    expect(document.body.textContent).toContain("WSL_CLI_CONFIG_CONFLICT");
    const reread = [...document.body.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("重新读取"),
    );
    expect(reread).toBeTruthy();
  });

  it("does not show the edit button when the engine is not editable", async () => {
    await render(false);
    const edit = [...container.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("编辑"),
    );
    expect(edit).toBeUndefined();
  });
});

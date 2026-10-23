import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@/lib/i18n";

// 只 mock WSL 这一页真正消费的四个命令,其余调用保持失败以暴露误用。
const { ipcMock } = vi.hoisted(() => ({
  ipcMock: {
    wslDistros: vi.fn(),
    wslReprobe: vi.fn(),
    wslProbeSnapshot: vi.fn(),
    getWslEnginePaths: vi.fn(),
    setWslEnginePath: vi.fn(),
  },
}));
vi.mock("@/lib/ipc", () => ({ ipc: ipcMock }));

import { WslSection } from "./WslSection";

// React 18 的 act() 需要测试环境显式声明;不设会刷一屏「not configured」警告,
// 而且挂载期的 setState 不会被包进 act。
declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const DISTRO = "Ubuntu-24.04";

let container: HTMLDivElement;
let root: Root;

async function render() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(<WslSection />);
    // 挂载即探测:两个 IPC 都是异步的,等它们落地再看行。
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

/** React 受控输入不认直接赋值:走原生 setter + input 事件,失焦用 focusout。 */
function setInputValue(input: HTMLInputElement, value: string) {
  const nativeSetter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value",
  )!.set!;
  nativeSetter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function inputFor(cli: string): HTMLInputElement {
  const input = Array.from(container.querySelectorAll("input")).find((el) =>
    el.getAttribute("aria-label")?.includes(cli),
  );
  expect(input).toBeTruthy();
  return input as HTMLInputElement;
}

describe("WslSection CLI path overrides", () => {
  beforeEach(() => {
    ipcMock.wslDistros.mockResolvedValue([DISTRO]);
    ipcMock.wslReprobe.mockResolvedValue([
      { distro: DISTRO, engines: [], versions: {} },
    ]);
    ipcMock.wslProbeSnapshot.mockResolvedValue([
      { distro: DISTRO, engines: [], versions: {} },
    ]);
    ipcMock.getWslEnginePaths.mockResolvedValue([]);
    ipcMock.setWslEnginePath.mockResolvedValue(undefined);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    vi.clearAllMocks();
  });

  it("每个发行版按引擎给出覆盖位,探测不到时也在", async () => {
    await render();

    // 一个都没探到,恰恰是最需要手工指定的场景:三个阶段 1 引擎的输入框都要在。
    expect(container.querySelectorAll("input")).toHaveLength(3);
    expect(inputFor("Claude Code")).toBeTruthy();
    expect(inputFor("Codex CLI")).toBeTruthy();
    expect(inputFor("PI CLI")).toBeTruthy();
  });

  it("保存时写行自己绑定的引擎,不覆盖别的 CLI", async () => {
    // 已有 claude 覆盖、没有 codex:旧实现只有一个输入框且固定写 claude,
    // 用户想补 codex 会把 claude 的路径改掉。
    ipcMock.getWslEnginePaths.mockResolvedValue([["claude", "/opt/claude"]]);
    await render();

    expect(inputFor("Claude Code").value).toBe("/opt/claude");
    expect(inputFor("Codex CLI").value).toBe("");

    await act(async () => {
      setInputValue(inputFor("Codex CLI"), "/home/me/.nvm/bin/codex");
    });
    await act(async () => {
      inputFor("Codex CLI").dispatchEvent(
        new FocusEvent("focusout", { bubbles: true }),
      );
    });

    expect(ipcMock.setWslEnginePath).toHaveBeenCalledTimes(1);
    expect(ipcMock.setWslEnginePath).toHaveBeenCalledWith(
      DISTRO,
      "codex",
      "/home/me/.nvm/bin/codex",
    );
  });

  it("探到的其他引擎也有覆盖位", async () => {
    ipcMock.wslProbeSnapshot.mockResolvedValue([
      { distro: DISTRO, engines: ["pi"], versions: {} },
    ]);
    await render();

    expect(inputFor("PI CLI")).toBeTruthy();
  });

  it("CLI 徽标带上发行版内的版本号", async () => {
    // §5.9 要求列出"各引擎探测结果与版本":没探到版本就只显示名字,
    // 不能渲染成空括号或 undefined。
    ipcMock.wslProbeSnapshot.mockResolvedValue([
      {
        distro: DISTRO,
        engines: ["claude", "codex"],
        versions: { claude: "2.1.280" },
      },
    ]);
    await render();

    expect(container.textContent).toContain("Claude Code2.1.280");
    expect(container.textContent).toContain("Codex CLI");
    expect(container.textContent).not.toContain("undefined");
  });
});

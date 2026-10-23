import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import "@/lib/i18n";
import type { WslNotice } from "@/lib/ipc";
import { useChatStore } from "../store";
import { WslNotices } from "./WslNotices";

/**
 * 运行期提示条:本机 WSL 的「回收未确认 / 缺 rg」不在某次操作里失败,而是
 * 后台事实。设计稿要求不能静默(§5.7 第 5 条)、且同类合并、取走即清
 * (不让每轮刷新重复弹)。
 */

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const EXIT: WslNotice = {
  kind: "exitUnproven",
  distro: "Ubuntu-24.04",
  runId: "run-1",
  atMs: 1,
};

describe("本机 WSL 运行期提示", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(async () => {
    useChatStore.setState({ wslNotices: [] });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root.render(<WslNotices />);
    });
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    useChatStore.setState({ wslNotices: [] });
  });

  const text = () => container.textContent ?? "";

  it("没有提示时不占位", () => {
    expect(container.firstChild).toBeNull();
  });

  it("按发行版展示两类提示，关闭只移除那一条", async () => {
    await act(async () => {
      useChatStore.setState({
        wslNotices: [EXIT, { kind: "rgMissing", distro: "Ubuntu-24.04", atMs: 2 }],
      });
    });
    expect(container.querySelector('[role="status"]')).not.toBeNull();
    expect(text()).toContain("Ubuntu-24.04");
    expect(text()).toContain("ripgrep");
    expect(container.querySelectorAll("button")).toHaveLength(2);

    await act(async () => {
      useChatStore.getState().dismissWslNotice(EXIT);
    });
    // 关掉的不是整块提示条:另一条仍在,且只剩它的关闭键。
    expect(container.querySelectorAll("button")).toHaveLength(1);
    expect(text()).not.toContain("可能仍在运行");
    expect(text()).toContain("ripgrep");
  });
});

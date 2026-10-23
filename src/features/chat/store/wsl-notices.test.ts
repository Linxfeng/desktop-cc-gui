import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WslNotice } from "@/lib/ipc";

/**
 * 本机 WSL 运行期提示的 store 侧收口:后端队列取走即清,store 只保留展示
 * 副本。这里校验合并口径(同 kind+发行版不重复)与「没有新增就不写 store」
 * ——后者决定侧栏每轮刷新会不会被无意义地重渲染。
 */

const takeWslNotices = vi.fn<() => Promise<WslNotice[]>>(async () => []);
vi.mock("../wsl-sessions", () => ({
  takeWslNotices: () => takeWslNotices(),
  listWslSessionMetas: vi.fn(async () => []),
  forgetWslWorkspace: vi.fn(),
}));

import { useChatStore } from "../store";

const EXIT: WslNotice = {
  kind: "exitUnproven",
  distro: "Ubuntu-24.04",
  runId: "run-1",
  atMs: 1,
};
const RG: WslNotice = { kind: "rgMissing", distro: "Ubuntu-24.04", atMs: 2 };

describe("drainWslNotices", () => {
  beforeEach(() => {
    takeWslNotices.mockReset();
    takeWslNotices.mockResolvedValue([]);
    useChatStore.setState({ wslNotices: [] });
  });

  it("取到的提示并入展示副本，同一身份只留一条", async () => {
    takeWslNotices.mockResolvedValue([EXIT, RG, { ...RG, atMs: 99 }]);
    await useChatStore.getState().drainWslNotices();
    const notices = useChatStore.getState().wslNotices;
    // 保持后端给出的先后顺序,重复的 rg 只留第一条。
    expect(notices.map((n) => n.kind)).toEqual(["exitUnproven", "rgMissing"]);
  });

  it("没有新提示时不写 store（避免每轮刷新重渲染）", async () => {
    takeWslNotices.mockResolvedValue([EXIT]);
    await useChatStore.getState().drainWslNotices();
    const first = useChatStore.getState().wslNotices;
    // 同一提示再次到达（后端重记）:展示副本不变,引用也保持。
    takeWslNotices.mockResolvedValue([EXIT]);
    await useChatStore.getState().drainWslNotices();
    expect(useChatStore.getState().wslNotices).toBe(first);
  });

  it("关闭后不再被旧的展示副本带回", async () => {
    takeWslNotices.mockResolvedValue([EXIT]);
    await useChatStore.getState().drainWslNotices();
    useChatStore.getState().dismissWslNotice(EXIT);
    expect(useChatStore.getState().wslNotices).toEqual([]);
    // 队列已空:下一次 drain 不会复活它。
    takeWslNotices.mockResolvedValue([]);
    await useChatStore.getState().drainWslNotices();
    expect(useChatStore.getState().wslNotices).toEqual([]);
  });
});

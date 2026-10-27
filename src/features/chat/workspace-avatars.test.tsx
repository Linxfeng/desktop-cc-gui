import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ gitWorkspaceOwners: vi.fn() }));

vi.mock("@/lib/ipc", () => ({ ipc: { gitWorkspaceOwners: mocks.gitWorkspaceOwners } }));

import {
  requestWorkspaceOwners,
  resetWorkspaceAvatarsForTests,
  useWorkspaceAvatarUrl,
} from "./workspace-avatars";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function Harness({ path }: { path: string }) {
  const src = useWorkspaceAvatarUrl(path, 20);
  return <span data-path={path}>{src ?? ""}</span>;
}

describe("workspace avatars", () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  beforeEach(() => {
    resetWorkspaceAvatarsForTests();
    mocks.gitWorkspaceOwners.mockReset();
    mocks.gitWorkspaceOwners.mockResolvedValue([]);
  });

  afterEach(async () => {
    await act(async () => {
      root?.unmount();
    });
    container?.remove();
    container = null;
    root = null;
  });

  async function render(node: React.ReactNode) {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(node);
    });
    // Passive effects run when the render act settles, so the batch's 0ms
    // flush only lands in a second act.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    return container;
  }

  function srcFor(path: string): string {
    return container!.querySelector(`[data-path="${path}"]`)?.textContent ?? "";
  }

  it("batches the commit's rows into one lookup and shows the owner avatar", async () => {
    mocks.gitWorkspaceOwners.mockResolvedValue([{ path: "/ws/a", login: "owner-a" }]);

    await render(
      <>
        <Harness path="/ws/a" />
        <Harness path="/ws/b" />
      </>,
    );

    expect(mocks.gitWorkspaceOwners).toHaveBeenCalledTimes(1);
    expect(mocks.gitWorkspaceOwners).toHaveBeenCalledWith(["/ws/a", "/ws/b"]);
    // 20px CSS chip → 2× bitmap; a repo without a GitHub owner stays empty
    // so the row keeps its folder glyph.
    expect(srcFor("/ws/a")).toBe("https://github.com/owner-a.png?size=40");
    expect(srcFor("/ws/b")).toBe("");
  });

  it("remembers both hits and misses, so a remount does not re-query", async () => {
    mocks.gitWorkspaceOwners.mockResolvedValue([{ path: "/ws/a", login: "owner-a" }]);
    await render(<Harness path="/ws/a" />);

    await act(async () => {
      root!.unmount();
    });
    root = createRoot(container!);
    await act(async () => {
      root!.render(<Harness path="/ws/a" />);
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(mocks.gitWorkspaceOwners).toHaveBeenCalledTimes(1);
    expect(srcFor("/ws/a")).toBe("https://github.com/owner-a.png?size=40");

    // A known-empty path (resolved to no owner) is cached the same way.
    requestWorkspaceOwners(["/ws/b"]);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    requestWorkspaceOwners(["/ws/b"]);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(mocks.gitWorkspaceOwners).toHaveBeenCalledTimes(2);
  });

  it("does not cache an IPC failure, so a later mount retries", async () => {
    mocks.gitWorkspaceOwners.mockRejectedValueOnce(new Error("ipc down"));
    await render(<Harness path="/ws/a" />);
    expect(srcFor("/ws/a")).toBe("");

    mocks.gitWorkspaceOwners.mockResolvedValueOnce([{ path: "/ws/a", login: "owner-a" }]);
    await act(async () => {
      root!.unmount();
    });
    root = createRoot(container!);
    await act(async () => {
      root!.render(<Harness path="/ws/a" />);
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(mocks.gitWorkspaceOwners).toHaveBeenCalledTimes(2);
    expect(srcFor("/ws/a")).toBe("https://github.com/owner-a.png?size=40");
  });
});

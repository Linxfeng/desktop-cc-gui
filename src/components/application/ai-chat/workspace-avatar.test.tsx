import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ useWorkspaceAvatarUrl: vi.fn() }));

vi.mock("@/features/chat/workspace-avatars", () => ({
  useWorkspaceAvatarUrl: mocks.useWorkspaceAvatarUrl,
}));

import { WorkspaceAvatar } from "./workspace-avatar";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("WorkspaceAvatar", () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  afterEach(async () => {
    await act(async () => {
      root?.unmount();
    });
    container?.remove();
    container = null;
    root = null;
    mocks.useWorkspaceAvatarUrl.mockReset();
  });

  async function render(node: ReactNode) {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(node);
    });
    return container;
  }

  it("keeps the folder fallback visible until an avatar URL resolves", async () => {
    mocks.useWorkspaceAvatarUrl.mockReturnValue(null);
    const view = await render(<WorkspaceAvatar path="/ws/a" fallback={<span>folder</span>} />);

    expect(view.querySelector("img")).toBeNull();
    expect(view.textContent).toBe("folder");
  });

  it("covers the fallback with the GitHub avatar and falls back on error", async () => {
    mocks.useWorkspaceAvatarUrl.mockReturnValue("https://github.com/owner-a.png?size=40");
    const view = await render(<WorkspaceAvatar path="/ws/a" fallback={<span>folder</span>} />);

    const img = view.querySelector<HTMLImageElement>("img");
    expect(img?.getAttribute("src")).toBe("https://github.com/owner-a.png?size=40");
    // The fallback stays underneath as the loading / offline state.
    expect(view.textContent).toBe("folder");

    await act(async () => {
      img!.dispatchEvent(new Event("error"));
    });
    expect(view.querySelector("img")).toBeNull();
    expect(view.textContent).toBe("folder");

    // A recycled row gets a different workspace: the failed URL must not stick.
    mocks.useWorkspaceAvatarUrl.mockReturnValue("https://github.com/owner-b.png?size=40");
    await act(async () => {
      root!.render(<WorkspaceAvatar path="/ws/b" fallback={<span>folder</span>} />);
    });
    expect(view.querySelector<HTMLImageElement>("img")?.getAttribute("src")).toBe(
      "https://github.com/owner-b.png?size=40",
    );
  });
});

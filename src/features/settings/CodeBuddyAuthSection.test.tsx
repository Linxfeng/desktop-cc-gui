import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/lib/i18n";
import type { CodeBuddyAccountStatus } from "@/lib/ipc";

const mocks = vi.hoisted(() => ({
  codebuddyAccountStatus: vi.fn(),
  launchCodeBuddyLogin: vi.fn(),
  navigate: vi.fn(),
}));

vi.mock("@/lib/ipc", () => ({
  ipc: { codebuddyAccountStatus: mocks.codebuddyAccountStatus },
}));
vi.mock("./codebuddyLogin", () => ({
  launchCodeBuddyLogin: mocks.launchCodeBuddyLogin,
}));
vi.mock("react-router-dom", () => ({
  useNavigate: () => mocks.navigate,
}));

import { CodeBuddyAuthSection } from "./CodeBuddyAuthSection";

void i18n;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root | null;

async function render() {
  root = createRoot(container);
  await act(async () => root!.render(<CodeBuddyAuthSection />));
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  mocks.codebuddyAccountStatus.mockReset().mockResolvedValue({
    loggedIn: false,
    detection: "unknown",
  });
  mocks.launchCodeBuddyLogin.mockReset().mockResolvedValue({ ok: true });
  mocks.navigate.mockReset();
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  container.remove();
});

describe("CodeBuddy account status", () => {
  it("keeps a pending probe distinct from a failed IPC request", async () => {
    const pending = Promise.withResolvers<CodeBuddyAccountStatus>();
    mocks.codebuddyAccountStatus.mockReturnValueOnce(pending.promise);
    await render();
    expect(container.textContent).toContain(i18n.t("settings.codebuddyAccountChecking"));
    expect(container.textContent).not.toContain(i18n.t("settings.codebuddyAccountError"));

    mocks.codebuddyAccountStatus.mockRejectedValueOnce(new Error("IPC unavailable"));
    const refresh = [...container.querySelectorAll("button")].find((button) =>
      button.textContent?.includes(i18n.t("settings.codebuddyAccountRefresh")),
    )!;
    await act(async () => pending.resolve({ loggedIn: false, detection: "unknown" }));
    await act(async () => refresh.click());
    expect(container.textContent).toContain(i18n.t("settings.codebuddyAccountError"));
    expect(container.textContent).not.toContain(i18n.t("settings.codebuddyAccountChecking"));
  });

  it("forces the first probe after login navigation unmounts the section", async () => {
    await render();
    const login = [...container.querySelectorAll("button")].find((button) =>
      button.textContent?.includes(i18n.t("settings.codebuddyAccountLogin")),
    )!;
    await act(async () => login.click());
    expect(mocks.navigate).toHaveBeenCalledWith("/");

    await act(async () => root!.unmount());
    root = null;
    await render();
    expect(mocks.codebuddyAccountStatus.mock.calls.at(-1)).toEqual([true]);

    await act(async () => window.dispatchEvent(new Event("focus")));
    expect(mocks.codebuddyAccountStatus.mock.calls.at(-1)).toEqual([false]);
  });
});

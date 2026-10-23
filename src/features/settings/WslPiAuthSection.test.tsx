import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  wslPiAuthList: vi.fn(),
  wslPiAuthSetKey: vi.fn(),
  wslPiAuthDelete: vi.fn(),
  wslPiModelsRead: vi.fn(),
  wslPiModelsWrite: vi.fn(),
}));

vi.mock("@/lib/ipc", () => ({ ipc: mocks }));
vi.mock("@/lib/errors", () => ({
  errorText: (error: unknown) =>
    error instanceof Error ? error.message : String(error),
}));

import "@/lib/i18n";
import { WslPiAuthSection } from "./WslPiAuthSection";

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const DISTRO = "Ubuntu-24.04";

function modelsRead(over: Record<string, unknown> = {}) {
  return {
    path: "/home/me/.pi/agent/models.json",
    exists: true,
    text: `{\n  // relay\n  "providers": {\n    "my-relay": {\n      "baseUrl": "https://relay.example/v1",\n      "models": [{ "id": "m1" }]\n    }\n  }\n}\n`,
    template: "{\n}\n",
    providers: [
      {
        id: "my-relay",
        name: null,
        baseUrl: "https://relay.example/v1",
        api: null,
        modelCount: 1,
        hasApiKey: false,
      },
    ],
    parseError: null,
    hash: "hash-1",
    ...over,
  };
}

function authList(over: Record<string, unknown> = {}) {
  return {
    store: {
      path: "/home/me/.pi/agent/auth.json",
      kind: "authJson",
      exists: true,
    },
    providers: [
      {
        id: "anthropic",
        envVar: "ANTHROPIC_API_KEY",
        state: "configured",
        maskedKey: "sk-ant········abcd",
        keySource: "literal",
      },
    ],
    oauthProviders: ["openai-codex"],
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

async function render() {
  container = document.createElement("div");
  document.body.appendChild(container);
  const nextRoot = createRoot(container);
  root = nextRoot;
  await act(async () => {
    nextRoot.render(<WslPiAuthSection distro={DISTRO} />);
    await flush();
  });
}

function setInputValue(input: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto =
    input instanceof HTMLTextAreaElement
      ? window.HTMLTextAreaElement.prototype
      : window.HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")!.set!;
  setter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.wslPiAuthList.mockResolvedValue(authList());
  mocks.wslPiModelsRead.mockResolvedValue(modelsRead());
  mocks.wslPiAuthSetKey.mockResolvedValue(undefined);
  mocks.wslPiAuthDelete.mockResolvedValue(undefined);
  mocks.wslPiModelsWrite.mockResolvedValue(undefined);
});

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  root = null;
});

describe("WslPiAuthSection", () => {
  it("shows masked keys and the distro store path without plaintext", async () => {
    await render();
    const text = container.textContent ?? "";
    expect(text).toContain("sk-ant········abcd");
    expect(text).toContain("/home/me/.pi/agent/auth.json");
    expect(text).toContain("已授权");
  });

  it("hides the OAuth login button and shows the in-distro command instead", async () => {
    await render();
    const text = container.textContent ?? "";
    expect(text).toContain("pi /login anthropic");
    // 登录按钮没渲染（hint 里的「OAuth 登录」是固定文案，不算按钮）。
    const loginButtons = [...container.querySelectorAll("button")].filter(
      (button) => button.textContent?.trim() === "登录",
    );
    expect(loginButtons).toHaveLength(0);
  });

  it("saves a key through the distro command", async () => {
    mocks.wslPiAuthList.mockResolvedValue(
      authList({
        providers: [
          {
            id: "anthropic",
            envVar: "ANTHROPIC_API_KEY",
            state: "none",
          },
        ],
      }),
    );
    await render();

    const setBtn = [...container.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("设置"),
    );
    expect(setBtn).toBeTruthy();
    await act(async () => {
      setBtn!.click();
      await flush();
    });

    const input = container.querySelector<HTMLInputElement>(
      'input[id="pi-family-auth-key-anthropic"]',
    );
    expect(input).toBeTruthy();
    await act(async () => {
      setInputValue(input!, "sk-ant-new-key-123");
      await flush();
    });
    const save = [...container.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("保存"),
    );
    await act(async () => {
      save!.click();
      await flush();
    });

    expect(mocks.wslPiAuthSetKey).toHaveBeenCalledWith(
      DISTRO,
      "anthropic",
      "sk-ant-new-key-123",
    );
  });

  it("saves models.json edits verbatim with the read hash", async () => {
    await render();

    const edit = [...container.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("编辑配置"),
    );
    expect(edit).toBeTruthy();
    await act(async () => {
      edit!.click();
      await flush();
    });

    const textarea = container.querySelector<HTMLTextAreaElement>(
      "#pi-family-models-config-text",
    );
    expect(textarea).toBeTruthy();
    const next = modelsRead().text!.replace("m1", "m2");
    await act(async () => {
      setInputValue(textarea!, next);
      await flush();
    });
    const save = [...container.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("保存"),
    );
    expect(save).toBeTruthy();
    await act(async () => {
      save!.click();
      await flush();
    });

    expect(mocks.wslPiModelsWrite).toHaveBeenCalledWith(DISTRO, next, "hash-1");
  });

  it("deletes a key after confirmation through the distro command", async () => {
    await render();
    const del = [...container.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("删除"),
    );
    expect(del).toBeTruthy();
    await act(async () => {
      del!.click();
      await flush();
    });
    // ConfirmDialog portals to document.body
    const confirm = [...document.body.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("确认"),
    );
    await act(async () => {
      confirm!.click();
      await flush();
    });
    expect(mocks.wslPiAuthDelete).toHaveBeenCalledWith(DISTRO, "anthropic");
  });

  it("surfaces corrupted-store errors without losing the section", async () => {
    mocks.wslPiAuthList.mockRejectedValue(
      new Error(
        "[PI_FAMILY_AUTH_CORRUPTED] /home/me/.pi/agent/auth.json is not valid JSON: …",
      ),
    );
    await render();
    expect(container.textContent).toContain("PI_FAMILY_AUTH_CORRUPTED");
  });
});

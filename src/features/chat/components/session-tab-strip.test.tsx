import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SessionTabStrip, type SessionTabItem } from "./SessionTabStrip";
import { TabStripContextMenu } from "./TabStripContextMenu";

vi.mock("react-i18next", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-i18next")>();
  // 部分 mock：页签条的新菜单会（经分屏 store）间接引入 lib/i18n，
  // 它需要真实的 initReactI18next 才能初始化。
  return { ...actual, useTranslation: () => ({ t: (key: string) => key }) };
});
// jsdom gaps exercised by use-tab-strip-chrome's scroll-into-view effect.
globalThis.CSS ??= {} as typeof CSS;
CSS.escape ??= (value: string) => value;
Element.prototype.scrollIntoView ??= () => {};

const TABS: SessionTabItem[] = [
  { key: "a", label: "Alpha", streaming: false },
  { key: "b", label: "Beta", streaming: false },
];

let node: HTMLDivElement;
let root: Root;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  node = document.createElement("div");
  document.body.append(node);
  root = createRoot(node);
});

afterEach(async () => {
  await act(async () => root.unmount());
  node.remove();
});

function menuItems(): string[] {
  return [...document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')].map(
    (el) => el.textContent ?? "",
  );
}

async function render(extra: Partial<Parameters<typeof SessionTabStrip>[0]> = {}) {
  await act(async () => {
    root.render(
      <SessionTabStrip
        tabs={TABS}
        activeKey="a"
        onSelect={() => {}}
        onClose={() => {}}
        closeLabel="close"
        onNew={() => {}}
        onNewBrowser={() => {}}
        {...extra}
      />,
    );
  });
}

/** The scroll container owns the blank area right of the "+" button. */
function scrollContainer(): HTMLElement {
  const el = node.querySelector<HTMLElement>(".overflow-x-auto");
  if (!el) throw new Error("scroll container not found");
  return el;
}

it("opens the 新建会话/新建浏览器 menu on blank-area right-click", async () => {
  await render();

  await act(async () => {
    scrollContainer().dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, clientX: 300, clientY: 12 }),
    );
  });

  expect(menuItems()).toEqual(["chat.newSession", "chat.newBrowser"]);
});

it("blank-area menu entries invoke onNew / onNewBrowser", async () => {
  const onNew = vi.fn();
  const onNewBrowser = vi.fn();
  await render({ onNew, onNewBrowser });

  await act(async () => {
    scrollContainer().dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, clientX: 300, clientY: 12 }),
    );
  });
  const items = [...document.body.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
  await act(async () => items[1].click());

  expect(onNewBrowser).toHaveBeenCalledOnce();
  expect(onNew).not.toHaveBeenCalled();
  expect(menuItems()).toEqual([]);
});

it("keeps tab right-click on the tab menu, not the new-tab menu", async () => {
  await render({ onCloseAll: () => {} });
  const tab = node.querySelector<HTMLElement>('[data-tab-key="b"]');
  if (!tab) throw new Error("tab not found");

  await act(async () => {
    tab.dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, clientX: 40, clientY: 12 }),
    );
  });

  expect(menuItems()).not.toContain("chat.newSession");
  expect(menuItems()).not.toContain("chat.newBrowser");
});

it("offers no menu when onNewBrowser is omitted", async () => {
  await render({ onNewBrowser: undefined });

  await act(async () => {
    scrollContainer().dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, clientX: 300, clientY: 12 }),
    );
  });

  expect(menuItems()).toEqual([]);
});

it("marks a tab with a pending notice as unread, with its own accessible name", async () => {
  await render({
    tabs: [
      ...TABS,
      { key: "notes", label: "Release Notes", streaming: false, unread: "新版本" },
    ],
  });

  // 未读提醒不借用会话活动的绿点（语义与颜色都是另一套）。
  expect(node.querySelector('[data-tab-key="b"] [role="status"]')).toBeNull();
  const dot = node.querySelector('[data-tab-key="notes"] [role="status"]');
  expect(dot?.getAttribute("aria-label")).toBe("新版本");
  expect(dot?.getAttribute("title")).toBe("新版本");
  expect(dot?.className).toContain("bg-accent-500");
});
it("renders batch close and split options on session tab right-click", async () => {
  const onCloseInactive = vi.fn();
  const onCloseLeft = vi.fn();
  const onCloseRight = vi.fn();
  const onCloseAll = vi.fn();

  await render({
    tabs: [
      { key: "s1", label: "Session 1", streaming: false, session: { engine: "claude", sessionId: "1", workspacePath: "/w" } },
      { key: "s2", label: "Session 2", streaming: false, session: { engine: "claude", sessionId: "2", workspacePath: "/w" } },
      { key: "s3", label: "Session 3", streaming: false, session: { engine: "claude", sessionId: "3", workspacePath: "/w" } },
    ],
    onCloseInactive,
    onCloseLeft,
    onCloseRight,
    onCloseAll,
  });

  // Right-click middle session tab s2
  const tab = node.querySelector<HTMLElement>('[data-tab-key="s2"]');
  if (!tab) throw new Error("tab s2 not found");

  await act(async () => {
    tab.dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, clientX: 100, clientY: 12 }),
    );
  });

  expect(menuItems()).toEqual([
    "chat.closeInactiveTabs",
    "chat.closeLeftTabs",
    "chat.closeRightTabs",
    "chat.closeAllTabs",
    "chat.splitRight",
    "chat.splitDown",
  ]);

  const items = [...document.body.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
  // Click close left
  await act(async () => items[1].click());
  expect(onCloseLeft).toHaveBeenCalledWith("s2");
});

it("renders file actions when right clicking a file tab", async () => {
  const onCloseAll = vi.fn();

  await render({
    tabs: [
      { key: "s1", label: "Session 1", streaming: false },
      { key: "file:/src/app.tsx", label: "app.tsx", title: "/src/app.tsx", streaming: false },
    ],
    onCloseAll,
    onCloseInactive: vi.fn(),
    onCloseLeft: vi.fn(),
    onCloseRight: vi.fn(),
  });

  const tab = node.querySelector<HTMLElement>('[data-tab-key="file:/src/app.tsx"]');
  if (!tab) throw new Error("file tab not found");

  await act(async () => {
    tab.dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, clientX: 120, clientY: 12 }),
    );
  });

  const items = menuItems();
  expect(items).toContain("files.copyPath");
  expect(items).toContain("files.sendPathToComposer");
  expect(items.some((label) => label.startsWith("files.revealIn"))).toBe(true);
});

it("drops the tab menu when its target tab leaves the strip while the menu is open", async () => {
  // ⌘W 不在右键菜单的关闭条件里：菜单开着时目标页签被关掉，旧菜单还挂着，
  // 「关闭其他 / 分屏」会作用到已不存在的页签。
  const SESSION_TABS: SessionTabItem[] = [
    { key: "s1", label: "Session 1", streaming: false, session: { engine: "claude", sessionId: "1", workspacePath: "/w" } },
    { key: "s2", label: "Session 2", streaming: false, session: { engine: "claude", sessionId: "2", workspacePath: "/w" } },
    { key: "s3", label: "Session 3", streaming: false, session: { engine: "claude", sessionId: "3", workspacePath: "/w" } },
  ];
  const onCloseInactive = vi.fn();
  const handlers = { onCloseInactive, onCloseLeft: vi.fn(), onCloseRight: vi.fn(), onCloseAll: vi.fn() };
  await render({ tabs: SESSION_TABS, ...handlers });

  const tab = node.querySelector<HTMLElement>('[data-tab-key="s2"]');
  if (!tab) throw new Error("tab s2 not found");
  await act(async () => {
    tab.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 100, clientY: 12 }));
  });
  expect(menuItems()).toContain("chat.closeInactiveTabs");

  await render({ tabs: [SESSION_TABS[0], SESSION_TABS[2]], ...handlers });
  expect(menuItems()).toEqual([]);

  // 状态已清空而不只是隐藏：同一页签重新打开时，旧菜单不会复活。
  await render({ tabs: SESSION_TABS, ...handlers });
  expect(menuItems()).toEqual([]);
  expect(onCloseInactive).not.toHaveBeenCalled();
});

it("disables Close Others when the menu target is not among the tabs", async () => {
  await act(async () => {
    root.render(
      <TabStripContextMenu
        menu={{ x: 10, y: 10, tab: { key: "gone", label: "Gone", streaming: false } }}
        tabs={TABS}
        onCloseInactive={vi.fn()}
        onCloseLeft={vi.fn()}
        onCloseRight={vi.fn()}
        onDismiss={() => {}}
      />,
    );
  });
  const disabled = Object.fromEntries(
    [...document.body.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].map((el) => [
      el.textContent,
      el.disabled,
    ]),
  );
  expect(disabled).toEqual({
    "chat.closeInactiveTabs": true,
    "chat.closeLeftTabs": true,
    "chat.closeRightTabs": true,
  });
});

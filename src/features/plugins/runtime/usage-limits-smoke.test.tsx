/**
 * usage-limits 插件的真宿主冒烟测试：把兄弟仓库
 * `../CCGUI 插件/ccgui-plugin-usage-limits/main.js`（构建产物）挂到真实的
 * createPluginContext 上——宿主 React、真实注册表、ctx.usage / ctx.limits 的
 * 权限门与参数校验——渲染状态栏芯片、弹出面板、中心页签和设置页。
 * 插件仓不在本机时整组跳过（原因打印在 stderr，不假装跑过）。
 *
 * 覆盖的是插件 × 宿主能力面的契约（manifest 校验、注册 key、SDK 调用形状、
 * 卸载回收）；插件自身的交互细节由插件仓的测试与预览覆盖。
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { act, createElement, type ComponentType } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  centerTabRegistry,
  commandRegistry,
  settingsRegistry,
  sidebarNavRegistry,
  statusBarRegistry,
} from "@ccgui/plugin-sdk";
import type { PluginManifest, UsageLimitsResult, UsageStatsResult } from "@ccgui/plugin-sdk";
import { createPluginContext, type PluginContextBackend } from "./context";
import { validateManifest } from "./permissions";
import type { UsageStatsHostQuery } from "./usage-bridge";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const PLUGIN_DIR = path.resolve(process.cwd(), "../CCGUI 插件/ccgui-plugin-usage-limits");
const PLUGIN_MAIN = path.join(PLUGIN_DIR, "main.js");
const PLUGIN_MANIFEST = path.join(PLUGIN_DIR, "manifest.json");
const PLUGIN_AVAILABLE = existsSync(PLUGIN_MAIN) && existsSync(PLUGIN_MANIFEST);
if (!PLUGIN_AVAILABLE) {
  console.warn(`[usage-limits-smoke] sibling plugin repo not found (${PLUGIN_MAIN}) — group skipped`);
}

vi.mock("@/lib/transport", () => ({
  listen: vi.fn(async () => () => {}),
  invoke: vi.fn(async () => null),
  isWeb: false,
}));
vi.mock("./workspace-bridge", () => ({
  listPluginWorkspaces: () => [
    { id: "ws-app", path: "/repo/app", name: "app", kind: "workspace", parentId: null },
  ],
  addPluginWorkspace: vi.fn(),
  openPluginSession: vi.fn(),
}));
vi.mock("@/features/chat/center-surfaces", () => ({ dismissCenterSurfaces: vi.fn() }));
vi.mock("@/lib/i18n", () => ({
  default: { t: (key: string) => key, language: "zh", on: vi.fn(), off: vi.fn() },
}));

const pad = (n: number) => String(n).padStart(2, "0");
const dayKey = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

function usageRows(query: UsageStatsHostQuery): UsageStatsResult {
  const today = dayKey(new Date());
  const bucket = query.bucket === "hour" ? `${today}T09` : today;
  return {
    rows: [
      { bucket, engine: "claude", model: "claude-opus-5-5", project: "/repo/app/src", sessions: 2, requests: 40, input: 120_000, output: 80_000, cacheRead: 2_000_000, cacheWrite: 100_000, reasoning: 0, cost: 12.5 },
      { bucket, engine: "codex", model: "gpt-5.5", project: "/elsewhere", sessions: 1, requests: 5, input: 10_000, output: 5_000, cacheRead: 50_000, cacheWrite: 0, reasoning: 1_000, cost: 0.4 },
      { bucket, engine: "pi", model: "kimi-k3", project: null, sessions: 1, requests: 3, input: 1_000, output: 500, cacheRead: 0, cacheWrite: 0, reasoning: 0, cost: null },
    ],
    firstDay: today,
    scannedAt: Date.now(),
    scanning: false,
    unknownModels: ["kimi-k3"],
  };
}

const LIMITS: UsageLimitsResult = {
  providers: [
    {
      id: "claude", status: "ok", plan: "Max 20x", host: "api.anthropic.com", fetchedAt: Date.now(), retryAt: null, error: null,
      windows: [
        { id: "five_hour", kind: "session", label: null, usedPercent: 52, windowSeconds: 18_000, resetsAt: Date.now() + 72 * 60_000 },
        { id: "seven_day", kind: "weekly", label: null, usedPercent: 37, windowSeconds: 604_800, resetsAt: Date.now() + 28 * 3_600_000 },
      ],
      extra: null,
    },
    { id: "codex", status: "expired", plan: null, host: "chatgpt.com", fetchedAt: null, retryAt: null, error: null, windows: [], extra: null },
  ],
};

function backend(): PluginContextBackend & { calls: string[] } {
  const store = new Map<string, unknown>();
  const calls: string[] = [];
  const record = <T,>(name: string, value: T) => {
    calls.push(name);
    return Promise.resolve(value);
  };
  const base = {
    calls,
    get: async (_id: string, key: string) => store.get(key) ?? null,
    set: async (_id: string, key: string, value: unknown) => void store.set(key, value),
    delete: async (_id: string, key: string) => void store.delete(key),
    bridgeInvoke: async () => null,
    workspaceMetadata: async () => ({ id: "ws-app", path: "/repo/app" }),
    pickDirectory: async () => null,
    pickFile: async () => null,
    usageQuery: (_id: string, query: UsageStatsHostQuery) => record("usage.query", usageRows(query)),
    usageSources: () => record("usage.sources", [
      { engine: "claude", label: "Claude Code", roots: ["~/.claude/projects"], env: "CLAUDE_CONFIG_DIR", files: 12, status: "ok" as const, error: null, lastScanAt: Date.now() },
    ]),
    usageRefresh: () => record("usage.refresh", { filesScanned: 1, eventsAdded: 0, durationMs: 3, scannedAt: Date.now() }),
    usageRescan: () => record("usage.rescan", { filesScanned: 12, eventsAdded: 0, durationMs: 30, scannedAt: Date.now() }),
    usagePrices: () => record("usage.prices", { source: "bundled" as const, snapshotDate: "2026-10-28", updatedAt: null, models: 2738 }),
    usageUpdatePrices: () => record("usage.updatePrices", { source: "online" as const, snapshotDate: "2026-10-28", updatedAt: Date.now(), models: 2740 }),
    usageSubscribe: () => () => {},
    limitsGet: () => record("limits.get", LIMITS),
  };
  return base as unknown as PluginContextBackend & { calls: string[] };
}

async function flush(rounds = 8) {
  for (let i = 0; i < rounds; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

describe.skipIf(!PLUGIN_AVAILABLE)("usage-limits plugin on the real host runtime", () => {
  let container: HTMLDivElement;
  let root: Root;
  const errors: unknown[] = [];
  const errorSpy = vi.spyOn(console, "error");

  beforeEach(() => {
    errors.length = 0;
    errorSpy.mockImplementation((...args) => void errors.push(args));
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    errorSpy.mockReset();
  });

  async function activate() {
    const manifest = JSON.parse(readFileSync(PLUGIN_MANIFEST, "utf8")) as PluginManifest;
    expect(validateManifest(manifest)).toEqual([]);
    const source = readFileSync(PLUGIN_MAIN, "utf8");
    const mod = await import("data:text/javascript;base64," + Buffer.from(source, "utf8").toString("base64"));
    const be = backend();
    const { ctx, disposers } = createPluginContext(manifest, be, { appVersion: "1.1.9" });
    const deactivate = mod.default(ctx) as (() => void) | undefined;
    return { be, disposers, deactivate };
  }

  async function render(component: ComponentType) {
    await act(async () => {
      root.render(createElement(component));
    });
    await flush();
  }

  it("validates, registers every surface, renders with host React and cleans up", async () => {
    const { be, disposers, deactivate } = await activate();

    const chip = statusBarRegistry.get("plugin:usage-limits:chip");
    const tab = centerTabRegistry.get("plugin:usage-limits:usage");
    const settings = settingsRegistry.get("plugin:usage-limits:settings");
    expect(chip?.zone).toBe("start");
    expect(tab).toBeTruthy();
    expect(settings).toBeTruthy();
    expect(sidebarNavRegistry.getSnapshot().some((entry) => entry.id.startsWith("plugin:usage-limits"))).toBe(true);
    expect(commandRegistry.getSnapshot().filter((c) => c.id.startsWith("plugin:usage-limits")).length).toBeGreaterThanOrEqual(2);

    // Status bar chip: today's totals arrive through ctx.usage.query.
    await render(chip!.component as ComponentType);
    expect(be.calls).toContain("usage.query");
    const chipButton = container.querySelector<HTMLButtonElement>("button[aria-haspopup]");
    expect(chipButton).toBeTruthy();
    expect(container.textContent).toMatch(/2\.4M|2\.37M|\$12\.9/);

    // Popover opens on click, shows limits, closes on Escape.
    await act(async () => chipButton!.click());
    await flush();
    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog).toBeTruthy();
    expect(be.calls).toContain("limits.get");
    expect(dialog!.textContent).toMatch(/52%/);
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    await flush(2);
    expect(document.querySelector('[role="dialog"]')).toBeNull();

    // Center tab overview, then the limits page.
    await render(tab!.component as ComponentType);
    expect(container.textContent).toMatch(/kimi-k3/);
    const limitsTab = Array.from(container.querySelectorAll<HTMLButtonElement>("button,[role=tab]"))
      .find((b) => /限额|Limits/.test(b.textContent ?? ""));
    expect(limitsTab).toBeTruthy();
    await act(async () => limitsTab!.click());
    await flush();
    expect(container.textContent).toMatch(/52%/);
    expect(container.textContent).toMatch(/codex|Codex/);

    // Settings section carries the attribution.
    await render(settings!.component as ComponentType);
    expect(container.textContent).toMatch(/TokenTracker/);
    expect(container.textContent).toMatch(/xiufengsun/);

    expect(errors).toEqual([]);

    deactivate?.();
    disposers.forEach((dispose) => dispose());
    expect(statusBarRegistry.get("plugin:usage-limits:chip")).toBeUndefined();
    expect(centerTabRegistry.get("plugin:usage-limits:usage")).toBeUndefined();
  });
});

import { describe, expect, it, vi } from "vitest";
import type { Disposer } from "@ccgui/plugin-sdk";
import {
  createUsageCaps,
  normalizeLimitsOptions,
  normalizeUsageQuery,
  type UsageBackend,
} from "./usage-bridge";

function gate(granted: string[]) {
  return (capability: string) => {
    if (!granted.includes(capability)) throw new Error(`used ${capability} without declaring it`);
  };
}

function fakeBackend(): Required<UsageBackend> & { listeners: Map<string, (p: unknown) => void> } {
  const listeners = new Map<string, (p: unknown) => void>();
  return {
    listeners,
    usageQuery: vi.fn(async () => ({ rows: [], firstDay: null, scannedAt: null, scanning: false, unknownModels: [] })),
    usageSources: vi.fn(async () => []),
    usageRefresh: vi.fn(async () => ({ filesScanned: 1, eventsAdded: 0, durationMs: 1, scannedAt: 1 })),
    usageRescan: vi.fn(async () => ({ filesScanned: 1, eventsAdded: 2, durationMs: 1, scannedAt: 2 })),
    usagePrices: vi.fn(async () => ({ source: "bundled" as const, snapshotDate: "2026-10-20", updatedAt: null, models: 3 })),
    usageUpdatePrices: vi.fn(async () => ({ source: "online" as const, snapshotDate: "2026-10-20", updatedAt: 5, models: 4 })),
    usageSubscribe: vi.fn((topic: string, cb: (p: unknown) => void): Disposer => {
      listeners.set(topic, cb);
      return () => listeners.delete(topic);
    }),
    limitsGet: vi.fn(async () => ({ providers: [] })),
  };
}

describe("normalizeUsageQuery", () => {
  it("defaults the bucket and fills the local timezone of the end day", () => {
    const q = normalizeUsageQuery({ from: "2026-10-01", to: "2026-10-27" });
    expect(q.bucket).toBe("day");
    expect(q.tzOffsetMinutes).toBe(-new Date(2026, 9, 27, 12).getTimezoneOffset());
    expect(normalizeUsageQuery({ from: "2026-10-27", to: "2026-10-27", bucket: "hour" }).bucket).toBe("hour");
  });

  it("rejects malformed, impossible, inverted and oversized ranges", () => {
    expect(() => normalizeUsageQuery(null)).toThrow(/object/);
    expect(() => normalizeUsageQuery({ from: "2026-1-01", to: "2026-10-01" })).toThrow(/YYYY-MM-DD/);
    expect(() => normalizeUsageQuery({ from: "2026-02-30", to: "2026-03-01" })).toThrow(/calendar/);
    expect(() => normalizeUsageQuery({ from: "2026-10-02", to: "2026-10-01" })).toThrow(/after/);
    expect(() => normalizeUsageQuery({ from: "2000-01-01", to: "2026-10-01" })).toThrow(/exceed/);
    expect(() => normalizeUsageQuery({ from: "2026-10-01", to: "2026-10-01", bucket: "week" })).toThrow(/bucket/);
  });
});

describe("normalizeLimitsOptions", () => {
  it("defaults to every provider without refresh and dedupes ids", () => {
    expect(normalizeLimitsOptions(undefined)).toEqual({ providers: null, refresh: false });
    expect(normalizeLimitsOptions({ providers: ["codex", "codex"], refresh: true })).toEqual({
      providers: ["codex"],
      refresh: true,
    });
  });

  it("rejects unknown providers and non-boolean refresh", () => {
    expect(() => normalizeLimitsOptions({ providers: ["cursor"] })).toThrow(/subset/);
    expect(() => normalizeLimitsOptions({ refresh: "yes" })).toThrow(/boolean/);
    expect(() => normalizeLimitsOptions([])).toThrow(/object/);
  });
});

describe("createUsageCaps", () => {
  it("refuses every usage call without usage.read and never reaches the backend", async () => {
    const backend = fakeBackend();
    const caps = createUsageCaps("p", backend, gate(["limits.read"]), (d) => d);
    await expect(caps.usage.query({ from: "2026-10-01", to: "2026-10-02" })).rejects.toThrow(/usage\.read/);
    await expect(caps.usage.sources()).rejects.toThrow(/usage\.read/);
    await expect(caps.usage.rescan()).rejects.toThrow(/usage\.read/);
    expect(() => caps.usage.onChange(() => {})).toThrow(/usage\.read/);
    expect(backend.usageQuery).not.toHaveBeenCalled();
    expect(backend.usageRescan).not.toHaveBeenCalled();
    expect(backend.usageSubscribe).not.toHaveBeenCalled();
  });

  it("refuses limits without limits.read", async () => {
    const backend = fakeBackend();
    const caps = createUsageCaps("p", backend, gate(["usage.read"]), (d) => d);
    await expect(caps.limits.get()).rejects.toThrow(/limits\.read/);
    expect(backend.limitsGet).not.toHaveBeenCalled();
  });

  it("passes the plugin id and normalized arguments through", async () => {
    const backend = fakeBackend();
    const caps = createUsageCaps("p", backend, gate(["usage.read", "limits.read"]), (d) => d);
    await caps.usage.query({ from: "2026-10-01", to: "2026-10-02", bucket: "hour" });
    expect(backend.usageQuery).toHaveBeenCalledWith("p", expect.objectContaining({ from: "2026-10-01", to: "2026-10-02", bucket: "hour" }));
    await caps.usage.refresh();
    await caps.usage.updatePrices();
    expect(backend.usageRefresh).toHaveBeenCalledWith("p");
    expect(backend.usageUpdatePrices).toHaveBeenCalledWith("p");
    await caps.limits.get({ providers: ["claude"], refresh: true });
    expect(backend.limitsGet).toHaveBeenCalledWith("p", { providers: ["claude"], refresh: true });
  });

  it("tracks subscriptions so plugin unload disposes them", () => {
    const backend = fakeBackend();
    const tracked: Disposer[] = [];
    const caps = createUsageCaps("p", backend, gate(["usage.read"]), (d) => {
      tracked.push(d);
      return d;
    });
    const seen: unknown[] = [];
    caps.usage.onChange((e) => seen.push(e));
    caps.usage.onScanProgress((e) => seen.push(e));
    backend.listeners.get("changed")?.({ scannedAt: 7 });
    backend.listeners.get("progress")?.({ done: 1, total: 2, engine: "claude", finished: false });
    expect(seen).toEqual([{ scannedAt: 7 }, { done: 1, total: 2, engine: "claude", finished: false }]);
    expect(tracked).toHaveLength(2);
    tracked.forEach((d) => d());
    expect(backend.listeners.size).toBe(0);
  });

  it("reports a clear error on hosts without the capability", async () => {
    const caps = createUsageCaps("p", {}, gate(["usage.read", "limits.read"]), (d) => d);
    await expect(caps.usage.prices()).rejects.toThrow(/unavailable/);
    await expect(caps.limits.get()).rejects.toThrow(/unavailable/);
    expect(() => caps.usage.onChange(() => {})).toThrow(/unavailable/);
  });
});

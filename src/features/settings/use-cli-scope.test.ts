import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  wslDistros: vi.fn(),
  wslCliCapabilities: vi.fn(),
}));

vi.mock("@/lib/ipc", () => ({ ipc: mocks }));
vi.mock("@/lib/platform", () => ({ IS_WINDOWS: true, isWeb: false }));
vi.mock("@/lib/errors", () => ({
  errorText: (error: unknown) => `E:${String(error)}`,
}));

const SCOPE_KEY = "ccgui-next.cliScope:v1";
const DISTRO_KEY = "ccgui-next.wslCliDistro:v1";

type ScopeModule = typeof import("./use-cli-scope");
let store: ScopeModule["cliScopeStore"];

// The store is module-level: reset the module registry between tests so each
// one starts from a cold snapshot, then re-import it.
beforeEach(async () => {
  localStorage.clear();
  vi.resetModules();
  mocks.wslDistros.mockReset();
  mocks.wslCliCapabilities.mockReset();
  store = (await import("./use-cli-scope")).cliScopeStore;
});

function resolved(distros: string[], engines: string[]) {
  mocks.wslDistros.mockResolvedValue(distros);
  mocks.wslCliCapabilities.mockResolvedValue({ engines });
}

describe("cliScopeStore", () => {
  it("defaults to host and remembers the scope globally", async () => {
    resolved(["Ubuntu-24.04", "Debian"], ["claude", "pi"]);
    await store.ensureMeta();

    expect(store.getSnapshot()).toMatchObject({
      ready: true,
      requested: "host",
      distros: ["Ubuntu-24.04", "Debian"],
      engines: ["claude", "pi"],
    });

    store.setScope("wsl");
    expect(store.getSnapshot()).toMatchObject({
      requested: "wsl",
      distro: "Ubuntu-24.04",
    });
    expect(localStorage.getItem(SCOPE_KEY)).toBe("wsl");
    expect(localStorage.getItem(DISTRO_KEY)).toBe("Ubuntu-24.04");
  });

  it("falls back to the first distro when the remembered one is gone", async () => {
    localStorage.setItem(DISTRO_KEY, "Removed-Distro");
    resolved(["Ubuntu-24.04"], ["claude"]);
    await store.ensureMeta();

    expect(store.getSnapshot().distro).toBe("Ubuntu-24.04");
    expect(localStorage.getItem(DISTRO_KEY)).toBe("Ubuntu-24.04");
  });

  it("falls back to host and clears both keys when no distro exists", async () => {
    localStorage.setItem(SCOPE_KEY, "wsl");
    localStorage.setItem(DISTRO_KEY, "Ubuntu-24.04");
    resolved([], ["claude"]);
    await store.ensureMeta();

    expect(store.getSnapshot()).toMatchObject({ requested: "host", distro: null });
    expect(localStorage.getItem(SCOPE_KEY)).toBeNull();
    expect(localStorage.getItem(DISTRO_KEY)).toBeNull();
  });

  it("keeps the requested scope and reports the error when metadata fails", async () => {
    localStorage.setItem(SCOPE_KEY, "wsl");
    mocks.wslDistros.mockRejectedValue("boom");
    mocks.wslCliCapabilities.mockResolvedValue({ engines: ["claude"] });
    await store.ensureMeta();

    expect(store.getSnapshot()).toMatchObject({
      ready: true,
      requested: "wsl",
      metaError: "E:boom",
      distros: [],
    });
  });

  it("retries a failed metadata read and clears the error", async () => {
    mocks.wslDistros.mockRejectedValueOnce("boom");
    mocks.wslCliCapabilities.mockResolvedValue({ engines: ["claude"] });
    await store.ensureMeta();
    expect(store.getSnapshot().metaError).toBe("E:boom");

    // 失败不缓存：不带 force 的读取也应立刻重试。
    resolved(["Ubuntu-24.04"], ["claude"]);
    await store.ensureMeta();
    expect(store.getSnapshot()).toMatchObject({
      metaError: null,
      distros: ["Ubuntu-24.04"],
    });
  });

  it("ignores a WSL scope switch when there is no distro", async () => {
    resolved([], ["claude"]);
    await store.ensureMeta();

    store.setScope("wsl");
    expect(store.getSnapshot().requested).toBe("host");
    expect(localStorage.getItem(SCOPE_KEY)).toBeNull();
  });

  it("switches to another distro and persists it", async () => {
    resolved(["Ubuntu-24.04", "Debian"], ["claude"]);
    await store.ensureMeta();

    store.setDistro("Debian");
    expect(store.getSnapshot().distro).toBe("Debian");
    expect(localStorage.getItem(DISTRO_KEY)).toBe("Debian");
  });

  it("rejects a distro that is not in the list", async () => {
    resolved(["Ubuntu-24.04"], ["claude"]);
    await store.ensureMeta();

    store.setDistro("Debian");
    expect(store.getSnapshot().distro).toBe("Ubuntu-24.04");
  });

  it("single-flights concurrent metadata loads", async () => {
    let release: (value: string[]) => void = () => {};
    mocks.wslDistros.mockReturnValue(
      new Promise<string[]>((resolve) => {
        release = resolve;
      }),
    );
    mocks.wslCliCapabilities.mockResolvedValue({ engines: ["claude"] });

    const first = store.ensureMeta();
    const second = store.ensureMeta();
    expect(mocks.wslDistros).toHaveBeenCalledTimes(1);

    release(["Ubuntu-24.04"]);
    await Promise.all([first, second]);
    expect(store.getSnapshot().distros).toEqual(["Ubuntu-24.04"]);
  });

  it("starts the metadata load on the first subscriber", () => {
    resolved(["Ubuntu-24.04"], ["claude"]);
    const unsubscribe = store.subscribe(() => {});
    expect(mocks.wslDistros).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it("keeps the snapshot reference stable until something changes", async () => {
    resolved(["Ubuntu-24.04"], ["claude"]);
    await store.ensureMeta();
    const before = store.getSnapshot();

    // Repeated reads must be referentially equal or useSyncExternalStore loops.
    expect(store.getSnapshot()).toBe(before);

    store.setScope("wsl");
    expect(store.getSnapshot()).not.toBe(before);
    expect(store.getSnapshot()).toMatchObject({
      requested: "wsl",
      distro: "Ubuntu-24.04",
    });
  });
});

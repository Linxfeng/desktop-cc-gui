import { beforeEach, describe, expect, it, vi } from "vitest";

/** The transport is the only backend edge this module has. */
const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("./transport", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
  listen: vi.fn(async () => () => {}),
  isWeb: false,
  webToken: null,
  serverVersion: async () => null,
}));

/** Only the fields under test; the rest of the shape is irrelevant here. */
const settings = (over: Record<string, unknown>) =>
  ({ theme: "system", ...over }) as never;

/** Fresh module per case: the cache is module state. */
let ipc: (typeof import("./ipc"))["ipc"];
beforeEach(async () => {
  invoke.mockReset();
  vi.resetModules();
  ({ ipc } = await import("./ipc"));
});

describe("app settings cache", () => {
  it("serves repeat reads from a single backend call", async () => {
    invoke.mockResolvedValue(settings({ theme: "dark" }));
    await ipc.getAppSettings();
    await ipc.getAppSettings();
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("re-reads settings the backend rotated on its own", async () => {
    invoke.mockResolvedValueOnce(settings({ webAuthKey: "AAAA2222" }));
    await ipc.getAppSettings();
    invoke.mockResolvedValueOnce(settings({ webAuthKey: "BBBB3333" }));
    await expect(ipc.refreshAppSettings()).resolves.toMatchObject({
      webAuthKey: "BBBB3333",
    });
    // The fresh copy is what later reads — and later writes — see.
    await expect(ipc.getAppSettings()).resolves.toMatchObject({
      webAuthKey: "BBBB3333",
    });
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it("re-reads after a write instead of trusting what was sent", async () => {
    invoke.mockResolvedValueOnce(settings({ webAuthKey: "OLDKEY22" }));
    const before = await ipc.getAppSettings();
    // A write answers with nothing (the command's contract); the next read
    // must hit the backend, never carry the written object.
    invoke.mockResolvedValueOnce(undefined);
    await ipc.updateAppSettings({ ...before, webAuthKey: null } as never);
    invoke.mockResolvedValueOnce(settings({ webAuthKey: "NEWKEY33" }));
    await expect(ipc.getAppSettings()).resolves.toMatchObject({
      webAuthKey: "NEWKEY33",
    });
    expect(invoke.mock.calls.map((call) => call[0])).toEqual([
      "get_app_settings",
      "update_app_settings",
      "get_app_settings",
    ]);
  });
});

describe("git tree batch", () => {
  it("sends all directory levels through one command and preserves the response", async () => {
    const levels = [{ path: "C:/workspace", files: ["src"], directories: ["src"] }];
    const result = { repositories: [], fileColors: { "C:/workspace": { src: "modified" } } };
    invoke.mockResolvedValue(result);
    await expect(ipc.gitTreeStatus(levels)).resolves.toBe(result);
    expect(invoke).toHaveBeenCalledExactlyOnceWith("git_tree_status", { levels });
  });
});

describe("ordered persistence commands", () => {
  async function expectCommittedInCallOrder(
    operations: { invoke: () => Promise<unknown>; command: string }[],
  ) {
    const releaseFirst = Promise.withResolvers<void>();
    const committed: string[] = [];
    invoke.mockImplementation(async (command: string) => {
      if (command === operations[0].command) await releaseFirst.promise;
      committed.push(command);
    });

    const pending = operations.map((operation) => operation.invoke());
    try {
      // The first command is in flight. A later write must not enter native
      // dispatch and commit while that older command is still blocked.
      await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));
      await Promise.resolve();
      expect(invoke).toHaveBeenCalledTimes(1);
      releaseFirst.resolve();
      await Promise.all(pending);
      expect(committed).toEqual(operations.map((operation) => operation.command));
    } finally {
      releaseFirst.resolve();
    }
  }

  it("keeps same-key plugin writes behind an older in-flight write", async () => {
    await expectCommittedInCallOrder([
      { invoke: () => ipc.pluginStorageSet("plugin", "key", "old"), command: "plugin_storage_set" },
      { invoke: () => ipc.pluginStorageDelete("plugin", "key"), command: "plugin_storage_delete" },
      { invoke: () => ipc.pluginStorageSet("plugin", "key", "new"), command: "plugin_storage_set" },
    ]);
  });

  it("persists consecutive effort choices in selection order", async () => {
    await expectCommittedInCallOrder([
      { invoke: () => ipc.rememberSessionEffort("omp", "s1", "low"), command: "remember_session_effort" },
      { invoke: () => ipc.rememberSessionEffort("omp", "s1", "high"), command: "remember_session_effort" },
    ]);
  });

  it("isolates independent keys and recovers after a rejected write", async () => {
    const releaseKeyA = Promise.withResolvers<void>();
    invoke.mockImplementation(async (command: string, args?: { key?: string; value?: unknown }) => {
      if (command === "plugin_storage_set" && args?.key === "a" && args?.value === "first") {
        await releaseKeyA.promise;
        throw new Error("disk busy");
      }
    });

    const firstA = ipc.pluginStorageSet("plugin", "a", "first");
    const secondA = ipc.pluginStorageSet("plugin", "a", "second");
    await expect(ipc.pluginStorageSet("plugin", "b", "parallel")).resolves.toBeUndefined();
    expect(invoke).toHaveBeenCalledTimes(2);

    releaseKeyA.resolve();
    await expect(firstA).rejects.toThrow("disk busy");
    await expect(secondA).resolves.toBeUndefined();
    expect(invoke).toHaveBeenCalledTimes(3);
  });
});

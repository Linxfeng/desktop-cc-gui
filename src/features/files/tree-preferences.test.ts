import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getAppSettings: vi.fn(),
  updateAppSettings: vi.fn(),
}));
vi.mock("@/lib/ipc", () => ({ ipc: mocks }));

import { hydrateFileTreePreferences, useFileTreePreferencesStore } from "./tree-preferences";

describe("file tree preferences", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    useFileTreePreferencesStore.setState({ hideIgnored: false });
  });

  it("defaults to listing ignored entries when settings carry no value", async () => {
    mocks.getAppSettings.mockResolvedValue({ theme: "system" });
    await hydrateFileTreePreferences();
    expect(useFileTreePreferencesStore.getState().hideIgnored).toBe(false);
  });

  it("hydrates the persisted switch", async () => {
    mocks.getAppSettings.mockResolvedValue({ fileTreeHideIgnored: true });
    await hydrateFileTreePreferences();
    expect(useFileTreePreferencesStore.getState().hideIgnored).toBe(true);
  });

  it("keeps the default when the settings read fails", async () => {
    mocks.getAppSettings.mockRejectedValue(new Error("unreadable"));
    await hydrateFileTreePreferences();
    expect(useFileTreePreferencesStore.getState().hideIgnored).toBe(false);
  });

  it("applies at once and persists onto a fresh settings read", async () => {
    mocks.getAppSettings.mockResolvedValue({ theme: "dark", fileTreeHideIgnored: false });
    let finish!: () => void;
    mocks.updateAppSettings.mockReturnValue(new Promise<void>((resolve) => { finish = resolve; }));

    const pending = useFileTreePreferencesStore.getState().setHideIgnored(true);
    expect(useFileTreePreferencesStore.getState().hideIgnored).toBe(true);
    await vi.waitFor(() => expect(mocks.updateAppSettings).toHaveBeenCalled());
    finish();
    await pending;

    expect(mocks.updateAppSettings).toHaveBeenCalledWith({
      theme: "dark",
      fileTreeHideIgnored: true,
    });
    expect(useFileTreePreferencesStore.getState().hideIgnored).toBe(true);
  });

  it("a settings read racing an in-flight write keeps the chosen value", async () => {
    mocks.getAppSettings.mockResolvedValue({ fileTreeHideIgnored: false });
    let finish!: () => void;
    mocks.updateAppSettings.mockReturnValue(new Promise<void>((resolve) => { finish = resolve; }));
    const write = useFileTreePreferencesStore.getState().setHideIgnored(true);
    await vi.waitFor(() => expect(mocks.updateAppSettings).toHaveBeenCalled());

    await hydrateFileTreePreferences();
    expect(useFileTreePreferencesStore.getState().hideIgnored).toBe(true);
    finish();
    await write;
    expect(useFileTreePreferencesStore.getState().hideIgnored).toBe(true);
  });

  it("a failed write that a newer one superseded does not roll the switch back", async () => {
    mocks.getAppSettings.mockResolvedValue({});
    let failFirst!: (error: Error) => void;
    mocks.updateAppSettings
      .mockReturnValueOnce(new Promise<void>((_, reject) => { failFirst = reject; }))
      .mockResolvedValue(undefined);
    const store = useFileTreePreferencesStore.getState();
    const first = store.setHideIgnored(true);
    await vi.waitFor(() => expect(mocks.updateAppSettings).toHaveBeenCalledTimes(1));
    await store.setHideIgnored(false);
    await store.setHideIgnored(true);

    failFirst(new Error("disk full"));
    await expect(first).rejects.toThrow("disk full");
    expect(useFileTreePreferencesStore.getState().hideIgnored).toBe(true);
  });

  it("rolls the switch back when the write fails", async () => {
    mocks.getAppSettings.mockResolvedValue({});
    mocks.updateAppSettings.mockRejectedValue(new Error("disk full"));
    await expect(
      useFileTreePreferencesStore.getState().setHideIgnored(true),
    ).rejects.toThrow("disk full");
    expect(useFileTreePreferencesStore.getState().hideIgnored).toBe(false);
  });
});

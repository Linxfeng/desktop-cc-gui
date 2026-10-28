import { create } from "zustand";
import { ipc } from "@/lib/ipc";

/**
 * File tree display preferences, persisted in AppSettings. A store rather
 * than a one-off settings read: the tree has to re-filter the moment the
 * switch in 设置 → 通用 → 行为 flips.
 */
interface FileTreePreferencesState {
  /** Hide entries Git ignores; false (default) = list them, drawn faded. */
  hideIgnored: boolean;
  hydrate: (hideIgnored: boolean | null | undefined) => void;
  setHideIgnored: (hide: boolean) => Promise<void>;
}

/** Bumped by every write: only the newest write may roll the switch back,
 *  and a settings read that began before it must not overwrite it. */
let writeGeneration = 0;
/** Writes in flight: until they land, the cached settings a read returns
 *  may predate them. */
let pendingWrites = 0;

export const useFileTreePreferencesStore = create<FileTreePreferencesState>((set, get) => ({
  hideIgnored: false,
  hydrate: (hideIgnored) => set({ hideIgnored: hideIgnored === true }),
  setHideIgnored: async (hide) => {
    const previous = get().hideIgnored;
    writeGeneration += 1;
    const generation = writeGeneration;
    pendingWrites += 1;
    // Apply first so the tree re-filters at once; a failed write rolls the
    // switch back instead of faking a saved state.
    set({ hideIgnored: hide });
    try {
      const settings = await ipc.getAppSettings();
      await ipc.updateAppSettings({ ...settings, fileTreeHideIgnored: hide });
    } catch (error) {
      if (generation === writeGeneration) set({ hideIgnored: previous });
      throw error;
    } finally {
      pendingWrites -= 1;
    }
  },
}));

/** Load the persisted switch. At startup this shares the cached settings
 *  promise (ipc.ts), so it adds no IPC round-trip. */
export async function hydrateFileTreePreferences(): Promise<void> {
  const generation = writeGeneration;
  try {
    const settings = await ipc.getAppSettings();
    if (generation !== writeGeneration || pendingWrites > 0) return;
    useFileTreePreferencesStore.getState().hydrate(settings.fileTreeHideIgnored);
  } catch {
    // Default: ignored entries stay listed (faded); nothing is hidden.
  }
}

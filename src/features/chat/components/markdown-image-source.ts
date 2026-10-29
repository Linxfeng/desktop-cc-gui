import { ipc, type DirEntry } from "@/lib/ipc";
import { resolveFilePath } from "@/lib/fileLinks";
import { readRemoteAware } from "@/features/files/remote-files";
import { fileName, parentPath } from "@/features/files/store";
import { resolveChatFileLink } from "@/features/chat/file-link-resolution";

/** Raster data URLs a reply may inline. SVG is left out on purpose. */
export const SAFE_DATA_IMAGE_URL = /^data:image\/(?:apng|avif|bmp|gif|jpeg|png|webp|x-icon);base64,/i;

/** A `..` segment in either separator style. */
const DOT_DOT_SEGMENT = /(^|[\\/])\.\.([\\/]|$)/;

/** Remote and inline images render as-is; everything else is a file path. */
export function isDirectImageSource(src: string): boolean {
  return /^https?:/i.test(src) || SAFE_DATA_IMAGE_URL.test(src);
}

/**
 * Compare key for the workspace gate. Case folds only for drive-letter and
 * UNC paths, and only ASCII: Linux and case-sensitive APFS treat `/home/u/WS`
 * as another folder, and `toLowerCase` would also fold U+212A KELVIN SIGN into
 * `k`. A wrong refusal costs the alt text; a wrong pass opens the grant dialog.
 */
function gateKey(path: string): string {
  const slashed = path.replace(/\\/g, "/").replace(/\/+$/, "");
  return /^[A-Za-z]:(\/|$)/.test(slashed) || slashed.startsWith("//")
    ? slashed.replace(/[A-Z]/g, (c) => c.toLowerCase())
    : slashed;
}

/**
 * True only for a file strictly below the workspace root, so that every folder
 * the loader lists (the file's parent) is inside the root too. Rendering a
 * reply is not a user action: a path the backend resolves outside every root
 * (`assets/../../x.png`, the root itself whose parent gets listed, another
 * case on Linux) would answer with the error that makes `withGrantRetry` open
 * the grant dialog, so such paths are refused before any file IPC.
 */
function staysInWorkspace(path: string, workspacePath: string): boolean {
  if (DOT_DOT_SEGMENT.test(path) || !fileName(path)) return false;
  const root = gateKey(workspacePath.trim());
  const parent = gateKey(parentPath(path));
  return root.length > 0 && (parent === root || parent.startsWith(`${root}/`));
}

export interface LoadedImage {
  path: string;
  /** `size:mtimeMs` from the parent listing; null when it could not be read. */
  version: string | null;
  dataUrl: string;
}

export interface ImageCache {
  peek(key: string): LoadedImage | undefined;
  remember(key: string, image: LoadedImage): void;
  forget(key: string): void;
  clear(): void;
}

/**
 * LRU of decoded images, bounded by entry count and total data-URL length.
 * A virtualized timeline remounts rows on every scroll back; without this each
 * remount re-reads up to 5 MB and shows the alt text until the read returns.
 */
export function createImageCache(limits: { maxEntries: number; maxChars: number }): ImageCache {
  const entries = new Map<string, LoadedImage>();
  let chars = 0;
  const forget = (key: string) => {
    const old = entries.get(key);
    if (!old) return;
    entries.delete(key);
    chars -= old.dataUrl.length;
  };
  return {
    peek: (key) => entries.get(key),
    remember(key, image) {
      forget(key);
      if (image.dataUrl.length > limits.maxChars) return;
      entries.set(key, image);
      chars += image.dataUrl.length;
      for (const oldest of entries.keys()) {
        if (entries.size <= limits.maxEntries && chars <= limits.maxChars) break;
        forget(oldest);
      }
    },
    forget,
    clear() {
      entries.clear();
      chars = 0;
    },
  };
}

export const markdownImageCache = createImageCache({ maxEntries: 48, maxChars: 32_000_000 });

/** How long a miss skips the workspace index scan (`list_file_index` with
 *  ignored files) on remount. The expected folder is still listed every time,
 *  so a file that appears at the written path shows up at once. */
const MISS_INDEX_SKIP_MS = 15_000;
const MAX_MISSES = 256;
const misses = new Map<string, number>();
const inflight = new Map<string, Promise<LoadedImage | null>>();
const listings = new Map<string, Promise<DirEntry[]>>();

function recentlyMissed(key: string, now: number): boolean {
  const until = misses.get(key);
  if (until === undefined) return false;
  if (until > now) return true;
  misses.delete(key);
  return false;
}

function rememberMiss(key: string, now: number) {
  misses.delete(key);
  misses.set(key, now + MISS_INDEX_SKIP_MS);
  if (misses.size > MAX_MISSES) {
    const oldest = misses.keys().next();
    if (!oldest.done) misses.delete(oldest.value);
  }
}

/** Test hook: forget every cached image, miss and in-flight load. */
export function resetMarkdownImageCaches() {
  markdownImageCache.clear();
  misses.clear();
  inflight.clear();
  listings.clear();
}

export function imageCacheKey(src: string, workspacePath: string): string {
  return `${workspacePath}\n${src}`;
}

/** One `list_dir` per folder at a time: a reply with many renders from one
 *  folder mounts them in the same commit. */
function listShared(dir: string): Promise<DirEntry[]> {
  const running = listings.get(dir);
  if (running) return running;
  const listing = ipc.listDir(dir).finally(() => listings.delete(dir));
  listings.set(dir, listing);
  return listing;
}

type FileState = { state: "found"; version: string } | { state: "absent" } | { state: "unknown" };

/** Look the file up in its parent listing. `list_dir` reports lstat data, so
 *  a symlink's version follows the link, not its target. */
async function statInParent(path: string): Promise<FileState> {
  const name = fileName(path);
  let entries: DirEntry[];
  try {
    entries = await listShared(parentPath(path));
  } catch {
    return { state: "unknown" };
  }
  const entry =
    entries.find((item) => item.name === name) ??
    entries.find((item) => item.name.toLowerCase() === name.toLowerCase());
  return entry ? { state: "found", version: `${entry.size}:${entry.mtimeMs}` } : { state: "absent" };
}

/**
 * Read a workspace image named in a reply. Null means "show the alt text":
 * outside the workspace, missing, not an image, or the read failed. A cached
 * copy is reused only when the file's size and mtime are unchanged, so an
 * image the agent regenerated under the same name is read again.
 */
export async function loadWorkspaceImage(
  src: string,
  workspacePath: string,
  cached: LoadedImage | undefined,
  options: { skipIndex?: boolean } = {},
): Promise<LoadedImage | null> {
  const candidate = resolveFilePath(src, workspacePath);
  if (!candidate || !staysInWorkspace(candidate, workspacePath)) return null;
  let path = candidate;
  let file = await statInParent(candidate);
  if (file.state === "absent" && options.skipIndex) return null;
  if (file.state !== "found") {
    // Not where the reply says: the nested-project index fallback may know it.
    const resolved = await resolveChatFileLink(src, workspacePath);
    if (!resolved || !staysInWorkspace(resolved, workspacePath)) return null;
    if (resolved !== candidate) {
      path = resolved;
      file = await statInParent(resolved);
    }
  }
  const version = file.state === "found" ? file.version : null;
  if (cached && version !== null && cached.path === path && cached.version === version) {
    return cached;
  }
  const content = await readRemoteAware(path, (localPath) => ipc.readFile(localPath));
  return content.kind === "image" && content.dataUrl ? { path, version, dataUrl: content.dataUrl } : null;
}

/**
 * Load through the caches; never rejects. The result is stored even when the
 * row that asked unmounted meanwhile (a fast scroll must not throw away a
 * finished read), and rows showing the same image share one load.
 */
export function loadMarkdownImage(src: string, workspacePath: string): Promise<LoadedImage | null> {
  const key = imageCacheKey(src, workspacePath);
  const running = inflight.get(key);
  if (running) return running;
  const skipIndex = recentlyMissed(key, Date.now());
  const settle = (image: LoadedImage | null) => {
    if (image) {
      markdownImageCache.remember(key, image);
      misses.delete(key);
    } else {
      markdownImageCache.forget(key);
      // Only a full lookup starts the window; a skipped one must not extend it.
      if (!skipIndex) rememberMiss(key, Date.now());
    }
    return image;
  };
  const load = loadWorkspaceImage(src, workspacePath, markdownImageCache.peek(key), { skipIndex })
    .then(settle, () => settle(null))
    .finally(() => inflight.delete(key));
  inflight.set(key, load);
  return load;
}

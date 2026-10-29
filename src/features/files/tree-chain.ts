import type { DirEntry, RepositorySummary } from "@/lib/ipc";

/** The tree state a single-child chain is decided from. */
export interface ChainState {
  children: Record<string, DirEntry[]>;
  loadingDirs: Record<string, true>;
  dirErrors: Record<string, string>;
  repositories: Record<string, RepositorySummary>;
  hideIgnored: boolean;
}

/**
 * The folder a merged single-chain row continues into below `path`, or null
 * where the chain ends: `path` is a repository, still loading, failed or not
 * loaded, or does not hold exactly one visible entry that is a folder. A
 * change of Git-ignore state also ends it, so a row is never half dimmed.
 * Row building and the click handler share this, so what a row shows and
 * what one click opens never disagree.
 */
export function nextChainDir(path: string, ignored: boolean, state: ChainState): DirEntry | null {
  if (state.repositories[path] || state.loadingDirs[path] || state.dirErrors[path]) return null;
  const visible = state.children[path]?.filter((entry) => !state.hideIgnored || !entry.ignored);
  if (visible?.length !== 1) return null;
  const [only] = visible;
  return only.isDir && !!only.ignored === ignored ? only : null;
}

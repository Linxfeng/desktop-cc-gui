import { useCallback, useEffect, useSyncExternalStore } from "react";
import { githubAvatarUrl } from "@/lib/github-avatar";
import { ipc } from "@/lib/ipc";

/**
 * GitHub owner logins for sidebar workspace rows, resolved from each
 * workspace's `origin` remote by `git_workspace_owners`.
 *
 * The cache is module-level so remounting the sidebar (collapse, route change)
 * does not re-read every repo, and a status is remembered per path even when
 * it is "no GitHub owner" — a local-only or GitLab repo must not be re-queried
 * on every render. Rows mounting together share one IPC round trip: effects
 * enqueue their path and a 0ms flush collects the whole commit.
 */

/** path → owner login; null = resolved, nothing GitHub-shaped to show. */
const owners = new Map<string, string | null>();
const listeners = new Map<string, Set<() => void>>();
/** Paths currently in one in-flight IPC call (dedup across mounts). */
const pending = new Set<string>();
let queue: string[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;

function notify(path: string) {
  const set = listeners.get(path);
  if (!set) return;
  for (const listener of set) listener();
}

function subscribe(path: string | undefined, onChange: () => void): () => void {
  if (!path) return () => {};
  let set = listeners.get(path);
  if (!set) {
    set = new Set();
    listeners.set(path, set);
  }
  set.add(onChange);
  return () => {
    set.delete(onChange);
    if (set.size === 0) listeners.delete(path);
  };
}

async function flushOwners() {
  flushTimer = null;
  const batch = queue;
  queue = [];
  if (batch.length === 0) return;
  for (const path of batch) pending.add(path);
  try {
    const rows = await ipc.gitWorkspaceOwners(batch);
    const byPath = new Map(rows.map((row) => [row.path, row.login]));
    for (const path of batch) {
      const login = byPath.get(path) ?? null;
      if (owners.get(path) === login) continue;
      owners.set(path, login);
      notify(path);
    }
  } catch {
    // Leave the paths unresolved instead of caching a transient IPC failure
    // as "this repo has no avatar": the next mount retries.
  } finally {
    for (const path of batch) pending.delete(path);
  }
}

/** Queue paths for the next batch; known paths (including known-empty) and
 *  in-flight ones are skipped. */
export function requestWorkspaceOwners(paths: Iterable<string>) {
  for (const path of paths) {
    if (!path || owners.has(path) || pending.has(path) || queue.includes(path)) continue;
    queue.push(path);
  }
  if (queue.length > 0 && flushTimer === null) {
    flushTimer = setTimeout(() => void flushOwners(), 0);
  }
}

/** Resolved GitHub owner login for one workspace path, or null when there is
 *  none / not resolved yet. */
export function useWorkspaceOwner(path: string | undefined): string | null {
  const subscribePath = useCallback(
    (onChange: () => void) => subscribe(path, onChange),
    [path],
  );
  const readOwner = useCallback(() => (path ? owners.get(path) ?? null : null), [path]);
  const owner = useSyncExternalStore(subscribePath, readOwner, readOwner);
  useEffect(() => {
    if (path) requestWorkspaceOwners([path]);
  }, [path]);
  return owner;
}

/** Avatar URL for a workspace row at the given CSS size; null keeps the
 *  caller's fallback glyph. */
export function useWorkspaceAvatarUrl(
  path: string | undefined,
  cssSize: number,
): string | null {
  const owner = useWorkspaceOwner(path);
  return owner ? githubAvatarUrl(owner, cssSize) : null;
}

/** Test hook: module-level cache must not leak between cases. */
export function resetWorkspaceAvatarsForTests() {
  if (flushTimer !== null) clearTimeout(flushTimer);
  flushTimer = null;
  owners.clear();
  listeners.clear();
  pending.clear();
  queue = [];
}

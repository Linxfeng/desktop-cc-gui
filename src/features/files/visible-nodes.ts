import type { DirEntry, FileTreeColor, RepositorySummary } from "@/lib/ipc";
import type { VisibleNode } from "./FileTreeRow";
import { fileName, joinPath } from "./store";

/** The store slices the visible row list is derived from. */
export interface TreeSnapshot {
  root: string;
  children: Record<string, DirEntry[]>;
  expanded: Record<string, true>;
  loadingDirs: Record<string, true>;
  repositories: Record<string, RepositorySummary>;
  fileColors: Record<string, Record<string, FileTreeColor>>;
  /** Drop entries Git ignores (and, with them, everything beneath). */
  hideIgnored: boolean;
}

/** Flatten the expanded tree into rows, depth-first in listing order. */
export function buildVisibleNodes({
  root,
  children,
  expanded,
  loadingDirs,
  repositories,
  fileColors,
  hideIgnored,
}: TreeSnapshot): VisibleNode[] {
  if (!root) return [];
  const out: VisibleNode[] = [];
  // Synthetic root row: the workspace root itself is the first tree row
  // with its repository badge (`open-reverselab main M1 ?12`); clicking
  // it expands the tree below it. Never hidden, whatever Git says.
  out.push({
    name: fileName(root),
    isDir: true,
    size: 0,
    mtimeMs: 0,
    path: root,
    depth: 0,
    expanded: !!expanded[root],
    loading: !!loadingDirs[root],
    repository: repositories[root],
    // Repo-root rows are blue (the workspace repo root row here; nested
    // repo dirs get theirs from the backend color pass).
    color: repositories[root] ? "repository" : undefined,
  });
  const walk = (dirPath: string, depth: number) => {
    const entries = children[dirPath];
    if (!entries) return;
    for (const e of entries) {
      if (hideIgnored && e.ignored) continue;
      const path = joinPath(dirPath, e.name);
      out.push({
        ...e,
        path,
        depth,
        expanded: e.isDir && !!expanded[path],
        loading: e.isDir && !!loadingDirs[path],
        repository: e.isDir ? repositories[path] : undefined,
        // Plain folders never carry color; files take their git state;
        // nested repo dirs take their own repo's status color from the
        // backend. Blue stays exclusive to the workspace root row.
        color: fileColors[dirPath]?.[e.name],
      });
      // Only already-expanded levels are walked — the tree never loads
      // recursively; each expansion triggers exactly one listDir call.
      if (e.isDir && expanded[path]) walk(path, depth + 1);
    }
  };
  if (expanded[root]) walk(root, 1);
  return out;
}

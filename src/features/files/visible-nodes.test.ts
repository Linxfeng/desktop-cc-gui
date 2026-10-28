import { describe, expect, it } from "vitest";
import type { DirEntry } from "@/lib/ipc";
import { buildVisibleNodes, type TreeSnapshot } from "./visible-nodes";

const entry = (name: string, extra: Partial<DirEntry> = {}): DirEntry => ({
  name,
  isDir: false,
  size: 0,
  mtimeMs: 0,
  ...extra,
});

/** `/ws` with `.git` + `build` ignored; `build` expanded. */
function snapshot(overrides: Partial<TreeSnapshot> = {}): TreeSnapshot {
  return {
    root: "/ws",
    children: {
      "/ws": [
        entry(".git", { isDir: true, ignored: true }),
        entry("build", { isDir: true, ignored: true }),
        entry("src", { isDir: true }),
        entry("debug.log", { ignored: true }),
        entry("README.md"),
      ],
      "/ws/build": [entry("app.bin", { ignored: true })],
    },
    expanded: { "/ws": true, "/ws/build": true },
    loadingDirs: {},
    repositories: {},
    fileColors: { "/ws": { "README.md": "modified" } },
    hideIgnored: false,
    ...overrides,
  };
}

const paths = (nodes: ReturnType<typeof buildVisibleNodes>) => nodes.map((n) => n.path);

describe("buildVisibleNodes", () => {
  it("lists ignored entries by default and keeps their flag for the faded row", () => {
    const nodes = buildVisibleNodes(snapshot());
    expect(paths(nodes)).toEqual([
      "/ws",
      "/ws/.git",
      "/ws/build",
      "/ws/build/app.bin",
      "/ws/src",
      "/ws/debug.log",
      "/ws/README.md",
    ]);
    const byPath = new Map(nodes.map((n) => [n.path, n]));
    expect(byPath.get("/ws/.git")?.ignored).toBe(true);
    expect(byPath.get("/ws/build/app.bin")?.ignored).toBe(true);
    expect(byPath.get("/ws/src")?.ignored).toBeUndefined();
    expect(byPath.get("/ws/README.md")?.color).toBe("modified");
  });

  it("drops ignored entries (and everything under them) when hiding", () => {
    const nodes = buildVisibleNodes(snapshot({ hideIgnored: true }));
    expect(paths(nodes)).toEqual(["/ws", "/ws/src", "/ws/README.md"]);
    expect(nodes[1].depth).toBe(1);
  });

  it("never hides the synthetic workspace root row", () => {
    const nodes = buildVisibleNodes(
      snapshot({
        hideIgnored: true,
        children: { "/ws": [entry("only.log", { ignored: true })] },
      }),
    );
    expect(paths(nodes)).toEqual(["/ws"]);
  });

  it("renders nothing without a root", () => {
    expect(buildVisibleNodes(snapshot({ root: "" }))).toEqual([]);
  });
});

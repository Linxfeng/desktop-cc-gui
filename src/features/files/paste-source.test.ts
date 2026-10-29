import { describe, expect, it } from "vitest";
import { choosePasteSource } from "./paste-source";

const tree = (osChangeCount?: number | null) => ({
  path: "/repo/b.md",
  isDir: false,
  ...(osChangeCount === undefined ? {} : { osChangeCount }),
});
const os = (paths: string[], changeCount: number | null) => ({ paths, changeCount });

describe("choosePasteSource", () => {
  it("keeps the tree item while the OS generation is the one its Copy recorded", () => {
    // Our own write, or the old list a failed write left behind.
    expect(choosePasteSource(os(["/repo/b.md"], 8), tree(8))).toBe("tree");
    expect(choosePasteSource(os(["/elsewhere/a.md"], 7), tree(7))).toBe("tree");
    expect(choosePasteSource(os([], 8), tree(8))).toBe("tree");
  });

  it("keeps the tree item when no generation can be compared", () => {
    expect(choosePasteSource(os([], null), tree(null))).toBe("tree");
    expect(choosePasteSource(os(["/elsewhere/a.md"], 7), tree())).toBe("tree");
    expect(choosePasteSource(os(["/elsewhere/a.md"], null), tree(7))).toBe("tree");
  });

  it("prefers a newer OS copy once the generation moved", () => {
    expect(choosePasteSource(os(["/elsewhere/c.md"], 9), tree(8))).toBe("system");
  });

  it("pastes nothing when the newer OS copy is only text", () => {
    expect(choosePasteSource(os([], 9), tree(8))).toBe("none");
  });

  it("uses the OS files when the tree has no item", () => {
    expect(choosePasteSource(os(["/elsewhere/c.md"], 9), null)).toBe("system");
    expect(choosePasteSource(os([], 9), null)).toBe("none");
  });
});

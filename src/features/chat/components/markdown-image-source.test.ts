import { describe, expect, it } from "vitest";
import { createImageCache, isDirectImageSource, type LoadedImage } from "./markdown-image-source";

function image(dataUrl: string): LoadedImage {
  return { path: `/ws/${dataUrl}.png`, version: "1:1", dataUrl };
}

describe("createImageCache", () => {
  it("evicts the least recently remembered entry past the entry limit", () => {
    const cache = createImageCache({ maxEntries: 2, maxChars: 1_000 });
    cache.remember("a", image("aa"));
    cache.remember("b", image("bb"));
    cache.remember("a", image("aa")); // touch: b is now the oldest
    cache.remember("c", image("cc"));

    expect(cache.peek("a")?.dataUrl).toBe("aa");
    expect(cache.peek("b")).toBeUndefined();
    expect(cache.peek("c")?.dataUrl).toBe("cc");
  });

  it("evicts until the total data-URL length fits", () => {
    const cache = createImageCache({ maxEntries: 10, maxChars: 10 });
    cache.remember("a", image("aaaa"));
    cache.remember("b", image("bbbb"));
    cache.remember("c", image("cccc"));

    expect(cache.peek("a")).toBeUndefined();
    expect(cache.peek("b")?.dataUrl).toBe("bbbb");
    expect(cache.peek("c")?.dataUrl).toBe("cccc");
  });

  it("never stores an image larger than the whole budget", () => {
    const cache = createImageCache({ maxEntries: 10, maxChars: 3 });
    cache.remember("small", image("ab"));
    cache.remember("huge", image("abcd"));

    expect(cache.peek("huge")).toBeUndefined();
    expect(cache.peek("small")?.dataUrl).toBe("ab");
  });

  it("frees the budget on forget and replace", () => {
    const cache = createImageCache({ maxEntries: 10, maxChars: 8 });
    cache.remember("a", image("aaaa"));
    cache.remember("a", image("AAAA"));
    cache.remember("b", image("bbbb"));
    expect(cache.peek("a")?.dataUrl).toBe("AAAA");

    cache.forget("a");
    cache.remember("c", image("cccc"));
    expect(cache.peek("b")?.dataUrl).toBe("bbbb");
    expect(cache.peek("c")?.dataUrl).toBe("cccc");
  });
});

describe("isDirectImageSource", () => {
  it.each([
    ["https://example.com/a.png", true],
    ["HTTP://example.com/a.png", true],
    ["data:image/png;base64,cG5n", true],
    ["data:image/svg+xml;base64,PHN2Zz4=", false],
    ["data:text/html;base64,PGI+", false],
    ["img/a.png", false],
    ["C:/ws/a.png", false],
  ])("%s -> %s", (src, expected) => {
    expect(isDirectImageSource(src)).toBe(expected);
  });
});

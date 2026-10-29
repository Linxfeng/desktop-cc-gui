import { act } from "react";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Markdown from "./Markdown";
import { markdownRegistry } from "@ccgui/plugin-sdk";
import type { Disposer } from "@ccgui/plugin-sdk";
import { resetMarkdownImageCaches } from "./markdown-image-source";
const imageIpc = vi.hoisted(() => ({
  listDir: vi.fn(),
  listFileIndex: vi.fn(),
  readFile: vi.fn(),
}));

vi.mock("@/lib/ipc", () => ({ ipc: imageIpc }));


// React's act() environment flag — a well-known global the runtime can't
// validate, so a named cast with no narrowing is the right boundary.
const actEnvironment = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;

/** Two-line fence so the host `pre` override renders the full CodeBlock card
 *  (single-line fences take the compact path). */
const FENCE = "```ts\nconst a = 1;\nconst b = 2;\n```";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  imageIpc.listDir.mockReset();
  imageIpc.listFileIndex.mockReset();
  imageIpc.readFile.mockReset();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

async function renderMarkdown(text: string) {
  await act(async () => {
    root.render(<Markdown text={text} workspacePath="/ws" />);
  });
}

describe("Markdown markdownRegistry merge (plan §4.2 #5)", () => {
  it("publishes parsed live text and preserves the full body when settling", async () => {
    vi.useFakeTimers();
    try {
      const text = "稳定文字 🙂 **bold** 与 `code`";
      await act(async () => root.render(<Markdown text={text} workspacePath="/ws" streaming />));
      await act(async () => vi.advanceTimersByTime(300));
      expect(container.textContent).toBe("稳定文字 🙂 bold 与 code");
      await act(async () => root.render(<Markdown text={`${text} 下一批 🙂`} workspacePath="/ws" streaming />));
      expect(container.textContent).toContain("稳定文字 🙂 bold 与 code");
      await act(async () => vi.advanceTimersByTime(300));
      expect(container.textContent).toBe("稳定文字 🙂 bold 与 code 下一批 🙂");
      await act(async () => root.render(<Markdown text={`${text} finished`} workspacePath="/ws" />));
      expect(container.textContent).toBe("稳定文字 🙂 bold 与 code finished");
    } finally {
      vi.useRealTimers();
    }
  });

  it("renders host defaults with no registrations (gfm + CodeBlock card)", async () => {
    await renderMarkdown(`~~gone~~\n\n${FENCE}`);
    // remark-gfm still active: strikethrough is a <del>.
    expect(container.querySelector("del")?.textContent).toBe("gone");
    // Host `pre` override still renders the code-block card.
    expect(container.querySelector(".md-codeblock")).not.toBeNull();
  });

  it("applies a registered plugin's component override", async () => {
    const dispose = markdownRegistry.register({
      id: "plugin:test:md",
      components: {
        code: ({ children }) => <code data-testid="plugin-code">{children}</code>,
      },
    });
    try {
      await renderMarkdown(FENCE);
      expect(container.querySelector("[data-testid='plugin-code']")).not.toBeNull();
    } finally {
      await act(async () => dispose());
    }
  });

  it("registry changes apply live to a mounted render and dispose reverts them", async () => {
    await renderMarkdown(FENCE);
    expect(container.querySelector("[data-testid='plugin-code']")).toBeNull();
    expect(container.querySelector(".md-codeblock")).not.toBeNull();

    let dispose: Disposer = () => {};
    await act(async () => {
      dispose = markdownRegistry.register({
        id: "plugin:test:md",
        components: {
          code: ({ children }) => <code data-testid="plugin-code">{children}</code>,
        },
      });
    });
    expect(container.querySelector("[data-testid='plugin-code']")).not.toBeNull();

    await act(async () => {
      dispose();
    });
    expect(container.querySelector("[data-testid='plugin-code']")).toBeNull();
    expect(container.querySelector(".md-codeblock")).not.toBeNull();
  });
});

describe("large document rendering", () => {
  const largeText = Array.from(
    { length: 320 },
    (_, i) => `## 段${i}\n\n内容 ${"字".repeat(40)} **粗体${i}**`,
  ).join("\n\n");
  async function settleLargeRender() {
    // The plain snapshot paints first, then a transition mounts the chunks.
    for (let i = 0; i < 5; i += 1) {
      await act(async () => {
        const { promise, resolve } = Promise.withResolvers<void>();
        setTimeout(resolve, 30);
        await promise;
      });
    }
  }

  it("mounts a settled historical large reply (>16k chars) progressively after a plain-text first paint", async () => {
    expect(largeText.length).toBeGreaterThan(16_000);
    expect(largeText.length).toBeLessThan(24_000);
    await renderMarkdown(largeText);
    // First paint stays plain text so opening a historical session never blocks input.
    expect(container.querySelectorAll(".md-chunk")).toHaveLength(0);
    expect(container.querySelectorAll("strong")).toHaveLength(0);

    await settleLargeRender();
    expect(container.querySelectorAll(".md-chunk").length).toBeGreaterThan(1);
    expect(container.querySelectorAll("strong").length).toBe(320);
    expect(container.textContent).toContain("粗体319");
    expect(container.textContent).not.toContain("**粗体319**");
  });

  it("keeps a large live reply formatted as memoized Markdown chunks during streaming and on settle", async () => {
    await act(async () => {
      root.render(<Markdown text={largeText} workspacePath="/ws" streaming />);
    });
    expect(container.querySelectorAll(".md-chunk").length).toBeGreaterThan(1);
    expect(container.querySelectorAll("strong").length).toBe(320);
    expect(container.textContent).toContain("粗体319");
    expect(container.textContent).not.toContain("**粗体319**");

    // Settling a live stream must keep all formatted chunks mounted immediately
    // without flashing back to plain text on the settle commit.
    await act(async () => {
      root.render(<Markdown text={largeText} workspacePath="/ws" />);
    });
    expect(container.querySelectorAll(".md-chunk").length).toBeGreaterThan(1);
    expect(container.querySelectorAll("strong").length).toBe(320);
    expect(container.textContent).not.toContain("**粗体319**");
  });
});

describe("math rendering", () => {
  it("typesets inline math instead of leaving the source literal", async () => {
    await renderMarkdown("能量守恒 $E = mc^2$ 收尾");
    expect(container.querySelector(".katex")).not.toBeNull();
    // The raw TeX must not survive as visible text next to the typeset math.
    expect(container.textContent).not.toContain("$E = mc^2$");
  });

  it("typesets display math as a centered block", async () => {
    await renderMarkdown("推导：\n\n$$\n\\int_0^1 x^2 \\, dx = \\frac{1}{3}\n$$\n\n结束");
    expect(container.querySelector(".katex-display")).not.toBeNull();
    // The raw markup is gone: what remains is typeset, not source. (KaTeX
    // keeps the TeX inside its MathML annotation for assistive tech, which
    // is why the check looks for the delimiters and not for "\frac".)
    expect(container.textContent).not.toContain("$$");
  });

  it("promotes a formula that owns its line to a display block", async () => {
    // Models write this single-line form constantly; the parser alone would
    // render it inline and wedge the formula into the paragraph flow.
    await renderMarkdown("推导：\n\n$$\\int_0^1 x^2 \\, dx = \\frac{1}{3}$$\n\n结束");
    expect(container.querySelector(".katex-display")).not.toBeNull();
  });

  it("typesets LaTeX `\\[ ... \\]` display math", async () => {
    // gpt/codex write display math with LaTeX delimiters; remark-math does
    // not know them, so before the fix the whole formula leaked as raw TeX.
    await renderMarkdown(
      "这个公式表示总的瞬时波动率：\n\n\\[\n\\sigma_{\\mathrm{总}}(t,S_t,X_t)\n\\]\n\n其中每一项……",
    );
    expect(container.querySelector(".katex-display")).not.toBeNull();
    expect(container.textContent).not.toContain("\\[");
    expect(container.textContent).not.toContain("\\]");
  });

  it("typesets LaTeX `\\( ... \\)` inline math", async () => {
    await renderMarkdown("当 \\(x > 0\\) 时收敛");
    expect(container.querySelector(".katex")).not.toBeNull();
    expect(container.textContent).not.toContain("\\(");
  });

  it("keeps math inline when it sits inside a sentence", async () => {
    await renderMarkdown("由 $a^2 + b^2 = c^2$ 可得结论");
    expect(container.querySelector(".katex")).not.toBeNull();
    expect(container.querySelector(".katex-display")).toBeNull();
  });

  it("renders a box command with nested math-mode dollars as one formula", async () => {
    await renderMarkdown(
      "颜色测试：$\\nabla_\\theta \\mathcal{L} 与 \\colorbox{yellow}{$\\displaystyle \\int_{-\\infty}^{\\infty} e^{-x^2} dx = \\sqrt{\\pi}$}$",
    );
    // One formula — the inner `$...$` must not split it into an error span
    // plus a raw-TeX text leak.
    expect(container.querySelectorAll(".katex").length).toBe(1);
    expect(container.querySelector(".katex-error")).toBeNull();
    const outside = [...container.querySelectorAll("*")]
      .filter((el) => !el.closest(".katex") && el.children.length === 0)
      .map((el) => el.textContent ?? "")
      .join("");
    expect(outside).not.toContain("\\int");
    expect(outside).not.toContain("\\colorbox");
  });

  it("renders nested box math in a display formula", async () => {
    await renderMarkdown(
      "$$\n\\hat{p} = \\mathrm{softmax}(Wh + b) \\quad \\colorbox{yellow}{$x^2$}\n$$",
    );
    expect(container.querySelector(".katex-display")).not.toBeNull();
    expect(container.querySelector(".katex-error")).toBeNull();
  });

  it("leaves dollar signs inside code blocks alone", async () => {
    await renderMarkdown("```sh\necho $HOME\n```");
    expect(container.querySelector(".katex")).toBeNull();
    expect(container.textContent).toContain("$HOME");
  });

  it("preserves KaTeX's inline positioning styles through the span override", async () => {
    // KaTeX lifts superscripts and stacks fractions with inline styles
    // (`style="top:-3.06em"`, strut heights). The host span override once
    // dropped every prop except className, collapsing the whole formula
    // onto the baseline with overlapping glyphs.
    await renderMarkdown("平方 $a^2 + \\frac{1}{\\ln x}$ 完");
    const styled = container.querySelectorAll<HTMLElement>(".katex span[style]");
    expect(styled.length).toBeGreaterThan(0);
    const tops = [...styled].map((el) => el.style.top).filter(Boolean);
    expect(tops.length).toBeGreaterThan(0);
  });

  it("keeps the formula whole while the row is streaming", async () => {
    // Reveal spans render text as a moving prefix; a formula must never be
    // truncated by that (the reveal-plan unit test guards the mechanism).
    await act(async () => {
      root.render(<Markdown text={"$a+b$ 以及 $c$"} workspacePath="/ws" streaming />);
    });
    const katex = container.querySelector(".katex");
    expect(katex).not.toBeNull();
    expect(katex?.textContent ?? "").toContain("a");
    expect(katex?.textContent ?? "").toContain("+");
  });
});

describe("GFM email autolinks (WKWebView lookbehind compatibility)", () => {
  it("autolinks an email at a word boundary", async () => {
    await renderMarkdown("联系 a@b.co 谢谢");
    const link = container.querySelector("a[href='mailto:a@b.co']");
    expect(link?.textContent).toBe("a@b.co");
  });

  it("still refuses an email glued to a preceding non-boundary character", async () => {
    // Boundary behavior the lookbehind used to contribute: an email glued to a
    // preceding "/" must not become a link. The tokenizer rejects it first
    // here, and `findEmail`'s own `previous(match, true)` check keeps rejecting
    // it on any transform-only path.
    await renderMarkdown("请发/a@b.co");
    expect(container.querySelector("a[href^='mailto:']")).toBeNull();
  });

  it("resolves a lookbehind-free email regex for Safari/WKWebView < 16.4", () => {
    // Regression: remark-gfm's email autolink regex used to carry the
    // lookbehind `(?<=^|\s|\p{P}|\p{S})`. JavaScriptCore before Safari 16.4
    // cannot parse lookbehind and throws
    // `SyntaxError: invalid group specifier name` on every Markdown parse,
    // which crashed the whole app on launch (chat restore / release notes).
    // The pnpm patch in patches/ removes it; keep this guard so a future
    // dependency bump cannot silently bring the crash back.
    const requireFromTest = createRequire(import.meta.url);
    const requireFromRemarkGfm = createRequire(requireFromTest.resolve("remark-gfm"));
    const requireFromGfm = createRequire(requireFromRemarkGfm.resolve("mdast-util-gfm"));
    const autolinkEntry = requireFromGfm.resolve("mdast-util-gfm-autolink-literal");
    const source = readFileSync(autolinkEntry, "utf8");
    expect(source).not.toMatch(/\(\?<[=!]/);
  });
});

describe("Markdown images", () => {
  const imagePath = "1live2d/references/claude-gpt-20261019/claude-candidates.jpg";
  const candidateUrl = "data:image/jpeg;base64,Y2FuZGlkYXRl";

  function imageFile(dataUrl: string) {
    return { kind: "image", text: null, dataUrl, truncated: false };
  }

  function dirEntry(name: string, mtimeMs = 1) {
    return { name, isDir: false, size: 12, mtimeMs };
  }

  async function renderIn(text: string, workspacePath: string) {
    await act(async () => {
      root.render(<Markdown text={text} workspacePath={workspacePath} />);
    });
  }

  async function remount(text: string) {
    await act(async () => root.unmount());
    root = createRoot(container);
    await renderMarkdown(text);
  }

  /** Every file IPC the image path triggered, in call order per command. */
  function fileCalls() {
    return [
      ...imageIpc.listDir.mock.calls.map(([path]) => `listDir ${path}`),
      ...imageIpc.listFileIndex.mock.calls.map(([path]) => `listFileIndex ${path}`),
      ...imageIpc.readFile.mock.calls.map(([path]) => `readFile ${path}`),
    ];
  }

  beforeEach(() => {
    resetMarkdownImageCaches();
  });

  it("loads a workspace-relative image file through the file reader", async () => {
    imageIpc.listDir.mockResolvedValue([dirEntry("claude-candidates.jpg")]);
    imageIpc.readFile.mockResolvedValueOnce(imageFile(candidateUrl));

    await renderMarkdown(`![Claude 候选](${imagePath})`);

    await act(async () => {
      await vi.waitFor(() =>
        expect(imageIpc.readFile).toHaveBeenCalledWith(`/ws/${imagePath}`),
      );
    });

    const image = container.querySelector<HTMLImageElement>("img");
    expect(image?.getAttribute("src")).toBe(candidateUrl);
    expect(image?.alt).toBe("Claude 候选");
    expect(imageIpc.readFile).toHaveBeenCalledWith(`/ws/${imagePath}`);
  });

  it("keeps remote images on their original URL without reading local files", async () => {
    const url = "https://example.com/candidate.png";
    await renderMarkdown(`![Remote candidate](${url})`);

    expect(container.querySelector("img")?.getAttribute("src")).toBe(url);
    expect(imageIpc.readFile).not.toHaveBeenCalled();
  });

  it("renders a raster data URL directly", async () => {
    const url = "data:image/png;base64,cG5n";
    await renderMarkdown(`![Generated image](${url})`);

    expect(container.querySelector("img")?.getAttribute("src")).toBe(url);
    expect(imageIpc.readFile).not.toHaveBeenCalled();
  });

  it.each(["D:/private/secret.png", "/Users/me/secret.png"])(
    "does not touch the file system for %s outside the workspace and shows its alt text",
    async (src) => {
      await renderMarkdown(`![Private image](${src})`);
      await act(async () => {});

      expect(container.querySelector("img")).toBeNull();
      expect(container.textContent).toContain("Private image");
      expect(fileCalls()).toEqual([]);
    },
  );

  // `isPathUnder` compares strings, and the backend answers a `..` path that
  // resolves outside every root with the error that opens the grant dialog.
  it.each([
    "./../outside/secret.png",
    "assets/../../outside/secret.png",
    "/ws/../outside/secret.png",
    "assets/%2E%2E/%2E%2E/outside/secret.png",
    // Markdown needs `\\` for one literal backslash (`\.` is an escape).
    "assets\\\\..\\\\..\\\\outside\\\\secret.png",
  ])("never sends the dot-dot path %s to any file IPC", async (src) => {
    await renderMarkdown(`![Escaped image](${src})`);
    await act(async () => {});

    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toBe("Escaped image");
    expect(fileCalls()).toEqual([]);
  });

  // A nested root matters: the parent of `/ws` is "" and would short-circuit.
  it.each([
    ["the workspace root itself", "/home/u/ws"],
    ["the root with a line suffix", "/home/u/ws:3"],
    ["another case on a case-sensitive file system", "/home/u/WS/x.png"],
    ["a Kelvin sign that lower-cases to k", "/home/u/\u212Aws/x.png"],
  ])("never sends %s to any file IPC", async (_label, src) => {
    const workspace = src.includes("\u212A") ? "/home/u/kws" : "/home/u/ws";
    await renderIn(`![Escaped image](${src})`, workspace);
    await act(async () => {});

    expect(container.querySelector("img")).toBeNull();
    expect(fileCalls()).toEqual([]);
  });

  it("matches a Windows workspace regardless of ASCII case", async () => {
    imageIpc.listDir.mockResolvedValue([dirEntry("a.png")]);
    imageIpc.readFile.mockResolvedValue(imageFile("data:image/png;base64,d2lu"));

    await renderIn("![win](c:/Users/Me/ws/img/a.png)", "C:\\Users\\me\\WS");
    await act(async () => {});

    expect(imageIpc.readFile).toHaveBeenCalledWith("c:/Users/Me/ws/img/a.png");
  });

  it("keeps Windows drive-letter link targets clickable", async () => {
    await renderIn("[a.ts](C:/ws/src/a.ts)", "C:\\ws");

    const link = container.querySelector("a.md-file-link");
    expect(link?.getAttribute("href")).toBe("C:/ws/src/a.ts");
  });

  it("reads a Windows drive-letter image inside the workspace", async () => {
    imageIpc.listDir.mockResolvedValue([dirEntry("a.png")]);
    imageIpc.readFile.mockResolvedValue(imageFile("data:image/png;base64,d2lu"));

    await renderIn("![win](C:/ws/img/a.png)", "C:\\ws");
    await act(async () => {});

    expect(imageIpc.readFile).toHaveBeenCalledWith("C:/ws/img/a.png");
    expect(container.querySelector("img")?.getAttribute("src")).toBe("data:image/png;base64,d2lu");
  });

  it("turns a bare relative link target into a file link", async () => {
    await renderMarkdown("[main](src/main.ts)");

    expect(container.querySelector("a.md-file-link")?.getAttribute("href")).toBe("src/main.ts");
  });

  it("still blanks scheme-bearing link and image targets", async () => {
    await renderMarkdown("[a](javascript:alert(1)) [b](file:///etc/passwd) ![c](file:///etc/c.png)");
    await act(async () => {});

    expect(container.querySelector("a")).toBeNull();
    expect(container.querySelector("img")).toBeNull();
    expect(fileCalls()).toEqual([]);
  });

  it("paints the cached image on remount and skips the read while the file is unchanged", async () => {
    imageIpc.listDir.mockResolvedValue([dirEntry("claude-candidates.jpg")]);
    imageIpc.readFile.mockResolvedValue(imageFile(candidateUrl));
    await renderMarkdown(`![Claude 候选](${imagePath})`);
    await act(async () => {});
    expect(imageIpc.readFile).toHaveBeenCalledTimes(1);

    // The parent listing stays pending: whatever shows now came from the cache.
    let releaseListing: (entries: unknown[]) => void = () => {};
    imageIpc.listDir.mockImplementation(
      () => new Promise((resolve) => { releaseListing = resolve; }),
    );
    await remount(`![Claude 候选](${imagePath})`);
    expect(container.querySelector("img")?.getAttribute("src")).toBe(candidateUrl);

    await act(async () => {
      releaseListing([dirEntry("claude-candidates.jpg")]);
    });
    expect(imageIpc.listDir).toHaveBeenCalledTimes(2);
    expect(imageIpc.readFile).toHaveBeenCalledTimes(1);
    expect(container.querySelector("img")?.getAttribute("src")).toBe(candidateUrl);
  });

  it("keeps a read that finished after its row unmounted", async () => {
    imageIpc.listDir.mockResolvedValue([dirEntry("claude-candidates.jpg")]);
    let releaseRead: (file: unknown) => void = () => {};
    imageIpc.readFile.mockImplementationOnce(
      () => new Promise((resolve) => { releaseRead = resolve; }),
    );
    await renderMarkdown(`![Claude 候选](${imagePath})`);
    await act(async () => root.unmount());
    await act(async () => releaseRead(imageFile(candidateUrl)));

    root = createRoot(container);
    await renderMarkdown(`![Claude 候选](${imagePath})`);
    expect(container.querySelector("img")?.getAttribute("src")).toBe(candidateUrl);
    await act(async () => {});
    expect(imageIpc.readFile).toHaveBeenCalledTimes(1);
  });

  it("shares one listing and one read between copies of the same image", async () => {
    imageIpc.listDir.mockResolvedValue([dirEntry("claude-candidates.jpg")]);
    imageIpc.readFile.mockResolvedValue(imageFile(candidateUrl));

    await renderMarkdown(`![a](${imagePath})\n\n![b](${imagePath})`);
    await act(async () => {});

    expect(container.querySelectorAll("img")).toHaveLength(2);
    expect(imageIpc.listDir).toHaveBeenCalledTimes(1);
    expect(imageIpc.readFile).toHaveBeenCalledTimes(1);
  });

  it("reads again on every mount when the parent listing fails", async () => {
    imageIpc.listDir.mockRejectedValue("cannot list");
    imageIpc.listFileIndex.mockResolvedValue([]);
    imageIpc.readFile.mockResolvedValue(imageFile(candidateUrl));
    await renderMarkdown(`![Claude 候选](${imagePath})`);
    await act(async () => {});
    await remount(`![Claude 候选](${imagePath})`);
    await act(async () => {});

    expect(imageIpc.readFile).toHaveBeenCalledTimes(2);
    expect(container.querySelector("img")?.getAttribute("src")).toBe(candidateUrl);
  });

  it("skips the index scan for a recent miss but still finds a file that appears", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    try {
      imageIpc.listDir.mockResolvedValue([]);
      imageIpc.listFileIndex.mockResolvedValue([]);
      imageIpc.readFile.mockRejectedValue("not found");
      await renderMarkdown(`![Claude 候选](${imagePath})`);
      await act(async () => {});
      expect(imageIpc.listFileIndex).toHaveBeenCalledTimes(1);

      await remount(`![Claude 候选](${imagePath})`);
      await act(async () => {});
      expect(imageIpc.listFileIndex).toHaveBeenCalledTimes(1);
      expect(container.textContent).toBe("Claude 候选");

      now.mockReturnValue(1_000_000 + 16_000);
      await remount(`![Claude 候选](${imagePath})`);
      await act(async () => {});
      expect(imageIpc.listFileIndex).toHaveBeenCalledTimes(2);

      imageIpc.listDir.mockResolvedValue([dirEntry("claude-candidates.jpg")]);
      imageIpc.readFile.mockResolvedValue(imageFile(candidateUrl));
      await remount(`![Claude 候选](${imagePath})`);
      await act(async () => {});
      expect(container.querySelector("img")?.getAttribute("src")).toBe(candidateUrl);
    } finally {
      now.mockRestore();
    }
  });

  it("reads again when the agent regenerated the image under the same name", async () => {
    imageIpc.listDir.mockResolvedValue([dirEntry("claude-candidates.jpg", 1)]);
    imageIpc.readFile.mockResolvedValueOnce(imageFile(candidateUrl));
    await renderMarkdown(`![Claude 候选](${imagePath})`);
    await act(async () => {});

    const regenerated = "data:image/jpeg;base64,bmV3";
    imageIpc.listDir.mockResolvedValue([dirEntry("claude-candidates.jpg", 2)]);
    imageIpc.readFile.mockResolvedValueOnce(imageFile(regenerated));
    await remount(`![Claude 候选](${imagePath})`);
    await act(async () => {});

    expect(imageIpc.readFile).toHaveBeenCalledTimes(2);
    expect(container.querySelector("img")?.getAttribute("src")).toBe(regenerated);
  });

  it("falls back to the alt text when the file is not an image or cannot be read", async () => {
    imageIpc.listDir.mockResolvedValue([dirEntry("main.ts"), dirEntry("big.png")]);
    imageIpc.readFile.mockImplementation(async (path: string) => {
      if (path.endsWith("main.ts")) return { kind: "text", text: "x", dataUrl: null, truncated: false };
      throw "image exceeds 5MB preview limit";
    });

    await renderMarkdown("![code](src/main.ts) ![big](img/big.png)");
    await act(async () => {});

    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toBe("code big");
  });
});

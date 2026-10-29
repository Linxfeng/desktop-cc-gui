import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { splitMarkdown, type MarkdownChunk } from "./markdown-chunks";

const para = (label: string, width = 120) => `${label} ${"字".repeat(width)}`;
const renderMarkdown = (text: string) =>
  renderToStaticMarkup(
    createElement(ReactMarkdown, { remarkPlugins: [remarkGfm] }, text),
  );
const renderChunks = (chunks: MarkdownChunk[]) =>
  chunks.map((chunk) => renderMarkdown(chunk.text)).join("");
const countElements = (html: string, tag: string) =>
  html.match(new RegExp(`<${tag}(?: |>)`, "g"))?.length ?? 0;

describe("splitMarkdown", () => {
  it("splits top-level blocks and reproduces the source exactly", () => {
    const blocks = Array.from({ length: 12 }, (_, i) => para(`第${i}段`));
    const text = blocks.join("\n\n");
    const chunks = splitMarkdown(text, 300);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.map((chunk) => chunk.text).join("")).toBe(text);
    expect(chunks[0].start).toBe(0);
    for (let i = 1; i < chunks.length; i += 1) {
      expect(chunks[i].start).toBe(chunks[i - 1].start + chunks[i - 1].text.length);
    }
  });

  it("keeps fenced code, display math, lists and quotes in one chunk", () => {
    const body = [
      para("开头"),
      "```ts",
      para("代码块里的空行不应该切段"),
      "",
      para("仍在代码块里"),
      "```",
      "$$",
      "a + b",
      "",
      "c + d",
      "$$",
      "- 项目一",
      "",
      "  项目一的续行",
      "- 项目二",
      "",
      "> 引用第一段",
      "",
      "> 引用第二段",
      para("结尾"),
    ].join("\n");
    const chunks = splitMarkdown(`${para("前言", 20)}\n\n${body}`, 120);

    expect(chunks.map((chunk) => chunk.text).join("")).toBe(
      `${para("前言", 20)}\n\n${body}`,
    );
    const code = chunks.find((chunk) => chunk.text.includes("```ts"));
    expect(code?.text).toContain("仍在代码块里");
    const math = chunks.find((chunk) => chunk.text.includes("$$"));
    expect(math?.text).toContain("c + d");
    const quote = chunks.find((chunk) => chunk.text.includes("> 引用第一段"));
    expect(quote?.text).toContain("> 引用第二段");
  });

  it("keeps documents with reference or footnote definitions in one tree", () => {
    const references = `${para("正文", 500)}\n\n[文档]: https://example.com\n\n${para("结尾", 500)}`;
    expect(splitMarkdown(references, 200)).toHaveLength(1);

    const footnotes = `${para("正文", 500)}\n\n[^1]: 脚注内容\n\n${para("结尾", 500)}`;
    expect(splitMarkdown(footnotes, 200)).toHaveLength(1);
  });

  it("keeps paired top-level HTML blocks intact without collapsing the whole document into one chunk", () => {
    const text = [
      para("前言", 300),
      "<details>\n<summary>展开</summary>\n\n段落一\n\n段落二\n</details>",
      para("中段", 300),
      "<out>\n第一段输出\n\n第二段输出\n</out>",
      para("结尾", 300),
    ].join("\n\n");
    const chunks = splitMarkdown(text, 250);

    expect(chunks.length).toBeGreaterThan(2);
    expect(chunks.map((chunk) => chunk.text).join("")).toBe(text);
    const detailsChunk = chunks.find((chunk) => chunk.text.includes("<details>"));
    expect(detailsChunk?.text).toContain("</details>");
    const outChunk = chunks.find((chunk) => chunk.text.includes("<out>"));
    expect(outChunk?.text).toContain("</out>");
  });

  it("enforces a hard chunk cap on pathological unclosed lists or indented runs", () => {
    const blocks = [
      para("开头", 200),
      `1. 列表起点\n\n${Array.from({ length: 12 }, (_, i) => `    indentedLine${i}("${"x".repeat(80)}");`).join("\n\n")}`,
      para("结尾", 200),
    ].join("\n\n");
    const chunks = splitMarkdown(blocks, 200);

    expect(chunks.length).toBeGreaterThan(2);
    expect(chunks.map((chunk) => chunk.text).join("")).toBe(blocks);
    for (const chunk of chunks) {
      expect(chunk.text.length).toBeLessThanOrEqual(600);
    }
  });

  it("cuts an over-long list only before a top-level item so nested content keeps its nesting", () => {
    const items = Array.from({ length: 40 }, (_, i) =>
      [`${i + 1}. 第${i + 1}项 ${"字".repeat(60)}`, `    - 子要点 ${"字".repeat(30)}`].join("\n\n"),
    );
    const text = [para("前言", 20), ...items, para("结尾", 20)].join("\n\n");
    const chunks = splitMarkdown(text, 600);

    expect(chunks.length).toBeGreaterThan(2);
    expect(chunks.map((chunk) => chunk.text).join("")).toBe(text);
    for (const chunk of chunks.slice(1)) {
      // A chunk opening with 4 spaces would turn the nested bullet into an
      // indented code block and drop the rest of that chunk out of the list.
      expect(chunk.text).toMatch(/^\S/);
    }
    const whole = renderMarkdown(text);
    const split = renderChunks(chunks);
    expect(countElements(split, "pre")).toBe(countElements(whole, "pre"));
    expect(countElements(split, "ul")).toBe(countElements(whole, "ul"));
    expect(countElements(split, "li")).toBe(countElements(whole, "li"));
  });

  it("does not take a backtick line whose info string has a backtick for a fence", () => {
    const text = [
      para("前言", 300),
      "",
      "```js` 只是行内提到的围栏写法",
      "",
      para("说明", 300),
      "",
      "```",
      `const a = "${"x".repeat(300)}";`,
      "",
      `const b = "${"y".repeat(300)}";`,
      "```",
      "",
      para("结尾", 300),
    ].join("\n");
    const chunks = splitMarkdown(text, 250);

    expect(chunks.map((chunk) => chunk.text).join("")).toBe(text);
    const code = chunks.find((chunk) => chunk.text.includes("const a"));
    expect(code?.text).toContain("const b");
    expect(countElements(renderChunks(chunks), "pre")).toBe(1);
  });

  it("ignores display-math dollars quoted inside inline code", () => {
    const blocks = [
      "公式块用 `$$` 包起来",
      ...Array.from({ length: 12 }, (_, i) => para(`第${i}段`)),
    ];
    const text = blocks.join("\n\n");
    const chunks = splitMarkdown(text, 300);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.map((chunk) => chunk.text).join("")).toBe(text);
  });

  it("keeps a list together across a nested fenced code block", () => {
    const text = [
      para("前言", 300),
      `1. ${"甲".repeat(260)}`,
      "   ```js\n   x\n   ```",
      "1. second",
      para("结尾", 300),
    ].join("\n\n");
    const chunks = splitMarkdown(text, 250);

    expect(countElements(renderMarkdown(text), "ol")).toBe(1);
    expect(countElements(renderChunks(chunks), "ol")).toBe(1);
    expect(countElements(renderChunks(chunks), "li")).toBe(2);
  });

  it("keeps escaped reference labels and their links in one Markdown tree", () => {
    const text = [
      String.raw`[a\]]: https://example.com`,
      para("说明", 300),
      String.raw`[a\]]`,
      para("结尾", 300),
    ].join("\n\n");
    const chunks = splitMarkdown(text, 250);

    expect(renderMarkdown(text)).toContain('<a href="https://example.com">a]</a>');
    expect(chunks).toHaveLength(1);
    expect(renderChunks(chunks)).toContain('<a href="https://example.com">a]</a>');
  });

  it("ignores HTML and definition examples inside fenced code", () => {
    const text = [
      para("普通代码", 300),
      "```md",
      "<details>",
      "[example]: https://example.com",
      "[^note]: footnote",
      "</details>",
      "```",
      para("后续内容", 300),
      para("结尾", 300),
    ].join("\n\n");
    const chunks = splitMarkdown(text, 250);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.map((chunk) => chunk.text).join("")).toBe(text);
    expect(renderChunks(chunks)).toContain("&lt;details&gt;");
  });

  it("leaves short documents as a single chunk", () => {
    expect(splitMarkdown("短消息")).toEqual([{ text: "短消息", start: 0 }]);
    expect(splitMarkdown("")).toEqual([]);
  });
});

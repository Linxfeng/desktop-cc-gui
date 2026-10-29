import { describe, expect, it } from "vitest";
import { transformMarkdownUrl } from "./markdown-url";

describe("transformMarkdownUrl", () => {
  it.each([
    "https://example.com/a.png",
    "HTTP://example.com",
    "mailto:a@example.com",
    "ccgui-file:%2Fws%2Fa.ts",
    "data:image/png;base64,cG5n",
    "#anchor",
    "/abs/path.ts",
    "./rel.png",
    "../up.png",
    "src/main.ts",
    "1live2d/references/a.jpg",
    "C:/ws/src/a.ts",
    "c:/ws/a.png",
  ])("keeps %s", (url) => {
    expect(transformMarkdownUrl(url)).toBe(url);
  });

  it.each([
    "javascript:alert(1)",
    "JaVaScRiPt:alert(1)",
    "vbscript:msgbox",
    "file:///etc/passwd",
    "data:image/svg+xml;base64,PHN2Zz4=",
    "data:text/html;base64,PGI+",
    "tel:123",
    // `C:\…` reaches urlTransform as `C:%5C…` and stays blanked, as before.
    "C:%5Cws%5Ca.ts",
  ])("blanks %s", (url) => {
    expect(transformMarkdownUrl(url)).toBe("");
  });
});

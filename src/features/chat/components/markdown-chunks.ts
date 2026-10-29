export interface MarkdownChunk {
  /** Slice of the prepared Markdown source. */
  text: string;
  /** UTF-16 offset of `text` in the whole document. */
  start: number;
}

/** Long documents are split into independent Markdown trees so React can
 *  time-slice the transition and one pathological reply cannot monopolize a
 *  frame. The target stays well below the measured ~500 ms parse cost of
 *  50k units. */
export const MARKDOWN_CHUNK_TARGET = 8_000;

/** Syntax that only works when the whole document is parsed at once. Huge
 *  replies using link/footnote definitions keep one tree. */
const CROSS_CHUNK_SYNTAX =
  /^ {0,3}\[(?:\\.|[^\]])+\]:|^ {0,3}\[\^(?:\\.|[^\]])+\]:/;

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const LIST_FENCE = /^ {0,7}(`{3,}|~{3,})/;
const LIST_ITEM = /^ {0,3}(?:[-+*]|\d+[.)])(?:\s|$)/;
const LIST_CONTINUATION = /^(?: {2,}|\t)/;
const QUOTE = /^ {0,3}>/;
const INDENTED = /^(?: {4}|\t)/;
const HTML_OPEN_TAG = /^ {0,3}<([A-Za-z][A-Za-z0-9-]*)(?:\s[^>]*)?>/;
const HTML_VOID_TAGS: Record<string, true> = {
  area: true,
  base: true,
  br: true,
  col: true,
  embed: true,
  hr: true,
  img: true,
  input: true,
  link: true,
  meta: true,
  param: true,
  source: true,
  track: true,
  wbr: true,
};
/** Inline code spans: a backtick run closed by the next run of equal length. */
const INLINE_CODE = /(`+)[^`]*\1/g;
function countDollars(line: string): number {
  // `$$` quoted in inline code (common when a reply explains LaTeX) is text,
  // not a display-math fence; counting it would hold "math open" forever and
  // stop every later split.
  const text = line.includes("`") ? line.replace(INLINE_CODE, "") : line;
  let count = 0;
  for (let i = 0; i < text.length - 1; i += 1) {
    if (text[i] === "$" && text[i + 1] === "$") {
      count += 1;
      i += 1;
    }
  }
  return count;
}

/**
 * Split a Markdown document at top-level blank lines. Boundaries inside
 * fenced code, display math, lists, blockquotes, indented code or raw HTML
 * are never used, so a chunk starts a fresh document only where the previous
 * one ended a complete block.
 *
 * Concatenating every `text` reproduces the input exactly.
 */
export function splitMarkdown(
  text: string,
  target = MARKDOWN_CHUNK_TARGET,
): MarkdownChunk[] {
  if (text.length <= target) {
    return text ? [{ text, start: 0 }] : [];
  }

  const chunks: MarkdownChunk[] = [];
  let chunkStart = 0;
  let lineStart = 0;
  // Past `softMax` a long list/quote/indented run may be cut, but only before
  // a line that starts at column 0 (the next top-level item): cutting before
  // an indented continuation would make a fresh chunk read 4 spaces as an
  // indented code block. A run with no such line before `forceMax` is
  // pathological (unfenced code with list-like comments) and is cut anyway.
  const softMax = target * 2;
  const forceMax = target * 3;
  let fence: { char: string; length: number } | null = null;
  let mathOpen = false;
  let htmlCloseRe: RegExp | null = null;
  let inList = false;
  let inQuote = false;
  let inIndented = false;
  // End of the blank-line run after the previous non-blank line. A break is
  // committed only after the next non-blank line proves the block ended.
  let blankEnd: number | null = null;
  const commit = (end: number) => {
    if (end - chunkStart < target) return;
    chunks.push({ text: text.slice(chunkStart, end), start: chunkStart });
    chunkStart = end;
  };

  while (lineStart < text.length) {
    const newline = text.indexOf("\n", lineStart);
    const lineEnd = newline === -1 ? text.length : newline;
    const line = text.slice(lineStart, lineEnd);
    const trimmed = line.trimStart();

    if (!trimmed) {
      if (!fence && !mathOpen && !htmlCloseRe && lineEnd >= chunkStart) {
        blankEnd = Math.min(lineEnd + 1, text.length);
      }
      lineStart = lineEnd + 1;
      continue;
    }

    if (htmlCloseRe) {
      if (htmlCloseRe.test(line)) {
        htmlCloseRe = null;
      }
      blankEnd = null;
      lineStart = lineEnd + 1;
      continue;
    }

    if (fence) {
      const close = (inList ? LIST_FENCE : FENCE).exec(line);
      if (
        close &&
        close[1][0] === fence.char &&
        close[1].length >= fence.length &&
        line.slice(close[0].length).trim() === ""
      ) {
        fence = null;
      }
      blankEnd = null;
      lineStart = lineEnd + 1;
      continue;
    }

    if (blankEnd !== null) {
      // An indented line after a blank continues the previous list item or
      // code block. Starting a list/quote while already inside one continues
      // that same list/quote. Neither is a document boundary unless the chunk
      // has already grown past the caps above.
      const overHardCap =
        (blankEnd - chunkStart >= softMax && !/^\s/.test(line)) ||
        lineEnd - chunkStart > forceMax;
      const continuesIndented = !overHardCap && inIndented && INDENTED.test(line);
      const continuesList =
        !overHardCap &&
        inList &&
        (LIST_ITEM.test(line) || LIST_CONTINUATION.test(line));
      const continuesQuote = !overHardCap && inQuote && QUOTE.test(line);
      if (!continuesIndented && !continuesList && !continuesQuote) {
        commit(blankEnd);
        inList = false;
        inQuote = false;
        inIndented = false;
      }
      blankEnd = null;
    }

    const open = (inList ? LIST_FENCE : FENCE).exec(line);
    // A backtick fence's info string cannot contain a backtick (CommonMark
    // 4.5): "```js` ..." is paragraph text. Taking it for a fence would invert
    // the open/close pairing and cut a later real code block in half.
    if (open && !(open[1][0] === "`" && line.slice(open[0].length).includes("`"))) {
      fence = { char: open[1][0], length: open[1].length };
      lineStart = lineEnd + 1;
      continue;
    }
    const dollars = countDollars(line);
    if (mathOpen || dollars % 2 === 1) {
      // A line with an odd count opens display math; an even count inside an
      // open block either closes it or is content. A single line with two
      // pairs opens and closes in one line.
      mathOpen = mathOpen ? dollars % 2 === 0 : dollars % 2 === 1;
      blankEnd = null;
      lineStart = lineEnd + 1;
      continue;
    }

    if (CROSS_CHUNK_SYNTAX.test(line)) {
      return [{ text, start: 0 }];
    }
    if (line.startsWith("<!--") || trimmed.startsWith("<!--")) {
      if (!line.includes("-->")) {
        htmlCloseRe = /-->/;
        blankEnd = null;
        lineStart = lineEnd + 1;
        continue;
      }
    } else {
      const htmlMatch = HTML_OPEN_TAG.exec(line);
      if (htmlMatch) {
        const tag = htmlMatch[1].toLowerCase();
        const selfClosing = /\/>\s*$/.test(line) || Boolean(HTML_VOID_TAGS[tag]);
        const closeRe = new RegExp(`</${tag}\\s*>`, "i");
        if (!selfClosing && !closeRe.test(line)) {
          htmlCloseRe = closeRe;
          blankEnd = null;
          lineStart = lineEnd + 1;
          continue;
        }
      }
    }
    inList = inList || LIST_ITEM.test(line);
    inQuote = QUOTE.test(line);
    inIndented = !inList && INDENTED.test(line);
    lineStart = lineEnd + 1;
  }

  if (chunkStart < text.length) {
    chunks.push({ text: text.slice(chunkStart), start: chunkStart });
  }
  return chunks;
}

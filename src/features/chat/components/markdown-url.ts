import { isFileLinkUrl } from "@/lib/fileLinks";
import { SAFE_DATA_IMAGE_URL } from "./markdown-image-source";

/**
 * ReactMarkdown `urlTransform` for chat replies (link `href` and image `src`).
 *
 * file: is deliberately excluded: model output must not smuggle in local-file
 * URLs. Real file paths are handled by the `a` override (FileLink) and by
 * MarkdownImage's workspace-scoped reader.
 */
export function transformMarkdownUrl(url: string): string {
  if (isFileLinkUrl(url) || SAFE_DATA_IMAGE_URL.test(url)) return url;
  if (/^(https?|mailto):/i.test(url)) return url;
  // A drive letter looks like a one-letter scheme: keep `C:/…` paths. The
  // `C:\…` form arrives as `C:%5C…` (mdast normalizes the URL first) and
  // stays blanked, as it always was.
  if (/^[A-Za-z]:\//.test(url)) return url;
  // Anything else without a scheme is a relative reference ("#anchor",
  // "/abs", "./rel" or a bare "dir/file.png"). Scheme-bearing URLs
  // (file:, javascript:, vbscript:, …) stay blanked.
  return /^[A-Za-z][A-Za-z0-9+.-]*:/.test(url) ? "" : url;
}

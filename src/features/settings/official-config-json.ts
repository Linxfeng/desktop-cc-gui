/**
 * Client-side JSON check shared by the host and WSL official-config editors,
 * so the save button disables before the round-trip. TOML panes rely on the
 * backend's parse error, shown inline.
 */
export function jsonErrorOf(format: string, content: string): string | null {
  if (format !== "json") return null;
  try {
    const value: unknown = JSON.parse(content);
    if (!value || typeof value !== "object" || Array.isArray(value)) return "object";
    return null;
  } catch {
    return "syntax";
  }
}

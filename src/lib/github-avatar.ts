/**
 * GitHub's username `.png` endpoint serves a user's or an organization's real
 * avatar — the same image the account shows on github.com. Shared by the
 * plugin market's developer chips and the sidebar's workspace rows.
 */

/** Largest size the endpoint accepts. */
const MAX_SIZE = 460;

/** 2× the CSS size keeps the bitmap crisp on retina displays; the endpoint
 *  caps at 460. */
export function githubAvatarUrl(login: string, cssSize: number): string {
  const size = Math.min(MAX_SIZE, Math.max(1, Math.round(cssSize * 2)));
  return `https://github.com/${login}.png?size=${size}`;
}

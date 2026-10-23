/**
 * 本机 WSL 工作区的 UNC 路径解析(前端侧)。
 *
 * 系统目录选择器对 WSL 目录返回 `\\wsl.localhost\<发行版>\<path>`(旧别名
 * `\\wsl$`),Rust 侧的 `canonicalize` 还会带上 `\\?\UNC\` 前缀。宿主只需要
 * 判断"这是不是一个本机 WSL 工作区"以及取出发行版名(侧栏徽标、引擎可用性
 * 查询),真正的路径语义与安全校验在 `src-tauri/src/engine/wsl_path.rs`。
 *
 * 与 Rust 侧保持同一套拼写:两种主机名、正/反斜杠、大小写不敏感、保留
 * `..` 段不解析(只做识别,不做路径规范化)。
 */

const WSL_HOSTS = ["wsl.localhost", "wsl$"];

export interface WslUncPath {
  distro: string;
  /** 发行版内路径,始终以 `/` 开头。 */
  linuxPath: string;
}

/** 大小写不敏感地剥掉 `\\?\UNC\` 前缀(Windows canonicalize 的产物)。 */
function stripVerbatimUnc(path: string): string | null {
  return /^\\\\\?\\UNC\\/i.test(path) ? path.slice("\\\\?\\UNC\\".length) : null;
}

/** 解析 WSL UNC 路径;不是本机 WSL 工作区时返回 null。 */
export function parseWslUncPath(path: string | null | undefined): WslUncPath | null {
  const trimmed = path?.trim();
  if (!trimmed || trimmed.includes("\0")) return null;
  // 剥掉前缀后 UNC 的 `\\` 编码在前缀里,补回来才和普通 UNC 同形(与
  // `src-tauri/src/engine/wsl_path.rs` 的 `strip_verbatim_unc` 一致)。
  const verbatimTail = stripVerbatimUnc(trimmed);
  const unwrapped = verbatimTail === null ? trimmed : `\\\\${verbatimTail}`;
  // 两种分隔符混写也接受;统一成正斜杠后按 UNC 形状切分。
  const normalized = unwrapped.replace(/\\/g, "/");
  const match = /^\/\/([^/]+)\/([^/]+)(\/.*)?$/.exec(normalized);
  if (!match) return null;
  const [, host, distro, tail] = match;
  if (!WSL_HOSTS.some((h) => h.toLowerCase() === host!.toLowerCase())) return null;
  if (!distro) return null;
  return { distro: distro!, linuxPath: tail && tail !== "/" ? tail : "/" };
}

/** 该工作区是否为本机 WSL UNC 工作区。 */
export function isWslUncWorkspace(path: string | null | undefined): boolean {
  return parseWslUncPath(path) !== null;
}

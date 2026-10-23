import i18n from "i18next";
import { formatFileSize } from "@/utils/image-meta";

/** 本机 WSL 的稳定错误前缀 → i18n key。错误串由 Rust 侧构造
 *  (`wsl_probe::ProbeError::code`、`WSL_CLI_NOT_FOUND:<bin>` 等),后端只保证
 *  前缀稳定;细节参数跟在冒号后,原样插进文案。
 *
 *  只认**整串以该前缀开头**的形态,不做子串匹配:CLI 自己的 stderr 里也可能
 *  出现 `WSL_CLI_NOT_FOUND` 之类字样,那不是宿主的错误码。 */
const WSL_ERROR_PREFIXES: [prefix: string, key: string][] = [
  ["WSL_NOT_INSTALLED", "wsl.error.notInstalled"],
  ["WSL_DISTRO_NOT_FOUND", "wsl.error.distroNotFound"],
  ["WSL_START_TIMEOUT", "wsl.error.startTimeout"],
  ["WSL_PROBE_FAILED:", "wsl.error.probeFailed"],
  ["WSL_CLI_NOT_FOUND:", "wsl.error.cliNotFound"],
  ["WSL_CLI_NOT_EXECUTABLE:", "wsl.error.cliNotExecutable"],
  ["WSL_CWD_NOT_FOUND:", "wsl.error.cwdNotFound"],
  ["WSL_SESSION_UNREADABLE", "wsl.error.sessionUnreadable"],
  ["WSL_SESSION_TOO_LARGE:", "wsl.error.sessionTooLarge"],
  ["WSL_TRANSCRIPT_TIMEOUT:", "wsl.error.transcriptTimeout"],
  ["WSL_TRANSCRIPT_UNREADABLE:", "wsl.error.transcriptDecode"],
  ["WSL_SHORT_CALL_TIMEOUT:", "wsl.error.shortCallTimeout"],
  ["WSL_SHORT_CALL_FAILED:", "wsl.error.shortCallFailed"],
  ["WSL_CLI_PATH_INVALID:", "wsl.cliPathInvalid"],
  ["WSL_CLI_FILE_TOO_LARGE:", "wsl.cli.fileTooLarge"],
  ["WSL_CLI_CONFIG_CONFLICT:", "wsl.cli.configConflict"],
  ["WSL_CLI_CONFIG_INVALID_JSON:", "wsl.cli.configInvalid"],
  ["WSL_CLI_CONFIG_INVALID_TOML:", "wsl.cli.configInvalid"],
  ["WSL_CLI_CONFIG_WRITE_FAILED:", "wsl.cli.configWriteFailed"],
  ["WSL_CLI_CONFIG_READ_FAILED:", "wsl.cli.configReadFailed"],
  ["WSL_EXIT_UNPROVEN:", "wsl.error.exitUnproven"],
  ["WSL_RG_MISSING", "wsl.error.generic"],
];

/** 前缀后面紧跟的是名字(CLI / 发行版内路径),不是自由文本。 */
const WSL_NAME_KEYS = new Set([
  "wsl.error.cliNotFound",
  "wsl.error.cliNotExecutable",
  "wsl.cli.fileTooLarge",
  "wsl.cli.configConflict",
]);

/** 需要保留完整路径的 key(cwd 缺失时用户要靠路径定位目录)。 */
const WSL_PATH_KEYS = new Set(["wsl.error.cwdNotFound"]);

function wslErrorText(text: string): string | null {
  for (const [prefix, key] of WSL_ERROR_PREFIXES) {
    if (!text.startsWith(prefix)) continue;
    const detail = prefix.endsWith(":") ? text.slice(prefix.length).trim() : "";
    const vars: Record<string, string> = {};
    if (key === "wsl.error.sessionUnreadable") {
      // 脚本只能报「不可读」,没有文件名;文案只给发行版内会话这一事实,
      // 不假装知道路径。
    } else if (key === "wsl.error.sessionTooLarge") {
      Object.assign(vars, sizeVars(detail));
    } else if (key === "wsl.cliPathInvalid") {
      // 细节是原因代码(notAbsolute / mntPath / …),翻成文案再插进模板;
      // 未知代码原样展示,不编一句看不懂的中文。
      const reasonKey = `wsl.cliPathReason.${detail}`;
      const reason = i18n.t(reasonKey);
      vars.message = reason && reason !== reasonKey ? reason : detail;
    } else if (WSL_PATH_KEYS.has(key)) {
      vars.name = detail;
      vars.path = detail;
    } else if (WSL_NAME_KEYS.has(key)) {
      vars.name = detail.split(/[\\/]/).pop() || detail;
      vars.path = detail;
    } else {
      vars.message = detail;
    }
    const localized = i18n.t(key, vars);
    // 语言资源缺失时 i18next 返回 key 本身:宁可展示原文,不展示裸 key。
    return localized && localized !== key ? localized : null;
  }
  // 未登记的 `WSL_*`:至少给出通用文案,不把裸英文码丢给用户(§10 P2-2)。
  if (text.startsWith("WSL_")) {
    const localized = i18n.t("wsl.error.generic", { message: text });
    return localized && localized !== "wsl.error.generic" ? localized : null;
  }
  return null;
}

/** `<used>:<limit>` 字节数 → i18n 变量。解析失败时原样带回,不编数字。 */
function sizeVars(detail: string): { size: string; limit: string } {
  const [used, limit] = detail.split(":");
  const format = (value: string | undefined) => {
    const n = Number(value);
    return Number.isFinite(n) && n >= 0 ? formatFileSize(n) : (value ?? "");
  };
  return { size: format(used), limit: format(limit) };
}

/**
 * Normalize an unknown thrown value to displayable text. Tauri command
 * errors arrive as plain strings or serialized objects, so Error.message
 * alone is not enough; unstringifiable values degrade to String().
 */
export function errorText(err: unknown): string {
  const text = typeof err === "string" ? err : err instanceof Error ? err.message : null;
  if (text !== null) {
    const wsl = wslErrorText(text);
    if (wsl !== null) return wsl;
    const prefix = "CCGUI_PROVIDER_MIGRATION_CONFLICT:";
    if (text.startsWith(prefix)) {
      try {
        const detail = JSON.parse(text.slice(prefix.length));
        if (typeof detail.path === "string" && typeof detail.backup === "string") {
          return i18n.t("settings.cliMigrationConflict", { path: detail.path, backup: detail.backup }) || text;
        }
      } catch { /* Preserve malformed/unknown backend errors verbatim. */ }
    }
    if (text === "Invalid Codex channel config.toml") {
      return i18n.t("settings.cliCodexConfigInvalid") || text;
    }
    return text;
  }
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

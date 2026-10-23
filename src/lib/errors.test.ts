import { expect, it } from "vitest";
import i18n from "./i18n";
import { errorText } from "./errors";

it("localizes provider migration conflicts from native and web errors", async () => {
  const path = "D:\\配置\\config.toml";
  const backup = "D:\\备份\\config.toml";
  const message = "CCGUI_PROVIDER_MIGRATION_CONFLICT:" + JSON.stringify({ path, backup });
  await i18n.changeLanguage("zh");
  expect(errorText(message)).toContain("旧版渠道配置无法自动恢复");
  expect(errorText(message)).toContain(path);
  await i18n.changeLanguage("en");
  expect(errorText(new Error(message))).toContain("Both files have been preserved");
  expect(errorText(new Error(message))).toContain(backup);
});

it("preserves unknown and malformed errors", () => {
  expect(errorText("CCGUI_PROVIDER_MIGRATION_CONFLICT:invalid")).toBe("CCGUI_PROVIDER_MIGRATION_CONFLICT:invalid");
  expect(errorText(new Error("disk full"))).toBe("disk full");
});

it("localizes stable WSL error codes and keeps their detail", async () => {
  await i18n.changeLanguage("zh");
  // 探测失败:原文里的细节保留在文案里,用户能据此排查。
  expect(errorText("WSL_PROBE_FAILED:bash: /bin/bash: No such file")).toContain(
    "/bin/bash: No such file",
  );
  // CLI 缺失:只取 basename,不让整条路径塞进提示。
  expect(errorText("WSL_CLI_NOT_FOUND:/home/u/.nvm/bin/codex")).toContain("codex");
  expect(errorText("WSL_CLI_NOT_FOUND:/home/u/.nvm/bin/codex")).not.toContain("/home/u");
  await i18n.changeLanguage("en");
  expect(errorText(new Error("WSL_NOT_INSTALLED"))).toContain("WSL was not found");
  expect(errorText("WSL_DISTRO_NOT_FOUND")).toContain("does not exist");
  expect(errorText("WSL_START_TIMEOUT")).toContain("took too long");
  // 子串/残留前缀不是宿主错误码:原样展示,不误伤引擎自己的报错。
  expect(errorText("claude exited with status 1: WSL_CLI_NOT_FOUND:x")).toBe(
    "claude exited with status 1: WSL_CLI_NOT_FOUND:x",
  );
});

it("localizes launcher exit codes (cwd missing / not executable)", async () => {
  await i18n.changeLanguage("zh");
  // 61:工作区目录不存在。发行版内路径要完整保留(用户靠它定位)。
  const cwd = errorText("WSL_CWD_NOT_FOUND:/home/me/gone");
  expect(cwd).toContain("/home/me/gone");
  expect(cwd).toContain("根目录");
  // 126:CLI 不可执行,只给名字,不给整条路径。
  const notExec = errorText("WSL_CLI_NOT_EXECUTABLE:/home/u/.local/bin/codex");
  expect(notExec).toContain("codex");
  expect(notExec).not.toContain("/home/u");
  expect(notExec).toContain("chmod");
  await i18n.changeLanguage("en");
  expect(errorText("WSL_CWD_NOT_FOUND:/home/me/gone")).toContain(
    "was not found inside the distro",
  );
});

it("localizes WSL transcript and short-call failures", async () => {
  await i18n.changeLanguage("zh");
  // 会话文件不可读:脚本只给稳定标记,文案给出下一步,不出现裸标记。
  expect(errorText("WSL_SESSION_UNREADABLE")).toContain("会话文件不可读");
  // 字节数换算成与文件大小一致的展示口径。
  const tooLarge = errorText(`WSL_SESSION_TOO_LARGE:${600 * 1024 * 1024}:${512 * 1024 * 1024}`);
  expect(tooLarge).toContain("600.0 MB");
  expect(tooLarge).toContain("512.0 MB");
  // 短调用超时/失败:保留诊断细节。
  expect(errorText("WSL_SHORT_CALL_TIMEOUT:30")).toContain("超时");
  expect(errorText("WSL_SHORT_CALL_FAILED:退出码 Some(3): bash: no such file")).toContain(
    "no such file",
  );
  await i18n.changeLanguage("en");
  expect(errorText("WSL_TRANSCRIPT_TIMEOUT:180")).toContain("timed out");
  expect(errorText("WSL_SHORT_CALL_FAILED:exit 3")).toContain("failed");
});

it("localizes the settings CLI-path rejection reasons", async () => {
  await i18n.changeLanguage("zh");
  // 后端只给原因代码,文案在 i18n 里 —— 设置页的 role="alert" 不能出现英文原句。
  expect(errorText("WSL_CLI_PATH_INVALID:notAbsolute")).toContain("绝对路径");
  expect(errorText("WSL_CLI_PATH_INVALID:mntPath")).toContain("/mnt/");
  expect(errorText("WSL_CLI_PATH_INVALID:controlChars")).toContain("控制字符");
  // 未知原因代码原样展示,不编文案。
  expect(errorText("WSL_CLI_PATH_INVALID:futureReason")).toContain("futureReason");
  await i18n.changeLanguage("en");
  expect(errorText("WSL_CLI_PATH_INVALID:notAbsolute")).toContain("absolute path");
});

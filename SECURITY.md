# Security Policy（安全策略）

ccgui is a desktop client that drives AI coding CLIs on your machine. It can read and write files, run terminals and git, and expose itself to other devices through remote access. We treat any way for someone else to use those abilities without the user's consent as a security issue.

ccgui 是在你本机驱动 AI 编程 CLI 的桌面客户端，能读写文件、运行终端和 git，还能通过远程访问开放给其他设备。凡是别人能在用户不知情、未同意的情况下动用这些能力的问题，我们都按安全问题处理。

---

## Supported versions（支持的版本）

Only the latest release receives security fixes. Fixes ship in the next version; older versions don't get separate patches. Update through the in-app updater or from [Releases](https://github.com/zhukunpenglinyutong/desktop-cc-gui/releases).

只有最新发布的版本接收安全修复。修复随下一个版本发布，不为旧版本单独打补丁。请通过应用内更新或 [Releases](https://github.com/zhukunpenglinyutong/desktop-cc-gui/releases) 升级。

---

## Reporting a vulnerability（报告漏洞）

**Do not report security problems in public issues, discussions or PRs.** Report privately through GitHub instead: [Report a vulnerability](https://github.com/zhukunpenglinyutong/desktop-cc-gui/security/advisories/new).

**请不要在公开的 Issue、讨论区或 PR 里报告安全问题。** 请通过 GitHub 私密提交：[Report a vulnerability](https://github.com/zhukunpenglinyutong/desktop-cc-gui/security/advisories/new)。

Please include / 请尽量提供：

- ccgui version and OS, plus the engine and CLI version if relevant / ccgui 版本和系统，涉及引擎时附上引擎及 CLI 版本
- the affected area (e.g. Markdown rendering, plugin install, remote access, updater) / 受影响的模块（如 Markdown 渲染、插件安装、远程访问、自动更新）
- steps to reproduce or a proof of concept / 复现步骤或 PoC
- what an attacker gains and what they need first (a malicious repo, a crafted plugin, LAN access, …) / 攻击者能得到什么、需要什么前提（恶意仓库、构造的插件、处于同一局域网等）

Don't include real API keys, tokens or private conversations in the report.

报告里不要包含真实的 API Key、token 或私密对话。

---

## What happens next（处理流程）

1. We acknowledge the report within 3 business days. / 3 个工作日内确认收到。
2. We give an initial assessment (confirmed or not, severity, plan) within 7 days. / 7 天内给出初步评估：是否确认、严重程度、处理计划。
3. The fix lands on the current version branch and ships in the next release. / 修复合入当前版本分支，随下一个版本发布。
4. After the release we publish a GitHub Security Advisory and note it in the release notes, crediting the reporter unless they prefer otherwise. / 发版后发布 GitHub Security Advisory 并写进版本记录；除非报告者不希望署名，否则会致谢。

Please keep the details private until the fixed version is out. If you haven't heard back within 7 days, open an issue that only asks us to check the security advisories, with no details.

在修复版本发布前请不要公开细节。如果 7 天内没有收到回复，可以开一个 Issue 提醒我们查看安全报告，但不要写任何漏洞细节。

---

## Scope（范围）

### In scope（属于安全问题）

- **Code execution from content**: AI output, Markdown, file previews, repository contents or session history that run script in the app's webview. Script there can reach Tauri IPC, so this is the most serious class.
- **Files and commands**: path traversal, or command injection through crafted file names, branch names, workspace paths or engine output; reading or writing outside what the user opened.
- **Remote access** (LAN access, and internet access through the relay): reaching sessions, terminals or files without a valid token or pairing key, leaking those credentials, or the service starting when the user hasn't enabled it.
- **Credential exposure**: API keys, OAuth tokens or provider settings showing up in logs, exports, analytics or error messages.
- **Updates and plugin installs**: bypassing the updater's signature check; installing or enabling a plugin without the install confirmation (code diff and permission list); escaping quarantine; getting the marketplace "verified" badge without a valid signature; a Tier-0 declarative plugin running JavaScript.
- **Approval bypass**: ccgui running a tool call, command or file change without the approval that the selected permission mode requires.

- **内容触发代码执行**：AI 输出、Markdown、文件预览、仓库内容或会话历史在应用 webview 里执行了脚本。webview 中的脚本能调用 Tauri IPC，这是最严重的一类。
- **文件与命令**：路径穿越，或通过构造的文件名、分支名、工作区路径、引擎输出实现命令注入；读写了用户打开范围之外的内容。
- **远程访问**（内网访问，以及经中继的外网访问）：没有有效 token 或配对密钥就能访问会话、终端或文件；这些凭据泄露；用户没开启时服务却被启动。
- **凭据泄露**：API Key、OAuth token 或服务商配置出现在日志、导出文件、统计数据或错误信息里。
- **更新与插件安装**：绕过自动更新的签名校验；不经安装确认（代码 diff 与权限清单）就安装或启用插件；绕过隔离区（quarantine）；没有有效签名却拿到插件市场的「已验证」徽章；Tier-0 声明式插件执行了 JavaScript。
- **绕过审批**：在当前权限模式要求审批的情况下，ccgui 未经用户同意就执行了工具调用、命令或文件修改。

### Out of scope（不属于本项目的安全问题）

- **Bugs in the engines themselves** (Claude Code, Codex, Gemini CLI, …): report them to their vendors. If ccgui makes things worse, for example by passing unsafe flags or turning off a CLI's own protections, that is in scope.
- **What an agent does in a mode that doesn't ask first** (such as 「全部跳过」/ bypass), including prompt injection that stays within that mode.
- **JS plugins (Tier-1/Tier-2) reaching IPC around the `ctx` permission facade.** Plugins share the webview with the app; the facade is a review aid, not a sandbox (see [plugin guide §7](docs/plugin-development-guide.zh-CN.md#7-权限规范)). The protection is install-time review and confirmation.
- Attacks that need prior control of the user's account or machine, or edits to the user's own config files.
- Scanner output or missing hardening without a demonstrated impact, and self-XSS.

- **引擎自身的漏洞**（Claude Code、Codex、Gemini CLI 等）：请报告给对应厂商。如果是 ccgui 让情况变得更糟（比如传入不安全的参数、关掉了 CLI 自带的防护），则属于本项目范围。
- **在不先询问的模式下（如「全部跳过」）Agent 做的事**，包括该模式内的提示词注入。
- **JS 插件（Tier-1/Tier-2）绕过 `ctx` 权限门面直接调用 IPC。** 插件和应用共用同一个 webview，权限门面是评审辅助，不是沙箱（见[插件开发指南第 7 节](docs/plugin-development-guide.zh-CN.md#7-权限规范)）；真正的防线是安装时的评审与确认。
- 需要事先控制用户账号或电脑、或者修改用户自己配置文件才能成立的攻击。
- 没有实际影响的扫描器结果或「缺少某项加固」，以及 self-XSS。

---

## Staying safe（安全使用建议）

- Download ccgui only from [GitHub Releases](https://github.com/zhukunpenglinyutong/desktop-cc-gui/releases) or the project's [AtomGit mirror](https://atomgit.com/zhukunpenglinyutong/desktop-cc-gui). The in-app updater verifies update signatures.
- Install plugins only from sources you trust, and read the permission list. Treat `exec:*`, `network:*` and `prompt.contribute.internal` with care.
- Turn remote access off when you're not using it, and rotate the pairing key if it was shared.

- 只从 [GitHub Releases](https://github.com/zhukunpenglinyutong/desktop-cc-gui/releases) 或项目的 [AtomGit 镜像](https://atomgit.com/zhukunpenglinyutong/desktop-cc-gui) 下载 ccgui。应用内更新会校验更新包签名。
- 只安装可信来源的插件，安装前看清权限清单；`exec:*`、`network:*`、`prompt.contribute.internal` 这几类要格外留意。
- 不用远程访问时把它关掉；配对密钥给别人看过的话，记得重新生成。

Thank you for helping keep ccgui and its users safe. / 感谢你帮助 ccgui 和它的用户保持安全。

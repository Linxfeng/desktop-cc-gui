# Contributing to ccgui（贡献指南）

Thanks for helping make ccgui better. This page covers how a change gets into the repo. For environment setup and a tour of the code, see the README.

感谢你参与 ccgui。本文说明一个改动怎样进入仓库；环境搭建和代码结构请看 README。

- Setup / 启动教程：[English](README.md#getting-it-running-setup-guide) · [中文](README.zh-CN.md#把项目跑起来启动教程)
- Security issues / 安全问题：do not open a public issue, see [SECURITY.md](SECURITY.md) · 不要公开提 Issue，请看 [SECURITY.md](SECURITY.md)

---

## Before you start（动手之前）

- **Bugs**: open an [issue](https://github.com/zhukunpenglinyutong/desktop-cc-gui/issues) with your ccgui version, OS, the engine involved (Claude Code, Codex, …), steps to reproduce, and what you expected. Logs and screenshots help; remove API keys and private conversation content first.
- **Large features or behavior changes**: open an issue and agree on the approach before writing code, so the work doesn't end up in a PR that can't be merged.
- **UI changes that come down to taste** (moving controls, reworking layouts, changing default interactions): consider shipping them as a plugin through the [plugin SDK](docs/plugin-development-guide.zh-CN.md). PRs that reshape the default experience are usually not merged even when the code is fine; a plugin lets the people who want it opt in.

- **报 Bug**：开 [Issue](https://github.com/zhukunpenglinyutong/desktop-cc-gui/issues)，写清 ccgui 版本、系统、涉及的引擎（Claude Code、Codex 等）、复现步骤和预期结果。日志、截图很有帮助，贴之前先去掉 API Key 和私密对话内容。
- **大功能或行为改动**：先开 Issue 对齐方案再写代码，免得做完合不进来。
- **偏个人审美的界面改动**（挪按钮、改布局、换默认交互）：建议用[插件 SDK](docs/plugin-development-guide.zh-CN.md) 做成插件。改变默认体验的 PR 即使代码没问题通常也不会合并；做成插件，想要的人自己装。

---

## Branches and versions（分支与版本）

| Branch / 分支 | Purpose / 用途 |
| --- | --- |
| `main` | Stable release branch. Only the maintainer merges into it, from a version branch, at release time. / 稳定发版分支，只在发版时由维护者从版本分支合入。 |
| `vX.Y.Z` (e.g. `v1.1.9`) | The version in progress. Every feature and fix PR targets the newest one. / 正在迭代的版本，所有功能和修复 PR 都合到最新的这个。 |
| `feat/xxx`, `fix/xxx` | Your working branch, cut from the newest `vX.Y.Z`. / 你的工作分支，从最新的 `vX.Y.Z` 切出。 |

1. Find the `vX.Y.Z` branch with the highest version number in the [branch list](https://github.com/zhukunpenglinyutong/desktop-cc-gui/branches).
2. Branch from it: `git switch -c fix/xxx origin/vX.Y.Z`.
3. Open the PR against that branch, **not `main`**. A CI check fails PRs aimed at `main` and comments with the suggested base. To fix it, click **Edit** on the PR and change the base; a rebase is usually not needed.

When a version is done, the maintainer merges it into `main`, tags `vX.Y.Z` and publishes the release. Development then continues on the next version branch.

1. 在[分支列表](https://github.com/zhukunpenglinyutong/desktop-cc-gui/branches)里找版本号最高的 `vX.Y.Z` 分支。
2. 从它切出工作分支：`git switch -c fix/xxx origin/vX.Y.Z`。
3. PR 合到这个分支，**不要合到 `main`**。CI 会拦下指向 `main` 的 PR，并在评论里给出建议的目标分支；点 PR 顶部的 **Edit** 改一下目标分支即可，一般不用 rebase。

一个版本完成后，维护者把它合入 `main`、打 `vX.Y.Z` 标签并发版，之后在下一个版本分支上继续开发。

---

## Making changes（改代码）

The README's [coding rules](README.md#coding-rules) (i18n, strict TypeScript, no secrets, …) apply. On top of them:

- **Put behavior where it belongs.** Features in `src/features/<feature>`, shared UI in `src/components`, native work in `src-tauri/src`, the plugin contract in `packages/plugin-sdk`. Engine differences are handled in the engine adapter layer, not with engine checks scattered through the UI.
- **Fix the root cause.** If the same cause shows up in several places, fix them together. For bugs, add a test that fails before the fix and passes after it whenever you can.
- **IPC commands, event payloads, plugin contract**: when you change one, check the producer, every consumer and the failure path. No empty stubs, swallowed errors or fake success.
- **Plugin SDK, extension points or permissions**: run `pnpm plugin-skill:docs` and commit the regenerated `src-tauri/resources/skills/ccgui-plugin-creator/references/sdk-api.md`. `pnpm test` fails when it's stale.
- **User-visible feedback, base components, animation timing**: follow [docs/ui-ux-spec.zh-CN.md](docs/ui-ux-spec.zh-CN.md), and update it in the same PR if you change that behavior.
- **Logs** keep enough context to debug, but never credentials or full user conversations. Remove temporary debug output before pushing.
- **One topic per PR.** No drive-by refactors or reformatting of unrelated files.

README 里的[开发规范](README.zh-CN.md#开发规范)（i18n、TypeScript 严格模式、不提交密钥等）照常适用，另外：

- **行为放在负责它的模块里。** 功能放 `src/features/<功能>`，通用 UI 放 `src/components`，原生能力放 `src-tauri/src`，插件契约放 `packages/plugin-sdk`。引擎差异在引擎适配层处理，不要在 UI 里到处写引擎特判。
- **从根因修。** 同一个根因影响多处就一起修。修 Bug 尽量补一个修复前失败、修复后通过的测试。
- **IPC 命令、事件格式、插件契约**：改动时同时检查生产方、所有消费方和失败路径。不用空实现、吞异常或假成功糊过去。
- **插件 SDK、扩展点或权限**：跑 `pnpm plugin-skill:docs`，把重新生成的 `src-tauri/resources/skills/ccgui-plugin-creator/references/sdk-api.md` 一起提交。生成物过期时 `pnpm test` 会失败。
- **用户可见的交互反馈、基础组件、动效时长**：以 [docs/ui-ux-spec.zh-CN.md](docs/ui-ux-spec.zh-CN.md) 为准；改了这类行为，同一个 PR 里更新该文档。
- **日志**保留排查所需的上下文，但不能输出凭据或完整的用户对话。推送前清掉临时调试输出。
- **一个 PR 只做一件事。** 不顺手重构或格式化无关文件。

---

## Using AI coding agents（用 AI 写代码）

AI-assisted contributions are welcome; much of this project is built that way. [AGENTS.md](AGENTS.md) holds the rules for coding agents in this repo, so point your agent at it. You are still the author: read the whole diff, run the checks yourself, and be ready to explain any line during review.

欢迎用 AI 辅助贡献，这个项目本身大量是这样写出来的。[AGENTS.md](AGENTS.md) 是给编码 Agent 的项目约定，请让你的 Agent 读它。作者仍然是你：自己读完整个 diff、亲手跑验证，评审时能解释每一行。

---

## Checking your work（自测）

Run what your change touches / 按改动范围选择：

| Changed / 改了什么 | Run / 运行 |
| --- | --- |
| Frontend, TypeScript / 前端 | `pnpm build` (typecheck + build / 类型检查与构建), `pnpm test` |
| Rust (`src-tauri`) | `cargo test --manifest-path src-tauri/Cargo.toml [filter]` |
| Streaming, Markdown, render caches / 流式输出、Markdown、渲染缓存 | `pnpm test:node` (also run first by `pnpm test` / `pnpm test` 也会先跑它) |
| Docs only / 只改文档 | Check the rendered result; no build needed / 检查渲染效果即可，不必构建 |

- For behavior changes, also run the app with `pnpm dev` and try it. Green tests don't by themselves mean the problem is fixed.
- `pnpm test` needs Node 22.13+: it runs the `node --test` suite first, which uses `--experimental-strip-types` and `module.stripTypeScriptTypes`. `pnpm plugin-skill:docs` needs Node 22.6+; the app itself builds on Node 20+.

- 改了行为，还要用 `pnpm dev` 把应用跑起来实际试一遍。测试全绿不等于问题已经解决。
- `pnpm test` 需要 Node 22.13 及以上：它会先跑 `node --test` 那组测试，用到 `--experimental-strip-types` 和 `module.stripTypeScriptTypes`。`pnpm plugin-skill:docs` 需要 Node 22.6 及以上；应用本身 Node 20+ 即可构建。

---

## Opening a pull request（提 PR）

- **Base branch**: the newest `vX.Y.Z` (see above).
- **Title**: commit format, `type(scope): summary`. See [Writing commit messages](README.md#writing-commit-messages). Chinese is preferred, English is fine. No emoji, no AI attribution lines.
- **Description** (the PR template has the sections): the problem and why it matters, the linked issue, how you verified it (commands and manual steps), and anything not covered or known limits.
- **UI changes**: add before/after screenshots or a short recording.
- **Don't** bump the version or edit the in-app release notes (`src/version/changelog.ts`); the maintainer does that at release time.

- **目标分支**：最新的 `vX.Y.Z`（见上文）。
- **标题**：按 commit 格式写 `type(scope): 摘要`，详见 [Commit 信息怎么写](README.zh-CN.md#commit-信息怎么写)。优先中文，英文也可以。不加 emoji，不带 AI 署名。
- **描述**（PR 模板里有对应小节）：解决了什么问题、为什么要改、关联的 Issue、怎么验证的（命令和手动步骤）、哪些没覆盖或有什么已知限制。
- **界面改动**：附改动前后的截图或一段录屏。
- **不要**改版本号或应用内版本记录（`src/version/changelog.ts`），这些由维护者在发版时处理。

---

## Review and merge（评审与合并）

The maintainer reviews every PR by hand and looks at logic and edge cases, not only style, so expect questions. A PR may be declined when it changes a settled product decision or overlaps work already on the version branch; we'll explain why and suggest a plugin when that fits. Merged changes ship with the release of that version branch.

每个 PR 都由维护者人工评审，看的是逻辑和边界情况，不只是代码风格，所以可能会有不少提问。如果 PR 改动了已定的产品决策，或者和版本分支上已有的工作重叠，可能不会合并；我们会说明原因，合适的话建议做成插件。合并后的改动随该版本分支一起发布。

---

## License（许可）

By contributing, you agree that your contribution is licensed under the project's [MIT License](LICENSE). Only submit code you wrote or have the right to share. If you bring in third-party code or assets, keep their license and copyright notice and say so in the PR.

提交贡献即表示你同意贡献内容以本项目的 [MIT 许可](LICENSE) 授权。只提交你自己写的、或有权分享的代码。引入第三方代码或素材时，保留其许可与版权声明，并在 PR 里说明来源。

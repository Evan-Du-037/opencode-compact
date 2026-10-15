# OpenCode Compact 交接表单

适配 **OpenCode v2.0.26 终端界面**，使用公开插件接口，不修改 OpenCode 源码。v1 用户请使用仓库历史中的旧版本。

输入 `/compact` 或 `/summarize` 后，在一个多行输入框中直接写下本次压缩要求。可以描述后续重点、哪些历史需要保留原文、哪些可以省略，无需按固定栏目填写。

**Ctrl+S 立即关闭表单并返回主界面，后台继续压缩。** 完成或失败时显示简短提示。失败保留草稿；成功清除。没有原文选择器、额外 subagent、进度弹窗或二次确认。

手动压缩使用提交表单时界面当前选择的提供商、模型和推理档位。切换模型后可以直接 `/compact`，无需先发送消息或空按 Enter。插件会先将选择提交到会话，再使用该模型生成摘要；模型切换失败则停止，不会回退旧模型。自动压缩仍使用 OpenCode 为压缩选定的模型。

留空或只输入空白时，完全省略“用户提示”区块；仍使用模板的通用要求，包括“摘要必须连贯、自洽、自成一体”。自动压缩也使用这个模板的通用要求，不弹输入框、不读取草稿，也不复用上次手动输入。触发阈值与 `compaction.auto` 开关仍由 OpenCode 控制。

## 编辑操作

- ↑ / ↓ 在文本内移动，支持自动折行和滚动；末行按 ↓ 选中“开始压缩”，Enter 提交；↑ 返回文本末尾。
- Tab / Shift+Tab 在输入框和按钮间切换；输入框内 Enter 换行。
- Ctrl+C 清空输入框；Ctrl+Z 撤销，包括撤销清空。
- Esc 保存草稿并关闭，同一会话再次打开时恢复。
- Ctrl+E 用 `$VISUAL` / `$EDITOR` 编辑原始输入，保存退出后回填；Ctrl+S 或 Ctrl+Enter 提交。

草稿保存在当前 TUI 进程内，退出后不保留；不同会话互不影响。撤销历史只在当前打开的输入框内有效。

## 微调压缩提示词

编辑根目录 `compact-prompt.md`，每次手动或自动压缩都会重新读取，不需要重启。

保留一个占位符及其条件标记：

```text
{{#instructions}}
## 用户提示
{{instructions}}
{{/instructions}}
```

留空时整个条件块被删除，包括标题与说明。可以修改块内外措辞；不要嵌套条件块或重复占位符。用户输入按原文插入，不被当成模板语法。模板缺失或格式错误会报错；手动压缩保留草稿，自动压缩保留历史并停止当前执行。

## 安装和 v1 迁移

需要 Node.js、npm 和 OpenCode v2.0.26：

```bash
cd ~/Tools/opencode-compact
bash install.sh
opencode reload
```

然后关闭并重新打开 OpenCode 终端界面。v2 通常连接后台服务，仅关闭窗口未必重新加载后端；`opencode reload` 会重新读取服务端配置。

安装器向 `opencode.json(c)` 的 `plugins` 添加本插件**目录**。v2 从目录中的 `server.ts` / `tui.tsx` 分别加载后端和终端入口；不需要额外配置 CLI 插件。安装器同时移除本插件在 `opencode.json(c)`、`cli.json(c)`、旧 `tui.json(c)` 中的重复或 v1 文件入口，保留其他设置、插件和 JSONC 注释，修改前创建备份。

```bash
bash install.sh --check
bash install.sh --uninstall
bash install.sh --config-dir /tmp/opencode-compact-config
```

依赖锁定到测试版本；其他 2.x 可加 `--allow-untested` 自行验证。Web/桌面聊天界面不包含这个终端表单。远程连接需要服务端与终端两侧都能加载插件，模板位于服务端。

## v2 实现与边界

1. TUI 接管手动 `session.compact` 命令，提交时通过 `ui.model.current()` 读取当前选择，并通过 v2 RPC 发送单次输入和模型选择。
2. 后端读取模板，生成唯一请求 ID，通过 `session.switchModel` 提交模型选择后调用原生 `session.compact`。未携带模型的旧客户端沿用会话模型。
3. `session.hook("compaction")` 区分手动与自动压缩：手动表单请求必须匹配记录 ID，自动压缩每次重新读取模板并传入空提示。v2.0.26 的自动压缩记录在 hook 之后才创建，因此此时没有运行中的手动记录也属于自动路径。自动压缩不会消耗排队中的手动要求；其他入口的手动原生压缩仍沿用默认行为。
4. v2 在 hook 后追加固定摘要模板。因此插件使用公开的 `generate.text` 接口，以模板和 hook 提供的历史生成一次摘要，再设置 `request.result`，跳过原生的额外模型调用。手动表单的显式模型选择优先；自动压缩及未携带模型的旧客户端使用 hook 提供的压缩模型。
5. OpenCode 负责触发自动压缩、写入记录、保留近期上下文和恢复后续执行。手动请求由 RPC 等待完成，TUI 随后显示结果；自动压缩不依赖表单或 RPC。无需 v1 的文件握手、后台实例 ID 或收据文件。

历史以带角色和内容的 JSON 放进生成请求，包含 OpenCode 提供的上一轮 checkpoint。模板和历史作为生成请求的任务内容发送；本插件不宣称改写模型的 system 消息角色。

需要注意：

- 历史范围由 OpenCode 选择；已被原生裁剪或截断的内容无法恢复。原文定位和逐字保留依赖模型遵循提示。
- v2 仍可能在摘要旁保留近期消息；“省略某内容”只控制摘要取舍，不删除历史数据库。
- 手动模板在提交时读取，自动模板在触发时读取；历史在原生压缩实际执行时选取。填写期间会话变化时，使用执行时的历史。
- v2.0.26 的 `generate.text` 只返回文本，不返回 token 用量、费用或结束原因。因此手动和自动自定义摘要的用量都不会计入原生会话统计，也无法通过该接口额外校验输出截断。服务商仍会正常计费。
- 自定义摘要绕过了原生摘要模板的校验和超长历史重试。模型或上下文限制导致失败时，插件报错、不静默丢弃历史；手动请求保留草稿，自动请求停止当前执行。现在自动压缩同样走自定义生成路径，因此也不经过原生摘要的超长历史缩减重试。
- 开始后可使用 OpenCode 原生中止；等待结束或插件退出时会取消尚未完成的生成请求。已完成调用无法撤回。

## 开发验证

```bash
npm ci --ignore-scripts
npm run check
bun scripts/smoke.ts
bun scripts/smoke.ts --auto
bun scripts/smoke.ts --auto --fail
bun scripts/smoke.ts --hold
```

`--hold` 保留隔离服务和本地假模型，输出 `attach.json` 供真实 TUI 测试；`--hold-native` 先停止测试服务，供使用同一隔离环境的 `opencode --standalone` 启动测试。测试不使用真实会话或 API 凭据。

核心文件：`src/tui.tsx`（表单）、`src/compact.ts`（RPC 客户端）、`src/rpc.ts`（协议）、`src/server.ts`（压缩 hook）、`src/prompt.ts`（模板）、`scripts/install.mjs`（安装器）。

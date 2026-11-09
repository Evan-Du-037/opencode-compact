# OpenCode Compact 交接表单

适配 **OpenCode v2.0.26 终端界面**，使用公开插件接口，不修改 OpenCode 源码。v1 用户请使用仓库历史中的旧版本。

输入 `/compact` 或 `/summarize` 后，在一个多行输入框中直接写下本次压缩要求。可以描述后续重点、哪些历史需要保留原文、哪些可以省略，无需按固定栏目填写。

**Ctrl+S 立即关闭表单并返回主界面，后台继续压缩。** 完成或失败时显示简短提示。失败保留草稿；成功清除。没有原文选择器、额外 subagent、进度弹窗或二次确认。

压缩时，主界面输入框上方显示一条活动进度栏，手动和自动压缩共用：显示当前阶段、已耗时，以及分块时已完成的段数和合并轮次。活动条表示正在处理，不代表完成百分比；模型接口无法提供可靠 ETA，因此显示“剩余时间暂无法估计”。状态栏不占用焦点，仍可输入和发送排队消息。

进度从服务端读取，重新打开终端或切回会话也能看到仍在运行的压缩。摘要生成结束便停止计时，显示“摘要已生成”，不会把后续排队对话的时间算进去；失败或取消显示相应状态。结束状态保留约 6 秒后消失。连接异常时显示正在重连，而不是继续显示活动动画。进度接口只传阶段和计数，不传提示词、历史或摘要正文。

手动压缩使用提交表单时界面当前选择的提供商、模型和推理档位。切换模型后可以直接 `/compact`，无需先发送消息或空按 Enter。插件会先将选择提交到会话，再使用该模型生成摘要；模型切换失败则停止，不会回退旧模型。自动压缩仍使用 OpenCode 为压缩选定的模型。

留空或只输入空白时，完全省略“用户提示”区块；仍使用模板的通用要求，包括“摘要必须连贯、自洽、自成一体”。自动压缩也使用这个模板的通用要求，不弹输入框、不读取草稿，也不复用上次手动输入。触发阈值与 `compaction.auto` 开关仍由 OpenCode 控制。

手动和自动压缩都支持上下文超限恢复：正常情况下仍只生成一次摘要；明确收到 `context_length_exceeded` 等超限错误后，自动分块处理并合并成一份最终摘要。已在 OpenCode v2.1.2 的隔离服务中验证。

手动和自动压缩也支持断连重试：遇到 `ECONNRESET`、`EPIPE` 等明确连接中断时，同一请求最多额外重试两次，分别等待 2 秒和 5 秒。进度栏显示倒计时与重试次数；等待期间可用 OpenCode 原生中止，不再继续重试。重试保持原模型和提示词，分块和合并阶段只重试当前失败的请求，已完成结果继续保存在内存中。断连本身不会触发分块。

认证失败、内容审核拒绝、普通限流、含糊的网络错误和超时不会触发这套额外重试；这些错误仍按原有路径处理。断连前服务端可能已执行请求，因此重试可能重复计费。重试计入每次压缩的 64 次插件生成调用上限；持续失败时不提交半截摘要。已在 OpenCode v2.2.6 隔离服务中用真实中断的 HTTP 响应验证。

## 超长历史的处理

1. 将本次 hook 提供的历史按顺序拆成不相交的部分，优先保持完整对话轮次，再按消息拆分；单条消息过长时继续拆分文本。不会通过删除旧消息来缩小输入。
2. 每段携带同一份模板要求，并明确告知模型这只是部分历史；超限的段继续拆小，成功的段不重做。
3. 按历史顺序合并中间摘要，协调后来对早期决定的修改或撤回。合并输入仍超限时继续分层处理，直到得到一份自成一体的摘要。
4. 分段模型标记的保留原文必须与对应历史字符串匹配；通过核对的原文由程序单独携带，最终正文未包含时会逐字附在末尾。原文的定位和跨段理解仍依赖模型，不能保证找到所有所需片段。
5. 所有阶段成功后才提交最终摘要。格式错误、原文不匹配、不可恢复的提供商错误或取消都会停止；不会把部分结果写成成功压缩。

全程使用本次选定的模型，自动压缩不读取手动草稿，也不会创建可见 subagent。分块会增加调用次数和费用；中间摘要仅保存在内存，失败后再次压缩会重新开始。每次最多 64 次插件生成调用、12 层拆分、6 轮合并；过小片段仍超限或摘要不再缩短时停止。为防止异常输出膨胀，分块路径保留原文总计不超过 32000 字符，最终结果不超过 48000 字符；超过会报错而不是截断。这些是工作量和文本大小限制，不等同于模型 token 窗口的精确估算。

主要求仍编辑 `compact-prompt.md`；分块与合并阶段的操作说明分别在 `prompts/fragment.md`、`prompts/merge.md`，进入超限恢复时重新读取。分块说明中的 JSON 输出协议须保留。

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
- 自定义摘要仍绕过原生摘要模板校验及其删减历史重试，由本插件处理超限分块恢复。无法恢复时手动请求保留草稿，自动请求停止当前执行；此前已完成的模型调用仍会计费。分层摘要存在信息损失，JSON 结构和原文匹配校验不能证明模型概括完整、正确。
- 开始后可使用 OpenCode 原生中止；等待结束或插件退出时会取消尚未完成的生成请求。已完成调用无法撤回。

## 开发验证

```bash
npm ci --ignore-scripts
npm run check
bun scripts/smoke.ts
bun scripts/smoke.ts --auto
bun scripts/smoke.ts --auto --fail
bun scripts/smoke.ts --overflow
bun scripts/smoke.ts --auto --overflow
bun scripts/smoke.ts --overflow --overflow-fail
bun scripts/smoke.ts --auto --overflow --overflow-fail
bun scripts/smoke.ts --progress
bun scripts/smoke.ts --auto --progress
bun scripts/smoke.ts --disconnect
bun scripts/smoke.ts --auto --disconnect --overflow
bun scripts/smoke.ts --disconnect --disconnect-always
bun scripts/smoke.ts --auto --disconnect --disconnect-always
bun scripts/smoke.ts --disconnect --disconnect-cancel
bun scripts/smoke.ts --auto --disconnect --disconnect-cancel
bun scripts/smoke.ts --hold
```

`--hold` 保留隔离服务和本地假模型，输出 `attach.json` 供真实 TUI 测试；`--hold-native` 先停止测试服务，供使用同一隔离环境的 `opencode --standalone` 启动测试。测试不使用真实会话或 API 凭据。

`--hold --slow` 为每个模拟摘要调用增加 8 秒延迟，便于观察进度栏和验证压缩期间继续输入。

核心文件：`src/tui.tsx`（表单）、`src/compact.ts`（RPC 客户端）、`src/rpc.ts`（协议）、`src/server.ts`（压缩 hook）、`src/summary.ts`（超限分块与合并）、`src/prompt.ts`（模板）、`scripts/install.mjs`（安装器）。

# 手动压缩使用界面当前模型（2026-10-13）

在 OpenCode v2.0.28 验证，插件 SDK 依赖保持 2.0.26。

- `npm run check`：类型检查通过，23 个测试通过。覆盖提供商、模型、推理档位传递，切换失败时不压缩且可重试，自动压缩不使用排队手动请求的模型。
- `bun scripts/smoke.ts --model-switch`：隔离服务中，会话先使用 `mock/test`，不发送普通消息也不预先切换会话，直接携带 `selected/replacement` 压缩。仅一次摘要调用，实际请求模型为 `replacement`，端点为新提供商的 `/selected/v1/chat/completions`；压缩完成，会话模型同步更新。
- `bun scripts/smoke.ts --auto`：自动压缩及后续 agent 接续正常。
- 真实 110×32 PTY：模型选择器搜索 Selected fixture，确认默认档位，直接 Ctrl+X C 打开本插件表单，留空并 Ctrl+S。界面提示压缩完成，本地模拟模型记录为普通对话 `test`、自定义压缩 `replacement`；中间没有发送普通消息。

所有模型调用均使用本地模拟提供商和隔离测试会话，没有发送用户真实对话或使用真实模型凭据。已有 OpenCode 需执行 `opencode reload` 并重开终端界面，以加载服务端和 TUI 两侧修改。

---

# 自动压缩接管验证（2026-10-12）

当前行为取代下面迁移记录中“自动压缩不使用自定义模板”的历史结论。

- `npm run check`：类型检查通过，20 个测试通过，0 失败。
- `bun scripts/smoke.ts --auto`：真实 OpenCode v2.0.26 在模拟高 token 用量下自动触发；恰好一次自定义摘要调用，不含用户提示区块或原生摘要模板；完成记录保留 auto 原因，后续 agent 调用收到自定义 checkpoint 并继续执行。
- `bun scripts/smoke.ts --auto --fail`：模拟模型拒绝；不写入成功压缩记录，不回退默认摘要，不继续执行后续模型调用。
- `bun scripts/smoke.ts`：手动非空、空白输入回归通过。
- 单元验证自动记录创建前后的分支、排队手动提示不被自动压缩消耗、其他手动入口不变、空摘要和模板缺失失败、插件释放时取消正在生成的自动摘要。

自动压缩不弹表单；保持 OpenCode 原有触发阈值与 auto 开关。模板正文和终端外观未改动。接口统计及重试限制见 README。

---

# v2.0.26 迁移验证（2026-10-11）

- `npm run check`：TypeScript 通过；16 个测试通过，0 失败。
- `bun scripts/smoke.ts`：隔离 OpenCode v2.0.26 服务 + 本地模拟模型；非空与空白输入各一次自定义调用，原生压缩记录成功；请求不含 v2 固定摘要模板，空白输入不含用户提示部分。
- `bun scripts/smoke.ts --auto`：模拟高 token 用量触发真实自动压缩；原生自动压缩成功，未使用自定义模板。
- `bun scripts/smoke.ts --fail`：模型拒绝自定义请求后返回具体错误；没有回退到默认摘要或额外模型调用。
- 真实 PTY `opencode --server ... --session ...`：/compact 打开单输入框；Esc 保存再打开恢复；Ctrl+C 后 Ctrl+Z 恢复内容；Ctrl+S 回主窗口并成功压缩；末行 ↓ 选中唯一按钮，Enter 在空白输入下成功压缩。
- 真实 PTY `opencode --standalone --session ...`：Ctrl+X C 打开表单；Ctrl+E 外部编辑器回填中文和换行；Ctrl+S 压缩成功，模型请求包含编辑器输入。
- 安装器测试：v1 文件入口迁移、v2 目录入口、JSONC 注释和其他插件保留、重复安装、卸载、双扩展名配置，以及无效配置下不部分写入。

已修复 v2 `dialog.show` 重置尺寸造成按钮超出终端的问题：表单挂载后设置大尺寸、居中展示。

真实终端测试使用 110×32 字符窗口。集成测试使用假模型，不代表真实模型的摘要质量测试；未使用用户凭据或真实对话。

v2 `generate.text` 的统计、结束原因和原生重试限制见 README。模板正文未因迁移而修改。

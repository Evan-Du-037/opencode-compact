/** @jsxImportSource @opentui/solid */
import { createSignal, Show, onMount, onCleanup } from "solid-js"
import { useTerminalDimensions } from "@opentui/solid"
import type { TextareaRenderable } from "@opentui/core"
import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui"
import { spawn } from "node:child_process"
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { PLUGIN_ID, type Fields } from "./core.ts"
import { storeRoot } from "./store.ts"
import { compactSession } from "./compact.ts"
import { clearField, moveBetweenFields } from "./form-editing.ts"

const empty: Fields = { instructions: "" }

async function edit(api: TuiPluginApi, fields: Fields) {
  const command = process.env.VISUAL || process.env.EDITOR
  if (!command) throw new Error("未设置 VISUAL 或 EDITOR。可直接在表单填写，或设置 EDITOR='code --wait' 后重新启动。")
  const dir = await mkdtemp(join(tmpdir(), "opencode-compact-editor-")), file = join(dir, "交接要求.md")
  await writeFile(file, fields.instructions, { mode: 0o600 })
  api.renderer.suspend()
  try {
    // The editor command is the user's trusted environment setting. The file is passed as a positional argument.
    await new Promise<void>((resolvePromise, reject) => {
      const child = spawn("/bin/sh", ["-c", `exec ${command} "$1"`, "opencode-compact-editor", file], { stdio: "inherit" })
      child.on("error", reject)
      child.on("exit", code => code === 0 ? resolvePromise() : reject(new Error("编辑器已取消或异常退出，尚未开始压缩。")))
    })
    return { instructions: await readFile(file, "utf8") }
  } finally {
    await rm(dir, { force: true, recursive: true })
    api.renderer.resume(); api.renderer.requestRender()
  }
}

export const tui: TuiPlugin = async (api, options) => {
  const root = storeRoot(options)
  // Drafts belong to a session and live for this TUI process. Successful compaction consumes them.
  const drafts = new Map<string, Fields>()
  const inFlight = new Set<string>()
  let opened = false
  const off = api.keymap.registerLayer({ priority: 100,
    commands: [{ name: "session.compact", namespace: "palette", title: "Compact · 填写交接要求", slashName: "compact", slashAliases: ["summarize"], category: "Session", run() {
      const route = api.route.current
      if (route.name !== "session" || !route.params?.sessionID) { api.ui.toast({ title: "请先打开会话", message: "已有会话才能压缩。", variant: "warning" }); return }
      if (opened) return
      const sessionID = String(route.params.sessionID)
      if (api.state.session.status(sessionID)?.type !== "idle" && api.state.session.status(sessionID)) { api.ui.toast({ title: "会话正在运行", message: "请等待本轮结束后再压缩。", variant: "warning" }); return }
      const directory = resolve(api.state.path.directory)
      const draftKey = `${directory}\0${sessionID}`
      if (inFlight.has(draftKey)) { api.ui.toast({ title: "压缩正在提交", message: "请等待本次压缩完成。", variant: "warning" }); return }
      opened = true
      let submitted = false
      const controller = new AbortController()
      api.ui.dialog.setSize("large")
      api.ui.dialog.replace(() => <Form api={api} controller={controller}
        initial={drafts.get(draftKey) ?? empty} saveDraft={value => drafts.set(draftKey, { ...value })}
        submit={fields => {
          if (submitted) return
          submitted = true
          drafts.set(draftKey, { ...fields })
          inFlight.add(draftKey)
          api.ui.dialog.clear()
          void compactSession({ api, root, directory, sessionID, fields: { ...fields }, signal: controller.signal })
            .then(() => {
              drafts.delete(draftKey)
              api.ui.toast({ title: "压缩完成", message: "本次压缩已完成。", variant: "success" })
            })
            .catch(error => api.ui.toast({ title: "压缩未完成", message: `${error instanceof Error ? error.message : String(error)} 草稿已保留，可重新打开 /compact。`, variant: "error" }))
            .finally(() => inFlight.delete(draftKey))
        }} />, () => { opened = false; if (!submitted) controller.abort() })
    } }],
  })
  api.lifecycle.onDispose(off)
}

function Form(props: { api: TuiPluginApi; controller: AbortController; initial: Fields; saveDraft: (fields: Fields) => void; submit: (fields: Fields) => void }) {
  const { api, controller } = props
  const theme = api.theme.current, dimensions = useTerminalDimensions()
  const [fields, setFields] = createSignal<Fields>({ ...props.initial })
  const [step, setStep] = createSignal<"form" | "editor">("form")
  const [error, setError] = createSignal("")
  const [buttonFocused, setButtonFocused] = createSignal(false)
  let inputs: TextareaRenderable[] = [], focusIndex = 0
  const capture = () => {
    if (step() === "form") setFields({ instructions: inputs[0]?.plainText ?? fields().instructions })
  }
  const focus = (index = focusIndex) => {
    focusIndex = (index + 2) % 2
    setButtonFocused(focusIndex === 1)
    if (buttonFocused()) inputs.forEach(input => input.blur())
    else inputs[focusIndex]?.focus()
  }
  const cancel = () => { capture(); props.saveDraft(fields()); api.ui.dialog.clear() }
  const move = (direction: -1 | 1) => {
    if (step() === "form") {
      focusIndex = moveBetweenFields(inputs, focusIndex, direction, true)
      setButtonFocused(focusIndex === 1)
    }
  }

  async function openEditor() {
    if (step() !== "form") return
    capture(); setStep("editor"); setError("")
    try { setFields(await edit(api, fields())) } catch (e) { setError(String(e)) }
    finally { if (!controller.signal.aborted) { setStep("form"); setTimeout(() => focus(), 10) } }
  }
  const confirm = () => { if (step() === "form") { capture(); props.submit({ ...fields() }) } }

  onMount(() => {
    setTimeout(() => focus(0), 10)
    const off = api.keymap.registerLayer({ priority: 1000, mode: "modal", commands: [
      { name: "compact-form.next", run: () => { if (step() === "form") focus(focusIndex + 1) } },
      { name: "compact-form.prev", run: () => { if (step() === "form") focus(focusIndex - 1) } },
      { name: "compact-form.up", run: () => { if (step() !== "form") return false; move(-1) } },
      { name: "compact-form.down", run: () => { if (step() !== "form") return false; move(1) } },
      { name: "compact-form.clear", run: () => { if (step() === "form") clearField(inputs[focusIndex]) } },
      { name: "compact-form.undo", run: () => { if (step() === "form") inputs[focusIndex]?.undo() } },
      { name: "compact-form.enter", run: () => { if (step() === "form") { if (buttonFocused()) confirm(); else inputs[focusIndex]?.newLine() } } },
      { name: "compact-form.confirm", run: confirm }, { name: "compact-form.cancel", run: cancel },
      { name: "compact-form.editor", run: () => void openEditor() },
    ], bindings: [
      { key: "tab", cmd: "compact-form.next" }, { key: "shift+tab", cmd: "compact-form.prev" },
      { key: "up", cmd: "compact-form.up" }, { key: "down", cmd: "compact-form.down" },
      { key: "ctrl+c", cmd: "compact-form.clear" }, { key: "ctrl+z", cmd: "compact-form.undo" },
      { key: "return", cmd: "compact-form.enter" },
      { key: "ctrl+s", cmd: "compact-form.confirm" }, { key: "ctrl+return", cmd: "compact-form.confirm" },
      { key: "escape", cmd: "compact-form.cancel" }, { key: "ctrl+e", cmd: "compact-form.editor" },
    ] })
    onCleanup(off)
  })
  onCleanup(() => {
    // Read signal state here: child textareas may already have been destroyed by Solid.
    props.saveDraft(fields())
  })

  return <box paddingLeft={2} paddingRight={2} paddingBottom={1} gap={dimensions().height < 30 ? 0 : 1}>
    <text fg={theme.primary}><b>Compact · 本次交接要求</b></text>
    <Show when={error()}><text fg={theme.error} wrapMode="word">{error()}</text></Show>
    <Show when={step() === "form"}>
      <box gap={0}>
        <text fg={theme.text}>本次压缩提示（可留空）</text>
        <box backgroundColor={theme.backgroundElement}>
          <textarea ref={(ref: TextareaRenderable) => { inputs[0] = ref }} initialValue={fields().instructions}
            height={Math.max(2, Math.min(16, Math.floor(dimensions().height * 0.72 - 9)))}
            placeholder="直接写下本次压缩的要求；留空则使用通用压缩要求。"
            textColor={theme.text} focusedTextColor={theme.text} placeholderColor={theme.textMuted} cursorColor={theme.primary}
            onContentChange={() => { const input = inputs[0]; if (input) setFields({ instructions: input.plainText }) }}
            onMouseDown={() => { focusIndex = 0; setButtonFocused(false) }} />
        </box>
      </box>
      <text fg={theme.textMuted}>末行 ↓ 到按钮 · Tab 切换 · Ctrl+C 清空 · Ctrl+Z 撤销</text>
      <text fg={theme.textMuted}>Enter 换行/提交 · Ctrl+E 编辑器 · Ctrl+S 确认 · Esc 保存草稿并关闭</text>
      <box flexDirection="row" gap={3}>
        <text fg={theme.primary} onMouseUp={confirm}>{buttonFocused() ? "▶ [ 开始压缩 ]" : "[ 开始压缩 ]"}</text>
      </box>
    </Show>
    <Show when={step() === "editor"}>
      <text fg={theme.text}>等待编辑器…</text>
      <text fg={theme.textMuted}>保存退出编辑器后返回表单</text>
    </Show>
  </box>
}

export default { id: `${PLUGIN_ID}.tui`, tui } satisfies TuiPluginModule

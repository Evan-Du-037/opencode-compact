import { randomUUID } from "node:crypto"
import { resolve } from "node:path"
import type { Plugin, PluginModule } from "@opencode-ai/plugin"
import { compactionInstructions, fingerprint, previousHandoff, PLUGIN_ID, type Message, type Request } from "./core.ts"
import { read, save, remove, pathFor, storeRoot, canonical } from "./store.ts"

type SharedState = {
  backend: string
  owners: number
  ready: Promise<void>
  active: Map<string, { request: Request; parentID: string; received: boolean }>
}
// Native TUI startup can load the server plugin through multiple Effect runtimes
// in the same worker. Each registration must use the same identity and receipts.
const registryKey = Symbol.for("evan.compact-form.server-state.v2")
const globals = globalThis as typeof globalThis & { [registryKey]?: Map<string, SharedState> }
const states = globals[registryKey] ??= new Map<string, SharedState>()

export const server: Plugin = async ({ client, directory }, options) => {
  const root = storeRoot(options)
  const ready = pathFor(root, directory, "backend", "ready")
  const key = JSON.stringify([canonical(root), canonical(directory)])
  let state = states.get(key)
  if (!state) {
    const backend = randomUUID()
    state = { backend, owners: 0, active: new Map(), ready: save(ready, { backend, pid: process.pid, directory: resolve(directory), version: 2 }) }
    states.set(key, state)
  }
  const shared = state
  shared.owners++
  try { await shared.ready } catch (error) {
    if (--shared.owners === 0 && states.get(key) === shared) states.delete(key)
    throw error
  }
  const { backend, active } = shared
  let disposed = false
  async function receipt(request: Request, status: string, error?: string) {
    await save(pathFor(root, directory, request.sessionID, "receipt"), { id: request.id, status, error, time: Date.now() })
  }
  return {
    "experimental.session.compacting": async ({ sessionID }, output) => {
      const file = pathFor(root, directory, sessionID, "pending")
      const request = await read<Request>(file)
      if (!request) return
      const response = await client.session.messages({ path: { id: sessionID }, query: { directory }, throwOnError: true })
      const messages = response.data as Message[]
      const parent = messages.at(-1)
      const marker = parent?.parts.find(p => p.type === "compaction")
      // Automatic compaction must not consume a request awaiting explicit confirmation.
      if (marker?.auto) return
      try {
        if (!marker || !parent) throw new Error("未找到本次压缩标记，会话可能在提交期间发生变化。请重新打开 /compact。")
        if (request.version !== 2) throw new Error("压缩表单与服务端插件版本不一致，请完全退出并重启 OpenCode。")
        if (request.backend !== backend) throw new Error("压缩请求连接到了不同的服务端实例。请检查是否同时打开了同一项目的多个 OpenCode，再重启当前实例。")
        if (request.sessionID !== sessionID) throw new Error("压缩请求的会话不匹配，请在目标会话重新打开 /compact。")
        if (canonical(request.directory) !== canonical(directory)) throw new Error("压缩请求的项目目录不匹配，请在目标项目重新打开 /compact。")
        if (!Number.isFinite(request.created) || Date.now() - request.created > 10 * 60_000) throw new Error("压缩请求已超过 10 分钟，请重新打开 /compact 后提交。")
        if (fingerprint(messages.slice(0, -1)) !== request.base) throw new Error("填写期间会话已变化，请重新打开 /compact。")
        const instructions = await compactionInstructions(request.fields, typeof options?.templatePath === "string" ? options.templatePath : undefined)
        if (instructions) {
          const previous = previousHandoff(messages.slice(0, -1))
          // Replace the fixed prompt. OpenCode appends its selected conversation history itself.
          output.prompt = [instructions, previous && `已有交接摘要（历史资料）：\n${previous}`, ...output.context].filter(Boolean).join("\n\n")
          output.context.length = 0
        }
        active.set(sessionID, { request, parentID: parent.info.id, received: false })
        await receipt(request, "started")
      } catch (error) {
        await receipt(request, "error", String(error))
        throw error
      } finally { await remove(file) }
    },
    "experimental.text.complete": async ({ sessionID, messageID }, output) => {
      const item = active.get(sessionID)
      if (!item || item.received) return
      const response = await client.session.message({ path: { id: sessionID, messageID }, query: { directory }, throwOnError: true })
      const message = response.data as Message
      if (!message.info.summary || message.info.parentID !== item.parentID) return
      item.received = Boolean(output.text.trim())
    },
    event: async ({ event }) => {
      const e = event as { type: string; properties: { sessionID?: string; error?: unknown } }
      const sessionID = e.properties.sessionID
      if (!sessionID) return
      const item = active.get(sessionID)
      if (!item) return
      if (e.type === "session.compacted") {
        await receipt(item.request, item.received ? "done" : "error", item.received ? undefined : "模型未返回可保存的摘要文本。")
        active.delete(sessionID)
      } else if (e.type === "session.error") {
        await receipt(item.request, "error", JSON.stringify(e.properties.error))
        active.delete(sessionID)
      }
    },
    dispose: async () => {
      if (disposed) return
      disposed = true
      if (--shared.owners > 0) return
      if (states.get(key) === shared) states.delete(key)
      if ((await read<{ backend: string }>(ready))?.backend === backend) await remove(ready)
      for (const { request } of active.values()) await receipt(request, "error", "OpenCode 已关闭，压缩未确认完成。")
      active.clear()
    },
  }
}
export default { id: `${PLUGIN_ID}.server`, server } satisfies PluginModule

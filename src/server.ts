import { randomUUID } from "node:crypto"
import { resolve } from "node:path"
import type { Plugin, PluginModule } from "@opencode-ai/plugin"
import { compactionInstructions, fingerprint, previousHandoff, PLUGIN_ID, type Message, type Request } from "./core.ts"
import { read, save, remove, pathFor, storeRoot, canonical } from "./store.ts"

export const server: Plugin = async ({ client, directory }, options) => {
  const root = storeRoot(options), backend = randomUUID()
  const ready = pathFor(root, directory, "backend", "ready")
  const active = new Map<string, { request: Request; parentID: string; received: boolean }>()
  await save(ready, { backend, pid: process.pid, directory: resolve(directory), version: 2 })
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
        if (!marker || !parent || request.version !== 2 || request.backend !== backend || request.sessionID !== sessionID || canonical(request.directory) !== canonical(directory) || Date.now() - request.created > 10 * 60_000) throw new Error("压缩请求过期或服务端已重启，请重新填写。")
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
      if ((await read<{ backend: string }>(ready))?.backend === backend) await remove(ready)
      for (const { request } of active.values()) await receipt(request, "error", "OpenCode 已关闭，压缩未确认完成。")
      active.clear()
    },
  }
}
export default { id: `${PLUGIN_ID}.server`, server } satisfies PluginModule

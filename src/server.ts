import { Plugin } from "@opencode/plugin"
import { realpath } from "node:fs/promises"
import { randomUUID } from "node:crypto"
import { compactRpc, type CompactInput } from "./rpc.ts"
import { compactionInstructions } from "./prompt.ts"
import { PLUGIN_ID } from "./core.ts"

/** RPC and hooks live in the same v2 location; no filesystem rendezvous or backend IDs. */
export default Plugin.define({
  id: PLUGIN_ID,
  async setup(ctx) {
    const pending = new Map<string, { id: string; prompt: string; model?: CompactInput["model"]; used: boolean; controller: AbortController; error?: string }>()
    const automatic = new Set<AbortController>()
    const templatePath = typeof ctx.options.templatePath === "string" ? ctx.options.templatePath : undefined
    const hook = await ctx.session.hook("compaction", async request => {
      const history = await ctx.session.context({ sessionID: request.sessionID })
      const marker = history.findLast(message => message.type === "compaction" && message.status === "running")
      // v2.0.26 opens a manual record before the hook, but an automatic record AFTER it.
      // No running marker therefore means automatic/overflow compaction, even with a manual RPC queued.
      const manual = marker?.reason === "manual"
      const task = manual ? pending.get(request.sessionID) : undefined
      if (manual && (!task || marker.id !== task.id)) return
      if (task?.used) throw new Error("本次压缩请求已执行。")
      if (task) task.used = true
      const controller = task?.controller ?? new AbortController()
      const monitor = task ? undefined : new AbortController()
      if (monitor) {
        automatic.add(controller)
        // A stopped runner must also cancel its transient automatic-summary request.
        void ctx.session.wait({ sessionID: request.sessionID }, { signal: monitor.signal })
          .then(() => { if (!monitor.signal.aborted) controller.abort() })
          .catch(() => {})
      }
      try {
        const prompt = task?.prompt ?? await compactionInstructions({ instructions: "" }, templatePath)
        // v2 appends a hard-coded template after hooks. Supplying result skips that call.
        // Automatic compaction uses only the template's general requirements, never manual drafts.
        const result = await ctx.generate.text({ model: task?.model ?? request.model, prompt: `${prompt}\n\n<conversation-history>\n${JSON.stringify(request.messages)}\n</conversation-history>` }, { signal: controller.signal })
        if (!result.text.trim()) throw new Error("模型返回了空摘要。")
        request.result = { summary: result.text }
      } catch (error) {
        if (task) task.error = error instanceof Error ? error.message : String(error)
        throw error
      } finally {
        monitor?.abort()
        if (!task) { controller.abort(); automatic.delete(controller) }
      }
    })
    const rpc = await ctx.rpc.register(compactRpc, {
      async compact(value) {
        const { sessionID, instructions, model } = value as CompactInput
        if (pending.has(sessionID)) return { ok: false, error: "此会话已有压缩请求，请等待完成。" }
        const task = { id: `msg_${randomUUID().replaceAll("-", "")}`, prompt: "", model, used: false, controller: new AbortController(), error: undefined as string | undefined }
        pending.set(sessionID, task)
        try {
          const session = await ctx.session.get({ sessionID })
          if (await realpath(session.location.directory) !== await realpath(ctx.location.directory))
            throw new Error("当前会话所属目录与插件实例不一致，请重新打开该会话后重试。")
          task.prompt = await compactionInstructions({ instructions }, templatePath)
          // Like native TUI compaction, commit the composer selection before admission.
          // If this fails, do not silently compact with the old model.
          if (model) await ctx.session.switchModel({ sessionID, model })
          const admitted = await ctx.session.compact({ sessionID, id: task.id })
          if (admitted.id !== task.id) throw new Error("压缩请求与已有请求合并，请等待已有压缩完成后重试。")
          await ctx.session.wait({ sessionID })
          const history = await ctx.session.context({ sessionID })
          const message = history.find(item => item.id === task.id)
          if (message?.type !== "compaction" || message.status !== "completed" || !task.used)
            throw new Error(task.error || (message?.type === "compaction" && message.status === "failed" ? message.error.message : "未找到本次自定义压缩的完成记录。"))
          return { ok: true }
        } catch (error) {
          return { ok: false, error: task.error || (error instanceof Error ? error.message : String(error)) }
        } finally { task.controller.abort(); pending.delete(sessionID) }
      },
    })
    return async () => { for (const controller of automatic) controller.abort(); for (const task of pending.values()) task.controller.abort(); await rpc.dispose(); await hook.dispose() }
  },
})

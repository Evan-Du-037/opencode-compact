import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import { randomUUID } from "node:crypto"
import { fingerprint, visibleHistory, type Fields, type Message, type Request } from "./core.ts"
import { read, remove, pathFor, publish, cancelPending } from "./store.ts"

/** Own the request independently of the form: closing the form must not cancel submission. */
export async function compactSession({ api, root, directory, sessionID, fields, signal }: {
  api: TuiPluginApi; root: string; directory: string; sessionID: string; fields: Fields; signal: AbortSignal
}) {
  let request: Request | undefined
  let snapshot: Message[], model: { providerID: string; modelID: string }, backend: string
  try {
    signal.throwIfAborted()
    const ready = await read<{ backend: string; pid: number; version: number }>(pathFor(root, directory, "backend", "ready"))
    if (!ready) throw new Error("压缩服务端插件尚未加载。请运行安装脚本并重启 OpenCode。")
    try { process.kill(ready.pid, 0) } catch { throw new Error("压缩服务端插件已退出，请重启 OpenCode。") }
    if (ready.version !== 2) throw new Error("压缩服务端仍是旧版本，请完全退出并重启 OpenCode。")
    backend = ready.backend
    const pendingPath = pathFor(root, directory, sessionID, "pending")
    const pending = await read<Request>(pendingPath)
    if (pending && (Date.now() - pending.created > 10 * 60_000 || pending.backend !== backend)) await remove(pendingPath)
    const [history, info] = await Promise.all([
      api.client.session.messages({ sessionID, directory }, { throwOnError: true, signal }),
      api.client.session.get({ sessionID, directory }, { throwOnError: true, signal }),
    ])
    snapshot = visibleHistory(history.data as Message[], info.data!.revert?.messageID)
    if (!snapshot.length) throw new Error("会话为空，没有可压缩的历史。")
    const user = snapshot.findLast(m => m.info.role === "user" && m.info.model)
    if (!user?.info.model) throw new Error("未找到此会话使用的模型，请先发送一条消息。")
    model = user.info.model
    const configured = api.state.config.agent?.compaction?.model
    if (typeof configured === "string") {
      const separator = configured.indexOf("/")
      if (separator > 0) model = { providerID: configured.slice(0, separator), modelID: configured.slice(separator + 1).split("#")[0]! }
    }
    const statusResult = await api.client.session.status({ directory }, { throwOnError: true })
    if (statusResult.data?.[sessionID]?.type && statusResult.data[sessionID]!.type !== "idle") throw new Error("会话正在运行，请等待结束后重新压缩。")
    request = { version: 2, id: randomUUID(), directory, sessionID, created: Date.now(), base: fingerprint(snapshot), fields, backend }
    signal.throwIfAborted()
    await publish(root, request)
    signal.throwIfAborted()
    await api.client.session.summarize({ sessionID, directory, ...model, auto: false }, { throwOnError: true, signal })
    // Event hooks are asynchronous; allow the persisted completion receipt to catch up.
    let receipt: { id: string; status: string; error?: string } | undefined
    for (let i = 0; i < 20; i++) {
      receipt = await read(pathFor(root, directory, sessionID, "receipt"))
      if (receipt?.id === request.id && (receipt.status === "done" || receipt.status === "error")) break
      await new Promise(resolvePromise => setTimeout(resolvePromise, 100))
    }
    if (receipt?.id !== request.id || receipt.status !== "done") throw new Error(receipt?.error || "未收到插件完成回执。请检查会话中的摘要及 OpenCode 日志，不要盲目重复压缩。")
    await remove(pathFor(root, directory, sessionID, "receipt"))
  } finally {
    if (request) await cancelPending(root, request)
  }
}

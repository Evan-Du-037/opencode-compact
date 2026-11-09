/** @jsxImportSource @opentui/solid */
import { createEffect, createSignal, onCleanup, Show } from "solid-js"
import type { Plugin } from "@opencode/plugin/tui"
import { compactRpc } from "./rpc.ts"
import { activityBar, elapsedLabel, progressLabel, type CompactProgress } from "./progress.ts"

export function CompactProgressView(props: { api: Plugin.Context; sessionID: string }) {
  const [progress, setProgress] = createSignal<CompactProgress | null>(null)
  const [now, setNow] = createSignal(Date.now())
  const [disconnected, setDisconnected] = createSignal(false)
  const clock = setInterval(() => setNow(Date.now()), 250)
  onCleanup(() => clearInterval(clock))
  createEffect(() => {
    const sessionID = props.sessionID
    const location = props.api.data.session.get(sessionID)?.location ?? props.api.location ?? props.api.data.location.default()
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    setProgress(null)
    setDisconnected(false)
    async function poll() {
      try {
        const result = await props.api.client.rpc(compactRpc).progress({ sessionID }, { location, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]) }) as { progress: CompactProgress | null }
        if (controller.signal.aborted) return
        setProgress(result.progress)
        setDisconnected(false)
      } catch {
        if (controller.signal.aborted) return
        // Keep the last known state, but do not imply that a disconnected request is progressing.
        setDisconnected(true)
      }
      if (!controller.signal.aborted) timer = setTimeout(() => void poll(), progress()?.endedAt === undefined && progress() ? 1000 : 2000)
    }
    void poll()
    onCleanup(() => { controller.abort(); clearTimeout(timer) })
  })
  const theme = props.api.theme
  return <Show when={progress()}>{p => <box paddingLeft={1} paddingRight={1} paddingBottom={1} flexDirection="column">
    <text fg={p().phase === "failed" ? theme.text.feedback.error.base : theme.text.action.primary.base} wrapMode="none" truncate>
      {p().endedAt === undefined && !disconnected() ? activityBar(now()) : "[─────────]"} Compact · {disconnected() ? "进度连接中断，正在重连" : progressLabel(p(), now())}
    </text>
    <text fg={theme.text.muted} wrapMode="none" truncate>
      {p().mode === "auto" ? "自动压缩" : "手动压缩"} · 已耗时 {elapsedLabel(p(), now())}{p().endedAt === undefined ? " · 剩余时间暂无法估计" : ""}
    </text>
  </box>}</Show>
}

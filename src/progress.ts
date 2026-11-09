export type SummaryProgress = {
  phase: "generating" | "splitting" | "fragment" | "merge"
  calls: number
  completedFragments: number
  mergeRound: number
  retry?: { attempt: number; maxAttempts: number; retryAt?: number }
}
export type CompactProgress = Omit<SummaryProgress, "phase"> & {
  phase: SummaryProgress["phase"] | "waiting" | "complete" | "failed" | "cancelled"
  runID: string
  mode: "manual" | "auto"
  startedAt: number
  endedAt?: number
}
const RETAIN_MS = 6000

/** Per-location, per-session status. Only metadata, never prompts or model output. */
export function createProgressStore(now = Date.now) {
  const entries = new Map<string, CompactProgress>()
  function prune() {
    for (const [id, p] of entries) if (p.endedAt !== undefined && now() - p.endedAt >= RETAIN_MS) entries.delete(id)
    // Bound retained terminal records even when no TUI is polling them.
    for (const [id, p] of entries) if (entries.size > 256 && p.endedAt !== undefined) entries.delete(id)
  }
  return {
    begin(sessionID: string, runID: string, mode: CompactProgress["mode"]) {
      prune()
      const previous = entries.get(sessionID)
      if (previous?.runID === runID) return
      entries.set(sessionID, { runID, mode, phase: "waiting", startedAt: now(), calls: 0, completedFragments: 0, mergeRound: 0 })
    },
    update(sessionID: string, runID: string, update: SummaryProgress) {
      const p = entries.get(sessionID)
      if (p?.runID === runID && p.endedAt === undefined) {
        const { retry: _, ...previous } = p
        entries.set(sessionID, { ...previous, ...update })
      }
    },
    finish(sessionID: string, runID: string, phase: "complete" | "failed" | "cancelled") {
      const p = entries.get(sessionID)
      if (p?.runID === runID && p.endedAt === undefined) {
        const { retry: _, ...previous } = p
        entries.set(sessionID, { ...previous, phase, endedAt: now() })
      }
      prune()
    },
    get(sessionID: string) { prune(); return entries.get(sessionID) ?? null },
    clear() { entries.clear() },
  }
}

export function progressLabel(p: CompactProgress, now = Date.now()): string {
  if (p.retry && p.endedAt === undefined) {
    const { attempt, maxAttempts, retryAt } = p.retry
    if (retryAt !== undefined) {
      const seconds = Math.max(0, Math.ceil((retryAt - now) / 1000))
      return `连接中断，${seconds ? `${seconds} 秒后重试` : "即将重试"} (${attempt}/${maxAttempts})`
    }
    return `正在重试 (${attempt}/${maxAttempts}) · ${progressLabel({ ...p, retry: undefined }, now)}`
  }
  switch (p.phase) {
    case "waiting": return "等待压缩开始"
    case "generating": return "模型正在生成摘要"
    case "splitting": return "输入过长，正在继续分段"
    case "fragment": return `正在分块压缩 · 已完成 ${p.completedFragments} 段`
    case "merge": return `正在合并摘要 · 第 ${p.mergeRound} 轮 · 已压缩 ${p.completedFragments} 段`
    case "complete": return "摘要已生成"
    case "failed": return "压缩失败"
    case "cancelled": return "压缩已取消"
  }
}
export function elapsedLabel(p: CompactProgress, now: number): string {
  const seconds = Math.max(0, Math.floor(((p.endedAt ?? now) - p.startedAt) / 1000))
  return `${Math.floor(seconds / 60).toString().padStart(2, "0")}:${(seconds % 60).toString().padStart(2, "0")}`
}
/** Moving activity indicator, deliberately not a completion percentage. */
export function activityBar(now: number): string {
  const position = Math.floor(now / 250) % 12
  const start = position <= 6 ? position : 12 - position
  return `[${Array.from({ length: 9 }, (_, i) => i >= start && i < start + 3 ? "━" : "·").join("")}]`
}

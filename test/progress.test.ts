import { test, expect } from "bun:test"
import { createProgressStore, elapsedLabel, progressLabel, activityBar } from "../src/progress.ts"

test("retry countdown and attempts clear when work resumes or terminates", () => {
 const store = createProgressStore(() => 1000)
 store.begin("s", "r", "manual")
 const progress = { phase: "fragment" as const, calls: 3, completedFragments: 1, mergeRound: 0 }
 store.update("s", "r", { ...progress, retry: { attempt: 1, maxAttempts: 2, retryAt: 3000 } })
 expect(progressLabel(store.get("s")!, 1000)).toBe("连接中断，2 秒后重试 (1/2)")
 expect(progressLabel(store.get("s")!, 4000)).toBe("连接中断，即将重试 (1/2)")
 store.update("s", "r", { ...progress, retry: { attempt: 1, maxAttempts: 2 } })
 expect(progressLabel(store.get("s")!)).toContain("正在重试 (1/2) · 正在分块压缩")
 store.update("s", "r", progress)
 expect(store.get("s")?.retry).toBeUndefined()
 expect(Object.hasOwn(store.get("s")!, "retry")).toBe(false)
 store.update("s", "r", { ...progress, retry: { attempt: 2, maxAttempts: 2 } })
 store.finish("s", "r", "failed")
 expect(store.get("s")?.retry).toBeUndefined()
 expect(Object.hasOwn(store.get("s")!, "retry")).toBe(false)
 expect(progressLabel(store.get("s")!)).toBe("压缩失败")
})

test("progress is session-scoped, elapsed time survives reads, terminal state expires", () => {
 let now = 1000
 const store = createProgressStore(() => now)
 store.begin("s1", "r1", "manual")
 store.begin("s2", "r2", "auto")
 now = 4000
 store.update("s1", "r1", { phase: "fragment", calls: 3, completedFragments: 1, mergeRound: 0 })
 expect(store.get("s1")?.startedAt).toBe(1000)
 expect(store.get("s2")?.phase).toBe("waiting")
 expect(elapsedLabel(store.get("s1")!, now)).toBe("00:03")
 store.finish("s1", "r1", "complete")
 now = 7000
 expect(elapsedLabel(store.get("s1")!, now)).toBe("00:03")
 now = 11000
 expect(store.get("s1")).toBeNull()
 expect(store.get("s2")?.mode).toBe("auto")
})
test("late updates cannot overwrite a new run or resurrect a completed one", () => {
 const store = createProgressStore()
 store.begin("s", "old", "manual")
 store.begin("s", "new", "auto")
 store.finish("s", "old", "failed")
 expect(store.get("s")?.phase).toBe("waiting")
 store.finish("s", "new", "complete")
 store.update("s", "new", { phase: "merge", calls: 1, completedFragments: 0, mergeRound: 1 })
 expect(store.get("s")?.phase).toBe("complete")
 store.clear()
 store.finish("s", "new", "failed")
 expect(store.get("s")).toBeNull()
})
test("display distinguishes elapsed time and stage from estimated completion", () => {
 const store = createProgressStore(() => 0)
 store.begin("s", "r", "auto")
 store.update("s", "r", { phase: "merge", calls: 4, completedFragments: 2, mergeRound: 1 })
 const p = store.get("s")!
 expect(progressLabel(p)).toBe("正在合并摘要 · 第 1 轮 · 已压缩 2 段")
 expect(elapsedLabel(p, 125000)).toBe("02:05")
 expect(activityBar(0)).not.toBe(activityBar(500))
 expect(activityBar(0)).not.toContain("%")
})

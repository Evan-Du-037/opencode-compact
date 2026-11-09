import { expect, test } from "bun:test"
import { isConnectionLoss, waitForRetry } from "../src/retry.ts"
import { summarizeHistory } from "../src/summary.ts"
import type { SummaryProgress } from "../src/progress.ts"

const reset = () => new Error("Generate.ProviderRequestError: Connection lost while reading the response: ECONNRESET: The socket connection was closed unexpectedly.")
const messages = [{ role: "user", content: "first history" }, { role: "user", content: "second history" }]
const base = () => ({ prompt: "RULES", messages, signal: new AbortController().signal, wait: async () => {} })
const overflow = () => new Error("context_length_exceeded")
const payload = (p: string) => JSON.parse(p.slice(p.lastIndexOf("\n") + 1))

test("only affirmative connection loss errors qualify, including wrapped socket causes", () => {
  for (const error of [reset(), { code: "ECONNRESET" }, new Error("request failed", { cause: { code: "EPIPE" } }), "socket hang up", { message: "UND_ERR_SOCKET: other side closed" }]) expect(isConnectionLoss(error)).toBe(true)
  const circular: any = {}; circular.cause = circular
  for (const error of [circular, new Error("network error"), new Error("401 Unauthorized"), new Error("429 rate limit"), new Error("System detected potentially unsafe or sensitive content"), overflow(), new Error("request timed out"), new DOMException("Aborted", "AbortError")]) expect(isConnectionLoss(error)).toBe(false)
})

test("same request retries twice with bounded backoff and visible progress, then succeeds", async () => {
  const prompts: string[] = [], delays: number[] = [], updates: SummaryProgress[] = []
  expect(await summarizeHistory({ ...base(), onProgress: p => updates.push(p), wait: async ms => { delays.push(ms) }, generate: async p => {
    prompts.push(p)
    if (prompts.length < 3) throw reset()
    return "complete summary"
  } })).toBe("complete summary")
  expect(prompts).toHaveLength(3)
  expect(new Set(prompts).size).toBe(1)
  expect(delays).toEqual([2000, 5000])
  expect(updates.filter(p => p.retry?.retryAt).map(p => p.retry?.attempt)).toEqual([1, 2])
  expect(updates.filter(p => p.retry && !p.retry.retryAt).map(p => p.calls)).toEqual([2, 3])
  expect(updates.at(-1)?.retry).toBeUndefined()
})

test("persistent disconnection stops after three attempts and preserves original error", async () => {
  let calls = 0
  const error = reset()
  await expect(summarizeHistory({ ...base(), generate: async () => { calls++; throw error } })).rejects.toBe(error)
  expect(calls).toBe(3)
})

test("a later chunk and merge retry independently without regenerating completed chunks", async () => {
  const counts = new Map<string, number>()
  const updates: SummaryProgress[] = []
  const result = await summarizeHistory({ ...base(), onProgress: p => updates.push(p), generate: async p => {
    const count = (counts.get(p) ?? 0) + 1; counts.set(p, count)
    if (p.includes("<conversation-history>")) throw overflow()
    const data = payload(p)
    if (data.pieces) {
      const second = data.pieces[0].source === "m2"
      if (second && count < 3) throw reset()
      return JSON.stringify({ summary: second ? "second" : "first", quotes: [] })
    }
    expect(data.summaries).toEqual(["first", "second"])
    if (count < 3) throw reset()
    return "merged"
  } })
  expect(result).toBe("merged")
  expect([...counts.values()]).toEqual([1, 1, 3, 3])
  expect(updates.filter(p => p.phase === "fragment" && p.retry).every(p => p.completedFragments === 1)).toBe(true)
})

test("overflow after transport recovery still splits, while a policy error stops immediately", async () => {
  let full = 0
  expect(await summarizeHistory({ ...base(), generate: async p => {
    if (p.includes("<conversation-history>")) { if (++full === 1) throw reset(); throw overflow() }
    return payload(p).pieces ? JSON.stringify({ summary: "part", quotes: [] }) : "final"
  } })).toBe("final")
  expect(full).toBe(2)
  let calls = 0
  await expect(summarizeHistory({ ...base(), generate: async () => {
    if (++calls === 1) throw reset()
    throw new Error("401 Unauthorized")
  } })).rejects.toThrow("401 Unauthorized")
  expect(calls).toBe(2)
})

test("cancelling the real backoff interrupts promptly without sending another request", async () => {
  const controller = new AbortController()
  let waiting!: () => void, calls = 0
  const ready = new Promise<void>(resolve => { waiting = resolve })
  const result = summarizeHistory({ ...base(), signal: controller.signal,
    wait: (ms, signal) => { const pending = waitForRetry(ms, signal); waiting(); return pending },
    generate: async () => { calls++; throw reset() },
  }).catch(error => error)
  await ready
  controller.abort()
  expect((await result).name).toBe("AbortError")
  expect(calls).toBe(1)
})

test("cancellation during a failed request takes precedence over retry classification", async () => {
  const controller = new AbortController()
  let waits = 0
  await expect(summarizeHistory({ ...base(), signal: controller.signal, wait: async () => { waits++ }, generate: async () => {
    controller.abort(new Error("cancelled")); throw reset()
  } })).rejects.toThrow("cancelled")
  expect(waits).toBe(0)
})

test("transport retries count against the existing overall 64-call cap", async () => {
  let calls = 0
  const attempts = new Map<string, number>()
  await expect(summarizeHistory({ ...base(), messages: Array.from({ length: 64 }, () => ({ role: "user", content: "history" })), generate: async p => {
    calls++
    if (p.includes("<conversation-history>")) throw overflow()
    const count = (attempts.get(p) ?? 0) + 1; attempts.set(p, count)
    if (count === 1) throw reset()
    if (payload(p).pieces.length > 1) throw overflow()
    return JSON.stringify({ summary: "fact", quotes: [] })
  } })).rejects.toThrow()
  expect(calls).toBe(64)
})

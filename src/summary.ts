import { readFile } from "node:fs/promises"
import type { SummaryProgress } from "./progress.ts"
import { CONNECTION_RETRY_DELAYS, isConnectionLoss, waitForRetry } from "./retry.ts"

// Bound recovery work; a failed recovery never returns a partial summary.
const MAX_CALLS = 64
const MAX_DEPTH = 12
const MAX_MERGE_ROUNDS = 6
const MIN_FRAGMENT = 256
const MAX_QUOTE_CHARS = 32_000
const MAX_FINAL_CHARS = 48_000

type Piece = { source: string; start: number; end: number; text: string; role?: string }
type Quote = { source: string; text: string }
type Generate = (prompt: string, signal: AbortSignal) => Promise<string>

/** Only affirmative provider overflow errors trigger splitting, never policy/auth/network errors. */
export function isContextOverflow(error: unknown): boolean {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : ""
  return /\bcontext_length_exceeded\b|\bmaximum context length\b|\binput (?:exceeds|is longer than) (?:the )?context (?:window|length)\b|\bprompt is too long\b|\bexceeded (?:the )?model(?:'s)? context window\b/i.test(message)
}

function strings(value: unknown): string[] {
  if (typeof value === "string") return [value]
  if (Array.isArray(value)) return value.flatMap(strings)
  if (value && typeof value === "object") return Object.values(value).flatMap(strings)
  return []
}

// Split the payload, never the shared instructions; prefer whole user exchanges, then messages.
export function splitPieces(pieces: readonly Piece[]): [Piece[], Piece[]] | undefined {
  if (pieces.length > 1) {
    const half = pieces.reduce((sum, p) => sum + p.text.length, 0) / 2
    const turns = pieces.flatMap((p, i) => i > 0 && p.role === "user" ? [i] : [])
    const candidates = new Set(turns.length ? turns : pieces.slice(1).map((_, i) => i + 1))
    let best = 1, distance = Infinity, prefix = 0
    for (let i = 1; i < pieces.length; i++) {
      prefix += pieces[i - 1]!.text.length
      if (!candidates.has(i)) continue
      const current = Math.abs(prefix - half)
      if (current < distance) { best = i; distance = current }
    }
    return [pieces.slice(0, best), pieces.slice(best)]
  }
  const piece = pieces[0]
  if (!piece || piece.text.length < MIN_FRAGMENT * 2) return undefined
  let middle = Math.floor(piece.text.length / 2)
  // Avoid cutting a UTF-16 surrogate pair.
  if (/[\uD800-\uDBFF]/.test(piece.text[middle - 1]!)) middle--
  return [
    [{ ...piece, text: piece.text.slice(0, middle), end: piece.start + middle }],
    [{ ...piece, text: piece.text.slice(middle), start: piece.start + middle }],
  ]
}

export async function summarizeHistory(input: {
  prompt: string
  messages: readonly unknown[]
  generate: Generate
  signal: AbortSignal
  onProgress?: (progress: SummaryProgress) => void
  /** Injectable clock wait for deterministic recovery tests. */
  wait?: (ms: number, signal: AbortSignal) => Promise<void>
}): Promise<string> {
  let calls = 0, completedFragments = 0, mergeRound = 0
  function report(phase: SummaryProgress["phase"], retry?: SummaryProgress["retry"]) {
    // Status reporting must never change the result of a compaction.
    try { input.onProgress?.({ phase, calls, completedFragments, mergeRound, ...(retry ? { retry } : {}) }) } catch {}
  }
  async function call(prompt: string, phase: SummaryProgress["phase"]): Promise<string> {
    for (let attempt = 0; ; attempt++) {
      input.signal.throwIfAborted()
      if (calls >= MAX_CALLS) throw new Error("分块压缩已达到 64 次调用上限，未提交摘要。请缩小压缩要求或选择更大上下文的模型。")
      calls++
      const retry = attempt ? { attempt, maxAttempts: CONNECTION_RETRY_DELAYS.length } : undefined
      report(phase, retry)
      try {
        const text = await input.generate(prompt, input.signal)
        input.signal.throwIfAborted()
        if (!text.trim()) throw new Error("模型返回了空摘要。")
        // Clear retry state even when this was the final generation call.
        if (retry) report(phase)
        return text
      } catch (error) {
        input.signal.throwIfAborted()
        const ms = CONNECTION_RETRY_DELAYS[attempt]
        if (!isConnectionLoss(error) || ms === undefined || calls >= MAX_CALLS) throw error
        report(phase, { attempt: attempt + 1, maxAttempts: CONNECTION_RETRY_DELAYS.length, retryAt: Date.now() + ms })
        await (input.wait ?? waitForRetry)(ms, input.signal)
      }
    }
  }

  try {
    return await call(`${input.prompt}\n\n<conversation-history>\n${JSON.stringify(input.messages)}\n</conversation-history>`, "generating")
  } catch (error) {
    input.signal.throwIfAborted()
    if (!isContextOverflow(error)) throw error
    report("splitting")
  }

  const [fragmentRules, mergeRules] = await Promise.all([
    readFile(new URL("../prompts/fragment.md", import.meta.url), "utf8"),
    readFile(new URL("../prompts/merge.md", import.meta.url), "utf8"),
  ])
  const originals = new Map<string, string[]>()
  const pieces: Piece[] = input.messages.map((message, i) => {
    const text = JSON.stringify(message), source = `m${i + 1}`
    originals.set(source, [...strings(message), text])
    const role = message && typeof message === "object" && "role" in message ? String(message.role) : undefined
    return { source, start: 0, end: text.length, text, role }
  })
  const quotes: Quote[] = []
  let quoteChars = 0
  const target = (length: number) => Math.max(256, Math.min(4000, Math.floor(length / 4)))
  const exhausted = () => new Error("上下文仍然超限，无法在保留全部待处理内容的情况下继续拆分；未提交摘要。压缩要求本身也可能过长。")

  async function fragment(parts: Piece[], depth: number): Promise<string[]> {
    const prompt = `${input.prompt}\n\n${fragmentRules}\n${JSON.stringify({ targetChars: target(parts.reduce((n, p) => n + p.text.length, 0)), pieces: parts })}`
    let text: string
    try { text = await call(prompt, "fragment") }
    catch (error) {
      input.signal.throwIfAborted()
      if (!isContextOverflow(error)) throw error
      report("splitting")
      const split = depth < MAX_DEPTH ? splitPieces(parts) : undefined
      if (!split) throw exhausted()
      // Sequential, ordered calls keep cost/concurrency bounded and cancellation immediate.
      return [...await fragment(split[0], depth + 1), ...await fragment(split[1], depth + 1)]
    }
    let parsed: { summary?: unknown; quotes?: unknown }
    try { parsed = JSON.parse(text) }
    catch { throw new Error("分块摘要未返回有效 JSON，未提交摘要。") }
    if (!parsed || typeof parsed.summary !== "string" || !parsed.summary.trim() || !Array.isArray(parsed.quotes))
      throw new Error("分块摘要格式不完整，未提交摘要。")
    for (const value of parsed.quotes) {
      const quote = value as Quote
      if (!quote || typeof quote.source !== "string" || typeof quote.text !== "string" || !quote.text ||
          !parts.some(p => p.source === quote.source) || !originals.get(quote.source)?.some(s => s.includes(quote.text)))
        throw new Error("分块摘要中的保留原文与历史不一致，未提交摘要。")
      if (quotes.some(q => q.source === quote.source && q.text === quote.text)) continue
      quoteChars += quote.text.length
      if (quoteChars > MAX_QUOTE_CHARS) throw new Error("需要逐字保留的内容超过 32000 字符，未提交摘要。请减少原文保留范围。")
      quotes.push({ source: quote.source, text: quote.text })
    }
    completedFragments++
    report("fragment")
    return [parsed.summary]
  }

  async function merge(summaries: string[], depth: number): Promise<string[]> {
    try {
      return [await call(`${input.prompt}\n\n${mergeRules}\n${JSON.stringify({ targetChars: target(summaries.join("\n").length), summaries })}`, "merge")]
    } catch (error) {
      input.signal.throwIfAborted()
      if (!isContextOverflow(error)) throw error
      if (depth >= MAX_DEPTH) throw exhausted()
      if (summaries.length > 1) {
        const middle = Math.ceil(summaries.length / 2)
        return [...await merge(summaries.slice(0, middle), depth + 1), ...await merge(summaries.slice(middle), depth + 1)]
      }
      // Even a single verbose intermediate summary may need another subdivision.
      const text = summaries[0] ?? ""
      const split = splitPieces([{ source: "intermediate", text, start: 0, end: text.length }])
      if (!split) throw exhausted()
      return [...await merge([split[0][0]!.text], depth + 1), ...await merge([split[1][0]!.text], depth + 1)]
    }
  }

  const first = splitPieces(pieces)
  if (!first) throw exhausted()
  let summaries = [...await fragment(first[0], 1), ...await fragment(first[1], 1)]
  for (let round = 0; round < MAX_MERGE_ROUNDS; round++) {
    mergeRound = round + 1
    const before = summaries.join("\n").length
    const merged = await merge(summaries, 0)
    if (merged.length === 1) {
      let summary = merged[0]!
      const missing = quotes.filter(q => !summary.includes(q.text))
      if (missing.length) summary += `\n\n## 保留原文\n\n${missing.map(q => `来源 ${q.source}：\n${q.text}`).join("\n\n")}`
      if (summary.length > MAX_FINAL_CHARS) throw new Error("合并摘要超过 48000 字符，未提交摘要。请缩小原文保留范围或压缩要求。")
      input.signal.throwIfAborted()
      return summary
    }
    if (merged.join("\n").length >= before) throw new Error("中间摘要未能缩短，已停止继续合并；未提交摘要。")
    summaries = merged
  }
  throw new Error("分块摘要达到 6 轮合并上限，未提交摘要。")
}

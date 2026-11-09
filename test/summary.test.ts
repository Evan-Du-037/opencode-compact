import { test, expect } from "bun:test"
import { summarizeHistory, isContextOverflow, splitPieces } from "../src/summary.ts"

const overflow = () => new Error("Generate.UnavailableError: context_length_exceeded: Your input exceeds the context window of this model.")
const signal = () => new AbortController().signal
const messages = [{ role: "user", content: "FIRST " + "中文🙂 内容。".repeat(600) }, { role: "assistant", content: "LAST decision" }]
const payload = (prompt: string) => JSON.parse(prompt.slice(prompt.lastIndexOf("\n") + 1))

test("normal compaction still makes exactly one call with the unchanged prompt", async () => {
 const calls: string[] = []
 const result = await summarizeHistory({ prompt: "RULES", messages, signal: signal(), generate: async p => { calls.push(p); return "done" } })
 expect(result).toBe("done")
 expect(calls).toEqual([`RULES\n\n<conversation-history>\n${JSON.stringify(messages)}\n</conversation-history>`])
})
test("overflow splits disjoint source ranges, retains all text and quotes, then merges in order", async () => {
 const accepted: any[] = [], calls: string[] = []
 const result = await summarizeHistory({ prompt: "BASE_REQUIREMENTS", messages, signal: signal(), generate: async p => {
  calls.push(p)
  if (p.includes("<conversation-history>")) throw overflow()
  const data = payload(p)
  if (data.pieces) {
   if (data.pieces.reduce((n: number, p: any) => n + p.text.length, 0) > 2200) throw overflow()
   accepted.push(...data.pieces)
   return JSON.stringify({ summary: data.pieces.map((p: any) => `${p.source}:${p.start}`).join(","), quotes: data.pieces.some((p: any) => p.source === "m2") ? [{ source: "m2", text: "LAST decision" }] : [] })
  }
  expect(data.summaries).toEqual(accepted.map(p => `${p.source}:${p.start}`))
  return "final self-contained summary"
 } })
 expect(result).toContain("final self-contained summary")
 expect(result).toContain("LAST decision")
 for (let i = 0; i < messages.length; i++) {
  const chunks = accepted.filter(p => p.source === `m${i + 1}`)
  expect(chunks.map(p => p.text).join("")).toBe(JSON.stringify(messages[i]))
  for (let j = 1; j < chunks.length; j++) expect(chunks[j].start).toBe(chunks[j - 1].end)
 }
 expect(calls.every(p => p.startsWith("BASE_REQUIREMENTS"))).toBe(true)
 expect(calls.filter(p => p.includes("[compact-stage: fragment]")).every(p => p.includes("而不是完整会话"))).toBe(true)
})
test("huge individual messages split without breaking Unicode pairs", () => {
 const text = "🙂".repeat(513)
 const split = splitPieces([{ source: "m1", text, start: 0, end: text.length }])!
 expect(split.flat().map(p => p.text).join("")).toBe(text)
 expect(split[0][0]!.text.endsWith("🙂")).toBe(true)
 expect(split[1][0]!.text.startsWith("🙂")).toBe(true)
})
test("prefer complete turns when splitting", () => {
 const pieces = ["user", "assistant", "tool", "user", "assistant"].map((role, i) => ({ source: `${i}`, role, text: "abc", start: 0, end: 3 }))
 expect(splitPieces(pieces)![0]).toHaveLength(3)
})
test("merge overflow uses multiple levels, including one overly verbose intermediate", async () => {
 const mergeSizes: number[] = []
 let merges = 0
 const result = await summarizeHistory({ prompt: "RULES", messages, signal: signal(), generate: async p => {
  if (p.includes("<conversation-history>")) throw overflow()
  const data = payload(p)
  if (data.pieces) return JSON.stringify({ summary: "DETAIL ".repeat(500), quotes: [] })
  mergeSizes.push(data.summaries.join("").length)
  if (data.summaries.join("").length > 2000) throw overflow()
  merges++
  return "merged detail"
 } })
 expect(result).toBe("merged detail")
 expect(merges).toBeGreaterThan(2)
 expect(mergeSizes[0]).toBe(7000)
})
test("non-overflow errors never trigger splitting", async () => {
 for (const message of ["System detected potentially unsafe or sensitive content", "401 Unauthorized", "rate limit", "network error"]) {
  let calls = 0
  await expect(summarizeHistory({ prompt: "RULES", messages, signal: signal(), generate: async () => { calls++; throw new Error(message) } })).rejects.toThrow(message)
  expect(calls).toBe(1)
 }
 expect(isContextOverflow(new Error("maximum context length exceeded"))).toBe(true)
 expect(isContextOverflow(new Error("prompt is too long"))).toBe(true)
})
test("failure in a later chunk never returns a partial summary", async () => {
 let fragments = 0
 await expect(summarizeHistory({ prompt: "RULES", messages, signal: signal(), generate: async p => {
  if (p.includes("<conversation-history>")) throw overflow()
  if (++fragments === 2) throw new Error("connection lost")
  return JSON.stringify({ summary: "first part", quotes: [] })
 } })).rejects.toThrow("connection lost")
 expect(fragments).toBe(2)
})
test("cancellation stops between chunks even if the generator resolves after abort", async () => {
 const controller = new AbortController()
 let calls = 0
 await expect(summarizeHistory({ prompt: "RULES", messages, signal: controller.signal, generate: async p => {
  calls++
  if (p.includes("<conversation-history>")) throw overflow()
  controller.abort(new Error("cancelled"))
  return JSON.stringify({ summary: "partial", quotes: [] })
 } })).rejects.toThrow("cancelled")
 expect(calls).toBe(2)
})
test("malformed or invented quotations fail closed", async () => {
 for (const reply of ["not json", JSON.stringify({ summary: "partial", quotes: [{ source: "m1", text: "FABRICATED QUOTE" }] }), "null"]) {
  await expect(summarizeHistory({ prompt: "RULES", messages, signal: signal(), generate: async p => {
   if (p.includes("<conversation-history>")) throw overflow()
   return reply
  } })).rejects.toThrow("未提交摘要")
 }
})
test("irreducible overflow and non-shrinking merge terminate", async () => {
 let calls = 0
 await expect(summarizeHistory({ prompt: "RULES", messages, signal: signal(), generate: async () => { calls++; throw overflow() } })).rejects.toThrow("无法在保留全部")
 expect(calls).toBeLessThan(20)
 await expect(summarizeHistory({ prompt: "RULES", messages, signal: signal(), generate: async p => {
  if (p.includes("<conversation-history>")) throw overflow()
  const data = payload(p)
  if (data.pieces) return JSON.stringify({ summary: "stable", quotes: [] })
  if (data.summaries.length > 1) throw overflow()
  return data.summaries[0]
 } })).rejects.toThrow("未能缩短")
})

test("total generation calls are capped across fragment and merge recursion", async () => {
 let calls = 0
 const many = Array.from({ length: 128 }, () => ({ role: "user", content: "history" }))
 await expect(summarizeHistory({ prompt: "RULES", messages: many, signal: signal(), generate: async p => {
  calls++
  if (p.includes("<conversation-history>")) throw overflow()
  const data = payload(p)
  if (data.pieces.length > 1) throw overflow()
  return JSON.stringify({ summary: "fact", quotes: [] })
 } })).rejects.toThrow("64 次调用上限")
 expect(calls).toBe(64)
})
test("a huge shared requirement cannot cause unbounded retries", async () => {
 let calls = 0
 await expect(summarizeHistory({ prompt: "RULES ".repeat(10000), messages, signal: signal(), generate: async () => { calls++; throw overflow() } })).rejects.toThrow("压缩要求本身也可能过长")
 expect(calls).toBeLessThan(20)
})
test("validated verbatim text survives rewriting in the merge response", async () => {
 const quote = "A  B\n中文🙂 original"
 const result = await summarizeHistory({ prompt: "RULES", messages: [{ role: "user", content: quote }, { role: "assistant", content: "later" }], signal: signal(), generate: async p => {
  if (p.includes("<conversation-history>")) throw overflow()
  const data = payload(p)
  if (data.pieces) return JSON.stringify({ summary: "Context of original quotation", quotes: data.pieces[0].source === "m1" ? [{ source: "m1", text: quote }] : [] })
  return "Context of original quotation: A B paraphrased"
 } })
 expect(result).toContain(quote)
})

test("progress reports only validated completed fragments and identifies merge rounds", async () => {
 const updates: any[] = []
 await summarizeHistory({prompt:"RULES", messages, signal:signal(), onProgress:p=>updates.push(p), generate:async p=>{
  if(p.includes("<conversation-history>")) throw overflow()
  if(payload(p).pieces) return JSON.stringify({summary:"part",quotes:[]})
  return "final"
 }})
 expect(updates[0]).toEqual({phase:"generating",calls:1,completedFragments:0,mergeRound:0})
 expect(updates.some(p=>p.phase==="splitting")).toBe(true)
 expect(updates.at(-1)).toEqual({phase:"merge",calls:4,completedFragments:2,mergeRound:1})
 const invalid: any[]=[]
 await expect(summarizeHistory({prompt:"RULES",messages,signal:signal(),onProgress:p=>invalid.push(p),generate:async p=>{
  if(p.includes("<conversation-history>"))throw overflow()
  return "invalid JSON"
 }})).rejects.toThrow("JSON")
 expect(invalid.every(p=>p.completedFragments===0)).toBe(true)
})
test("a failing progress observer cannot fail a valid summary", async () => {
 expect(await summarizeHistory({prompt:"RULES",messages,signal:signal(),onProgress:()=>{throw new Error("display unavailable")},generate:async()=>"summary"})).toBe("summary")
})

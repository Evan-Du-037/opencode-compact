import { test, expect } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { server } from "../src/server.ts"
import { compactionInstructions, fingerprint, type Message, type Request } from "../src/core.ts"
import { pathFor, publish, read } from "../src/store.ts"

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "compact-test-")), directory = "/project", sessionID = "ses_one"
  const base: Message[] = [{ info: { id: "msg1", role: "user" }, parts: [{ id: "p1", type: "text", text: "原文\r\n  不改写🙂" }] }]
  let messages = [...base, { info: { id: "compact1", role: "user" }, parts: [{ id: "marker", type: "compaction", auto: false }] }]
  const hooks = await server({ directory, client: { session: {
    messages: async () => ({ data: messages }),
    message: async () => ({ data: { info: { id: "summary1", role: "assistant", summary: true, parentID: "compact1" }, parts: [] } }),
  } } } as any, { stateDir: root })
  const ready = await read<{ backend: string }>(pathFor(root, directory, "backend", "ready"))
  const request: Request = { version: 2, id: "request1", directory, sessionID, created: Date.now(), base: fingerprint(base), fields: { focus: "下一阶段 GC", preserve: "刚刚那段", discard: "UI", extra: "新增背景" }, backend: ready!.backend }
  return { root, directory, sessionID, request, hooks, setMessages: (m: Message[]) => { messages = m }, messages,
    cleanup: async () => { await hooks.dispose?.(); await rm(root, { recursive: true, force: true }) } }
}

test("single request replaces prompt, leaves model output untouched and does not leak", async () => {
  const f = await fixture()
  try {
    await publish(f.root, f.request)
    const output = { context: [] as string[], prompt: "已有自定义模板" }
    await f.hooks["experimental.session.compacting"]!({ sessionID: f.sessionID }, output)
    expect(output.prompt).toBe(await compactionInstructions(f.request.fields))
    expect(output.prompt).not.toContain("已有自定义模板")
    expect(output.context).toEqual([])
    expect(f.hooks.config).toBeUndefined()
    const text = { text: "模型摘要" }
    await f.hooks["experimental.text.complete"]!({ sessionID: f.sessionID, messageID: "summary1", partID: "text1" }, text)
    expect(text.text).toBe("模型摘要")
    await f.hooks.event!({ event: { type: "session.compacted", properties: { sessionID: f.sessionID } } as any })
    expect((await read<any>(pathFor(f.root, f.directory, f.sessionID, "receipt"))).status).toBe("done")
    const next = { context: [] as string[] }
    await f.hooks["experimental.session.compacting"]!({ sessionID: f.sessionID }, next)
    expect(next.context).toEqual([])
  } finally { await f.cleanup() }
})

test("blank form leaves default and custom compaction prompts untouched", async () => {
  const f = await fixture()
  try {
    f.request.fields = { focus: " ", preserve: "\n", discard: "", extra: "\t" }
    await publish(f.root, f.request)
    const output = { context: ["已有上下文"], prompt: "已有模板" }
    await f.hooks["experimental.session.compacting"]!({ sessionID: f.sessionID }, output)
    expect(output).toEqual({ context: ["已有上下文"], prompt: "已有模板" })
    const text = { text: "原始摘要" }
    await f.hooks["experimental.text.complete"]!({ sessionID: f.sessionID, messageID: "summary1", partID: "text1" }, text)
    expect(text.text).toBe("原始摘要")
  } finally { await f.cleanup() }
})

test("automatic compaction does not consume pending manual requirements", async () => {
  const f = await fixture()
  try {
    f.messages.at(-1)!.parts[0]!.auto = true
    await publish(f.root, f.request)
    const output = { context: [] as string[] }
    await f.hooks["experimental.session.compacting"]!({ sessionID: f.sessionID }, output)
    expect(output.context).toEqual([])
    expect(await read(pathFor(f.root, f.directory, f.sessionID, "pending"))).toBeDefined()
  } finally { await f.cleanup() }
})

test("stale snapshot is rejected and pending requirements are removed", async () => {
  const f = await fixture()
  try {
    f.request.base = "stale"
    await publish(f.root, f.request)
    await expect(f.hooks["experimental.session.compacting"]!({ sessionID: f.sessionID }, { context: [] })).rejects.toThrow("会话已变化")
    expect(await read(pathFor(f.root, f.directory, f.sessionID, "pending"))).toBeUndefined()
  } finally { await f.cleanup() }
})

test("separate sessions cannot consume each other's handoff", async () => {
  const f = await fixture()
  try {
    await publish(f.root, f.request)
    const output = { context: [] as string[] }
    await f.hooks["experimental.session.compacting"]!({ sessionID: "ses_other" }, output)
    expect(output.context).toEqual([])
    await expect(publish(f.root, f.request)).rejects.toThrow("已有待处理")
  } finally { await f.cleanup() }
})


test("replacement includes previous handoff and other plugin context, but not old template", async () => {
  const f = await fixture()
  try {
    f.messages.unshift({ info: { id: "old", role: "assistant", summary: true, finish: "stop" }, parts: [{ id: "old-text", type: "text", text: "之前已完成的工作" }] })
    f.request.base = fingerprint(f.messages.slice(0, -1))
    await publish(f.root, f.request)
    const output = { context: ["另一个插件的上下文"], prompt: "旧模板" }
    await f.hooks["experimental.session.compacting"]!({ sessionID: f.sessionID }, output)
    expect(output.prompt).toContain("之前已完成的工作")
    expect(output.prompt).toContain("另一个插件的上下文")
    expect(output.prompt).not.toContain("旧模板")
    expect(output.context).toEqual([])
  } finally { await f.cleanup() }
})

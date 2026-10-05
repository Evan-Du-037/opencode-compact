import { PROTOCOL_VERSION } from "../src/core.ts"
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
  const request: Request = { version: PROTOCOL_VERSION, id: "request1", directory, sessionID, created: Date.now(), base: fingerprint(base), fields: { instructions: "下一阶段 GC；保留刚刚那段原文，省略 UI。新增背景。" }, backend: ready!.backend }
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

test("blank form replaces prompt and carries previous summary and plugin context", async () => {
  const f = await fixture()
  try {
    f.request.fields = { instructions: " \n\t" }
    f.messages.unshift({ info: { id: "old", role: "assistant", summary: true, finish: "stop" }, parts: [{ id: "old-text", type: "text", text: "之前已完成的工作" }] })
    f.request.base = fingerprint(f.messages.slice(0, -1))
    await publish(f.root, f.request)
    const output = { context: ["已有上下文"], prompt: "已有模板" }
    await f.hooks["experimental.session.compacting"]!({ sessionID: f.sessionID }, output)
    expect(output.prompt).toBe([await compactionInstructions(f.request.fields), "已有交接摘要（历史资料）：\n之前已完成的工作", "已有上下文"].join("\n\n"))
    expect(output.prompt).not.toContain("已有模板")
    expect(output.context).toEqual([])
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

for (const scenario of ["marker", "backend", "expired", "version"] as const) {
  test(`request validation reports a specific failure: ${scenario}`, async () => {
    const f = await fixture()
    try {
      const expected = { marker: "未找到本次压缩标记", backend: "不同的服务端实例", expired: "超过 10 分钟", version: "版本不一致" }[scenario]
      if (scenario === "marker") f.messages.at(-1)!.parts = []
      if (scenario === "backend") f.request.backend = "different-instance"
      if (scenario === "expired") f.request.created = Date.now() - 11 * 60_000
      if (scenario === "version") (f.request as any).version = 2
      await publish(f.root, f.request)
      await expect(f.hooks["experimental.session.compacting"]!({ sessionID: f.sessionID }, { context: [] })).rejects.toThrow(expected)
      const receipt = await read<any>(pathFor(f.root, f.directory, f.sessionID, "receipt"))
      expect(receipt.id).toBe(f.request.id)
      expect(receipt.error).toContain(expected)
    } finally { await f.cleanup() }
  })
}

test("duplicate native runtime registrations share identity, active request and lifetime", async () => {
  const f = await fixture()
  let second: Awaited<ReturnType<typeof server>> | undefined
  try {
    second = await server({ directory: f.directory, client: { session: {
      messages: async () => ({ data: f.messages }),
      message: async () => ({ data: { info: { id: "summary1", role: "assistant", summary: true, parentID: "compact1" }, parts: [] } }),
    } } } as any, { stateDir: f.root })
    const ready = await read<{ backend: string }>(pathFor(f.root, f.directory, "backend", "ready"))
    expect(ready!.backend).toBe(f.request.backend)
    // The TUI reads the last registration's readiness, but the first runtime executes compaction.
    await publish(f.root, { ...f.request, backend: ready!.backend })
    const output = { context: [] as string[], prompt: "native" }
    await f.hooks["experimental.session.compacting"]!({ sessionID: f.sessionID }, output)
    expect(output.prompt).toBe(await compactionInstructions(f.request.fields))
    await f.hooks.dispose?.()
    await f.hooks.dispose?.() // lifecycle disposal is idempotent
    expect(await read(pathFor(f.root, f.directory, "backend", "ready"))).toBeDefined()
    expect((await read<any>(pathFor(f.root, f.directory, f.sessionID, "receipt"))).status).toBe("started")
    await second["experimental.text.complete"]!({ sessionID: f.sessionID, messageID: "summary1", partID: "text1" }, { text: "summary" })
    await second.event!({ event: { type: "session.compacted", properties: { sessionID: f.sessionID } } as any })
    expect((await read<any>(pathFor(f.root, f.directory, f.sessionID, "receipt"))).status).toBe("done")
    await second.dispose?.()
    expect(await read(pathFor(f.root, f.directory, "backend", "ready"))).toBeUndefined()
  } finally { await second?.dispose?.(); await f.cleanup() }
})

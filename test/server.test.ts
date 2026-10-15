import { test, expect } from "bun:test"
import plugin from "../src/server.ts"

type Mode = "manual" | "auto" | "before_auto" | "other" | "queued_auto"
async function fixture(mode: Mode = "manual", reply = "摘要", options = {}) {
  let hook: any, rpc: any, id = "", used = false
  const generated: any[] = []
  const selections: any[] = [], admissions: any[] = []
  const request = () => ({ sessionID: "s", model: { providerID: "test", id: "m" }, messages: [{ role: "user", content: "previous checkpoint" }] })
  const marker = () => ({ id: mode === "other" ? "another" : id, type: "compaction", status: used ? "completed" : "running", reason: mode === "auto" ? "auto" : "manual", summary: reply })
  const ctx: any = {
    options, location: { directory: process.cwd() },
    session: {
      get: async () => ({ location: { directory: process.cwd() } }),
      hook: async (_: any, fn: any) => { hook = fn; return { dispose: async () => {} } },
      context: async () => mode === "before_auto" ? [] : [marker()],
      switchModel: async (input: any) => { selections.push(input) },
      compact: async (input: any) => { admissions.push({ ...input, selections: [...selections] }); id = input.id; return { id } },
      wait: async (_: any, options?: { signal: AbortSignal }) => {
        if (options) return new Promise<void>(resolve => options.signal.addEventListener("abort", () => resolve(), { once: true }))
        if (mode === "queued_auto") {
          mode = "before_auto"
          await hook(request())
          mode = "manual"
        }
        const event: any = request()
        await hook(event)
        used = !!event.result
      },
    },
    generate: { text: async (input: any) => { generated.push(input); return { text: reply } } },
    rpc: { register: async (_: any, handlers: any) => { rpc = handlers; return { dispose: async () => {} } } },
  }
  const cleanup = await plugin.setup(ctx)
  return { run: (instructions = "", model?: { providerID: string; id: string; variant?: string }) => rpc.compact({ sessionID: "s", instructions, model }), invoke: async () => { const event: any = request(); await hook(event); return event }, generated, selections, admissions, cleanup, ctx }
}

test("manual compaction commits and uses the selected model even when the hook supplies another model", async () => {
  const f = await fixture()
  const model = { providerID: "new-provider", id: "new-model", variant: "max" }
  expect(await f.run("", model)).toEqual({ ok: true })
  expect(f.admissions[0].selections).toEqual([{ sessionID: "s", model }])
  expect(f.generated[0].model).toEqual(model)
  await f.cleanup?.()
})
test("failed model selection stops before compaction or generation and permits retry", async () => {
  const f = await fixture()
  const switchModel = f.ctx.session.switchModel
  f.ctx.session.switchModel = async () => { throw new Error("model unavailable") }
  const model = { providerID: "new-provider", id: "new-model" }
  expect(await f.run("", model)).toEqual({ ok: false, error: "model unavailable" })
  expect(f.admissions).toHaveLength(0)
  expect(f.generated).toHaveLength(0)
  f.ctx.session.switchModel = switchModel
  expect(await f.run("", model)).toEqual({ ok: true })
  expect(f.generated[0].model).toEqual(model)
  await f.cleanup?.()
})

test("manual compaction uses one transient generation and preserves checkpoint transcript", async () => {
  const f = await fixture()
  expect(await f.run("保留 GC 原文")).toEqual({ ok: true })
  expect(f.generated).toHaveLength(1)
  expect(f.generated[0].prompt).toContain("保留 GC 原文")
  expect(f.generated[0].prompt).toContain("previous checkpoint")
  expect(f.generated[0].model).toEqual({ providerID: "test", id: "m" })
  expect(f.selections).toHaveLength(0)
  await f.cleanup?.()
})
test("blank form omits prompt section", async () => {
  const f = await fixture()
  expect(await f.run(" \n")).toEqual({ ok: true })
  expect(f.generated[0].prompt).not.toContain("用户提示")
})
test("automatic compaction uses the general template before or after its record opens", async () => {
  for (const mode of ["before_auto", "auto"] as const) {
    const f = await fixture(mode)
    expect((await f.invoke()).result.summary).toBe("摘要")
    expect(f.generated).toHaveLength(1)
    expect(f.generated[0].prompt).toContain("自成一体")
    expect(f.generated[0].prompt).toContain("previous checkpoint")
    expect(f.generated[0].prompt).not.toContain("用户提示")
    expect(f.generated[0].model).toEqual({ providerID: "test", id: "m" })
    expect(f.selections).toHaveLength(0)
    await f.cleanup?.()
  }
})
test("automatic compaction cannot consume the queued manual prompt", async () => {
  const f = await fixture("queued_auto")
  const model = { providerID: "manual-provider", id: "manual-model" }
  expect(await f.run("PRIVATE_MANUAL_REQUIREMENT", model)).toEqual({ ok: true })
  expect(f.generated).toHaveLength(2)
  expect(f.generated[0].prompt).not.toContain("PRIVATE_MANUAL_REQUIREMENT")
  expect(f.generated[0].prompt).not.toContain("用户提示")
  expect(f.generated[1].prompt).toContain("PRIVATE_MANUAL_REQUIREMENT")
  expect(f.generated[0].model).toEqual({ providerID: "test", id: "m" })
  expect(f.generated[1].model).toEqual(model)
})
test("unrelated manual compaction stays native", async () => {
  const f = await fixture("other")
  expect((await f.invoke()).result).toBeUndefined()
  expect((await f.run("private")).ok).toBe(false)
  expect(f.generated).toHaveLength(0)
})
test("empty output fails without returning a summary and permits manual retry", async () => {
  const f = await fixture("manual", "")
  expect((await f.run()).error).toContain("空摘要")
  expect((await f.run()).error).toContain("空摘要")
  const automatic = await fixture("before_auto", "")
  await expect(automatic.invoke()).rejects.toThrow("空摘要")
})
test("automatic compaction rejects a missing template before calling the model", async () => {
  const f = await fixture("before_auto", "摘要", { templatePath: "/nonexistent/compact-template.md" })
  await expect(f.invoke()).rejects.toThrow("无法读取压缩模板")
  expect(f.generated).toHaveLength(0)
})
test("disposing the plugin cancels in-flight automatic generation", async () => {
  const f = await fixture("before_auto")
  let started!: () => void
  const ready = new Promise<void>(resolve => { started = resolve })
  f.ctx.generate.text = async (_: any, options: { signal: AbortSignal }) => new Promise((_, reject) => {
    options.signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true })
    started()
  })
  const result = f.invoke().catch(error => error)
  await ready
  await f.cleanup?.()
  expect((await result).message).toBe("cancelled")
})

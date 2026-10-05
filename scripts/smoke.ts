import { PROTOCOL_VERSION } from "../src/core.ts"
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { createOpencodeClient } from "@opencode-ai/sdk/v2"
import { compactionInstructions, fingerprint, type Message, type Request } from "../src/core.ts"
import { pathFor, publish, read } from "../src/store.ts"
import { compactSession } from "../src/compact.ts"

const native = process.argv.includes("--hold-native")
const hold = native || process.argv.includes("--hold")
const root = await mkdtemp(join(tmpdir(), "opencode-compact-smoke-"))
const directory = join(root, "project"), configDir = join(root, "config", "opencode"), stateDir = join(root, "bridge")
await mkdir(directory, { recursive: true }); await mkdir(configDir, { recursive: true })
const requests: any[] = []
const mockSummary = "测试摘要：已确定 GC 触发条件，下一步检查写放大。"
const modelServer = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
  if (!req.url.includes("chat/completions")) return Response.json({ data: [{ id: "test", object: "model" }] })
  const body = await req.json() as any
  requests.push(body)
  let text = "验证结果：GC 在 free_blocks < 7 时触发。\n\n必须逐字保留：A  B\r\n中文🙂。"
  const isCompaction = body.messages.some((m: any) => m.role === "system" && String(m.content).includes("You are a context summarization agent"))
  if (isCompaction) text = mockSummary
  if (process.argv.includes("--slow") && isCompaction) await Bun.sleep(8000)
  const id = `chatcmpl-${Date.now()}`
  if (!body.stream) return Response.json({ id, object: "chat.completion", created: Math.floor(Date.now() / 1000), model: "test", choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }], usage: { prompt_tokens: 200, completion_tokens: 50, total_tokens: 250 } })
  const chunks = [
    { id, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: "test", choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] },
    { id, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: "test", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 200, completion_tokens: 50, total_tokens: 250 } },
  ]
  return new Response(chunks.map(c => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } })
} })
await writeFile(join(configDir, "opencode.json"), JSON.stringify({
  "$schema": "https://opencode.ai/config.json", model: "mock/test", small_model: "mock/test", enabled_providers: ["mock"], share: "disabled", autoupdate: false,
  plugin: [[pathToFileURL(resolve("src/server.ts")).href, { stateDir }]],
  permission: { "*": "deny", task: "allow" }, compaction: { auto: false, prune: false },
  agent: { "visible-test-helper": { mode: "subagent", description: "VISIBLE_HELPER_CONTROL", permission: { "*": "deny" } } },
  provider: { mock: { npm: "@ai-sdk/openai-compatible", name: "Local test", options: { baseURL: `http://127.0.0.1:${modelServer.port}/v1`, apiKey: "local-test-only" }, models: { test: { name: "Local fixture", limit: { context: 128000, output: 2048 } } } } },
}))
await writeFile(join(configDir, "tui.json"), JSON.stringify({ plugin: [[pathToFileURL(resolve("src/tui.tsx")).href, { stateDir }]] }))
await writeFile(join(root, "models.json"), "{}")
const env: Record<string, string> = {
  PATH: process.env.PATH!, TERM: "xterm-256color", LANG: "en_US.UTF-8",
  XDG_CONFIG_HOME: join(root, "config"), XDG_DATA_HOME: join(root, "data"), XDG_STATE_HOME: join(root, "state"), XDG_CACHE_HOME: join(root, "cache"),
  OPENCODE_TEST_HOME: root, OPENCODE_CONFIG_DIR: configDir, OPENCODE_TUI_CONFIG: join(configDir, "tui.json"), OPENCODE_DISABLE_PROJECT_CONFIG: "true",
  OPENCODE_DISABLE_DEFAULT_PLUGINS: "true", OPENCODE_DISABLE_AUTOUPDATE: "true", OPENCODE_DISABLE_MODELS_FETCH: "true", OPENCODE_MODELS_PATH: join(root, "models.json"),
  OPENCODE_DISABLE_CLAUDE_CODE: "true", OPENCODE_DISABLE_EXTERNAL_SKILLS: "true", OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER: "true",
}
const child = Bun.spawn(["opencode", "serve", "--hostname", "127.0.0.1", "--port", "0", "--print-logs"], { cwd: directory, env, stdout: "pipe", stderr: "pipe" })
let logs = ""
async function consume(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader()
  while (true) { const chunk = await reader.read(); if (chunk.done) break; logs += new TextDecoder().decode(chunk.value) }
}
void consume(child.stdout); void consume(child.stderr)
async function waitFor<T>(fn: () => Promise<T | undefined>, timeout = 45000): Promise<T> {
  const start = Date.now()
  while (Date.now() - start < timeout) { const result = await fn(); if (result !== undefined) return result; await Bun.sleep(100) }
  throw new Error(`Timed out. Logs: ${logs.slice(-5000)}`)
}
function assert(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message) }
try {
  const url = await waitFor(async () => logs.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0])
  const client = createOpencodeClient({ baseUrl: url, directory, throwOnError: true })
  const session = (await client.session.create({ directory, title: "Compact integration fixture" })).data!
  const sessionID = session.id
  await client.session.prompt({ sessionID, directory, model: { providerID: "mock", modelID: "test" }, parts: [{ type: "text", text: "讨论 GC 触发条件，请回答测试原文。" }] })
  const normalRequest = requests.find(r => JSON.stringify(r.tools).includes("task"))
  assert(normalRequest, "task tool was not exposed in test fixture")
  assert(JSON.stringify(normalRequest).includes("visible-test-helper"), "control subagent missing from model request")
  assert(!JSON.stringify(normalRequest).includes("compact-quote-picker"), "internal picker leaked into model request")
  const agents = (await client.app.agents({ directory })).data!
  assert(!agents.some(a => a.name === "compact-quote-picker"), "removed picker still registered")
  const history = (await client.session.messages({ sessionID, directory })).data! as Message[]
  const ready = await waitFor(() => read<{ backend: string }>(pathFor(stateDir, directory, "backend", "ready")))
  if (hold) {
    if (native) { child.kill(); await child.exited }
    await writeFile(join(root, "attach.json"), JSON.stringify({ url, sessionID, directory, env, root }))
    console.log(`HOLD ${join(root, "attach.json")}`)
    await new Promise<void>(resolvePromise => { process.on("SIGTERM", resolvePromise); process.on("SIGINT", resolvePromise) })
  } else {
    const request: Request = { version: PROTOCOL_VERSION, id: crypto.randomUUID(), directory, sessionID, created: Date.now(), base: fingerprint(history), fields: { instructions: "接下来只检查 GC 写放大，保留最后的 GC 原文，省略 UI。补充背景：下一阶段时间预算 30 分钟。" }, backend: ready.backend }
    const beforeCalls = requests.length
    await publish(stateDir, request)
    await client.session.summarize({ sessionID, directory, providerID: "mock", modelID: "test", auto: false })
    const receipt = await waitFor(async () => { const r = await read<any>(pathFor(stateDir, directory, sessionID, "receipt")); return r?.status === "done" || r?.status === "error" ? r : undefined })
    assert(receipt.status === "done", `compaction failed: ${JSON.stringify(receipt)}`)
    const after = (await client.session.messages({ sessionID, directory })).data!
    const summary = after.findLast(m => m.info.role === "assistant" && m.info.summary)
    assert(summary, "no persisted summary")
    const text = summary.parts.filter(p => p.type === "text").map(p => p.text).join("\n")
    assert(text === mockSummary, "plugin rewrote or appended content to model summary")
    const compactRequests = requests.slice(beforeCalls)
    assert(compactRequests.length === 1, `expected one compaction call, got ${compactRequests.length}`)
    const compact = JSON.stringify(compactRequests[0].messages)
    assert(compact.includes(JSON.stringify(await compactionInstructions(request.fields)).slice(1, -1)), "dynamic prompt missing")
    assert(compact.includes("free_blocks < 7"), "native historical conversation missing")
    assert(!compact.includes("Output exactly the Markdown structure shown inside <template>"), "default summary template still present")
    assert(!(await client.session.children({ sessionID, directory })).data!.length, "unexpected child session")
    await client.session.prompt({ sessionID, directory, model: { providerID: "mock", modelID: "test" }, parts: [{ type: "text", text: "继续。" }] })
    const continuation = JSON.stringify(requests.at(-1))
    assert(continuation.includes(mockSummary), "model summary missing from continuation")
    assert(!continuation.includes(JSON.stringify(await compactionInstructions(request.fields)).slice(1, -1)), "instructions leaked into normal continuation")
    const history2 = (await client.session.messages({ sessionID, directory })).data! as Message[]
    const request2: Request = { ...request, id: crypto.randomUUID(), base: fingerprint(history2), created: Date.now(), fields: { instructions: "第二次只检查测试" } }
    const beforeSecond = requests.length
    await publish(stateDir, request2)
    await client.session.summarize({ sessionID, directory, providerID: "mock", modelID: "test", auto: false })
    assert(requests.length === beforeSecond + 1, "second compaction made extra calls")
    const second = JSON.stringify(requests.at(-1).messages)
    assert(second.includes("已有交接摘要（历史资料）"), "previous summary missing from repeated compaction")
    assert(second.includes(mockSummary), "previous model summary missing")
    assert(!second.includes(request.fields.instructions), "previous instructions leaked into next compaction")
    const fork = (await client.session.fork({ sessionID, directory })).data!
    await compactSession({ api: { client, state: { config: {} } } as any, root: stateDir, directory,
      sessionID: fork.id, fields: { instructions: "" }, signal: new AbortController().signal })
    const blank = JSON.stringify(requests.at(-1).messages)
    assert(blank.includes("压缩后的内容必须自成一体"), "blank fork compaction lost general template requirements")
    assert(!blank.includes("用户提示") && !blank.includes("未提供") && !blank.includes("未填写"), "blank compaction mentions user instructions")
    console.log("PASS: fork session with blank form completed through the TUI submission function")
    console.log("PASS: no picker agent, one model call, replacement prompt with history, unmodified model summary, continuation and repeated compaction")
    console.log(`Isolated test files: ${root}`)
  }
} finally {
  child.kill()
  const timeout = setTimeout(() => child.kill("SIGKILL"), 2000)
  await child.exited; clearTimeout(timeout)
  await writeFile(join(root, "model-requests.json"), JSON.stringify(requests, null, 2))
  modelServer.stop(true)
  await writeFile(join(root, "server.log"), logs)
}

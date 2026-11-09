import { mkdtemp, mkdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { createServer } from "node:http"
import { OpenCode } from "@opencode/client"
import { compactSession } from "../src/compact.ts"
import { compactRpc } from "../src/rpc.ts"
const root = await mkdtemp(join(tmpdir(), "compact-v2-"))
const directory = join(root, "project"), configDir = join(root, "config/opencode")
await mkdir(directory, { recursive: true }); await mkdir(configDir, { recursive: true })
const requests: any[] = []
const requestPaths: string[] = []
const auto = process.argv.includes("--auto")
const overflow = process.argv.includes("--overflow")
const overflowFail = process.argv.includes("--overflow-fail")
const progressTest = process.argv.includes("--progress")
const disconnect = process.argv.includes("--disconnect")
const disconnectAlways = process.argv.includes("--disconnect-always")
const disconnectCancel = process.argv.includes("--disconnect-cancel")
const attemptedPrompts = new Map<string, number>()
let disconnectPrompt: string | undefined
let resetCount = 0
let releaseProgress!: () => void
const progressGate = new Promise<void>(resolve => { releaseProgress = resolve })
let fragments = 0
const promptTokens = auto ? 31000 : 200
const model = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
  const body = await req.json() as any
  requests.push(body)
  requestPaths.push(new URL(req.url).pathname)
  await writeFile(join(root, "requests.json"), JSON.stringify(requests, null, 2))
  const compact = JSON.stringify(body).includes("会话压缩指南")
  if (compact && progressTest) await progressGate
  if (compact && process.argv.includes("--slow")) await Bun.sleep(8000)
  const prompt = (body.messages ?? []).map((m: any) => typeof m.content === "string" ? m.content : (m.content ?? []).map((p: any) => p.text ?? "").join("\n")).join("\n")
  if (overflow && compact && prompt.length > 7000) return Response.json({error:{code:"context_length_exceeded",message:"context_length_exceeded: Your input exceeds the context window of this model."}},{status:400})
  const fragment = compact && prompt.includes("[compact-stage: fragment]")
  if (disconnect && compact) {
    const attempts = (attemptedPrompts.get(prompt) ?? 0) + 1
    attemptedPrompts.set(prompt, attempts)
    // For chunk recovery, first complete one fragment, then break the next one.
    if (disconnectPrompt === undefined && (!overflow || (fragment && fragments >= 1))) disconnectPrompt = prompt
    if (prompt === disconnectPrompt && (disconnectAlways || attempts === 1)) {
      resetCount++
      return new Response("", { headers: { "x-fixture-reset": "true" } })
    }
  }
  if (fragment && ++fragments === 2 && overflowFail) return Response.json({error:{message:"fixture chunk failure"}},{status:400})
  if(compact && process.argv.includes("--fail")) return Response.json({error:{message:"fixture generation rejected"}},{status:400})
  const text = fragment ? JSON.stringify({summary:"GC 中间事实，下一步检查写放大。",quotes:[]}) : compact ? "测试摘要：GC 在 free_blocks < 7 时触发；下一步检查写放大。" : "## Objective\n验证 GC 原文 A  B 中文🙂。"
  const id = `chatcmpl-${Date.now()}`
  if (!body.stream) return Response.json({ id, object: "chat.completion", created: 1, model: "test", choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }], usage: { prompt_tokens: promptTokens, completion_tokens: 30, total_tokens: promptTokens + 30 } })
  return new Response(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", model: "test", choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id, object: "chat.completion.chunk", model: "test", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: promptTokens, completion_tokens: 30, total_tokens: promptTokens + 30 } })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } })
} })
// A real truncated HTTP/SSE response exercises OpenCode's transport error mapping.
// Only the local fixture is contacted; neither real conversations nor credentials are used.
const proxy = createServer(async (req, res) => {
  try {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(Buffer.from(chunk))
    const response = await fetch(`http://127.0.0.1:${model.port}${req.url}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: Buffer.concat(chunks),
    })
    if (response.headers.has("x-fixture-reset")) {
      res.writeHead(200, { "content-type": "text/event-stream", "connection": "close" })
      res.write(`data: ${JSON.stringify({ id: "fixture-reset", object: "chat.completion.chunk", model: "test", choices: [{ index: 0, delta: { role: "assistant", content: "INCOMPLETE_FIXTURE_OUTPUT" }, finish_reason: null }] })}\n\n`)
      setTimeout(() => res.destroy(), 100)
      return
    }
    res.writeHead(response.status, { "content-type": response.headers.get("content-type") ?? "application/json" })
    res.end(Buffer.from(await response.arrayBuffer()))
  } catch { res.destroy() }
})
if (disconnect) await new Promise<void>(resolve => proxy.listen(0, "127.0.0.1", resolve))
const providerPort = disconnect ? (proxy.address() as { port: number }).port : model.port
await writeFile(join(configDir, "opencode.json"), JSON.stringify({
  model: "mock/test", plugins: [{ package: pathToFileURL(resolve(".")).href }],
  compaction: { auto, keep: { tokens: 0 } },
  providers: {
    mock: { name: "Local fixture", package: "@ai-sdk/openai-compatible", settings: { baseURL: `http://127.0.0.1:${providerPort}/v1`, apiKey: "local-test" }, models: { test: { name: "Local fixture", limit: { context: auto ? 32000 : 128000, output: 2048 } } } },
    selected: { name: "Selected fixture", package: "@ai-sdk/openai-compatible", settings: { baseURL: `http://127.0.0.1:${providerPort}/selected/v1`, apiKey: "local-test" }, models: { replacement: { name: "Selected fixture", limit: { context: 128000, output: 2048 } } } },
  },
}))
const env = { ...process.env, HOME: root, XDG_CONFIG_HOME: join(root,"config"), XDG_DATA_HOME: join(root,"data"), XDG_STATE_HOME: join(root,"state"), XDG_CACHE_HOME: join(root,"cache"), OPENCODE_CONFIG_DIR: configDir, OPENCODE_TEST_HOME: root, OPENCODE_DISABLE_PROJECT_CONFIG: "true", OPENCODE_DISABLE_AUTOUPDATE: "true" }
const child = Bun.spawn(["opencode", "serve", "--hostname", "127.0.0.1", "--port", "0", "--print-logs"], { cwd: directory, env, stdout: "pipe", stderr: "pipe" })
let logs = ""
for (const stream of [child.stdout,child.stderr]) void (async () => { for await (const chunk of stream) { logs += new TextDecoder().decode(chunk); await writeFile(join(root,"server.log"),logs) } })()
async function until<T>(f:()=>Promise<T|undefined>, ms=60000): Promise<T> { const deadline=Date.now()+ms; while(Date.now()<deadline){ const v=await f();if(v!==undefined)return v;await Bun.sleep(100) }throw new Error(logs.slice(-7000)) }
function assert(v:unknown,msg:string):asserts v {if(!v)throw new Error(msg)}
console.log("FIXTURE",root)
try {
 const url=await until(async()=>logs.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0])
 const client=OpenCode.make({baseUrl:url,headers:{authorization:`Basic ${Buffer.from(`opencode:${logs.match(/server password (\S+)/)?.[1]}`).toString("base64")}`}})
 console.log("SERVER",url)

 await until(async()=>{ const p=await client.plugin.list({location:{directory}}); if(p.data.some(p=>p.id==="evan.compact-form" || p.state.status==="failed")){console.log("PLUGIN",JSON.stringify(p.data.filter(p=>p.id==="evan.compact-form")));return p} })
 const session=await client.session.create({title:"Compact v2 smoke",location:{directory}})
 await client.session.switchModel({sessionID:session.id,model:{providerID:"mock",id:"test"}})
 await client.session.prompt({sessionID:session.id,text:"讨论 GC 触发条件，原文 A  B 中文🙂。" + (overflow ? "历史事实 ABC 中文🙂。".repeat(1200) : "")})
 await client.session.wait({sessionID:session.id})
 if(disconnect) {
  const work = (auto
   ? client.session.prompt({sessionID:session.id,text:"触发自动压缩。"}).then(()=>client.session.wait({sessionID:session.id}))
   : compactSession({client,location:{directory},sessionID:session.id,fields:{instructions:""},model:{providerID:"selected",id:"replacement"}})).then(()=>undefined,error=>error)
  const status=()=>client.rpc(compactRpc).progress({sessionID:session.id},{location:{directory}}) as Promise<any>
  const retry=await until(async()=>{const p=(await status()).progress;return p?.retry?.retryAt ? p : undefined})
  assert(retry.retry.attempt===1 && retry.retry.maxAttempts===2,"Missing bounded retry status")
  assert(retry.mode===(auto?"auto":"manual"),"Wrong retry mode")
  if(overflow) assert(retry.completedFragments===1,"Completed fragment was not preserved")
  if(disconnectCancel) await client.session.interrupt({sessionID:session.id})
  const error=await work
  const history=await client.session.context({sessionID:session.id})
  const completed=history.filter(m=>m.type==="compaction"&&m.status==="completed")
  const custom=requests.filter(r=>JSON.stringify(r).includes("会话压缩指南"))
  assert(custom.every(r=>r.model===(auto?"test":"replacement")),"Retry changed selected model")
  assert(custom.every(r=>!JSON.stringify(r).includes("用户提示")),"Empty user prompt section leaked")
  assert(disconnectPrompt!==undefined,"Fixture never reset a response")
  if(disconnectAlways || disconnectCancel) {
   assert(completed.length===0,"Partial response became a successful checkpoint")
   assert(history.some(m=>m.type==="user"&&m.text.includes("讨论 GC")),"Original history was lost")
   if(!auto) assert(error,"Expected manual failure or cancellation")
   if(disconnectCancel) {
    await Bun.sleep(2300)
    assert(resetCount===1,"Sent another request after cancellation")
   } else {
    assert(resetCount===3 && attemptedPrompts.get(disconnectPrompt)===3,"Persistent failure exceeded retry bound")
    assert((await status()).progress?.phase==="failed","Missing failed progress")
   }
  } else {
   assert(!error,String(error))
   assert(resetCount===1 && attemptedPrompts.get(disconnectPrompt)===2,"Did not recover with exactly one retry")
   assert([...attemptedPrompts].every(([p,count])=>p===disconnectPrompt || count===1),"Regenerated previously completed work")
   assert(completed.length===1 && !JSON.stringify(completed).includes("INCOMPLETE_FIXTURE_OUTPUT"),"Missing complete checkpoint or leaked partial response")
   const done=(await status()).progress
   assert(done.phase==="complete" && !done.retry,"Retry status persisted after completion")
   if(!auto) {await client.session.prompt({sessionID:session.id,text:"继续。"});await client.session.wait({sessionID:session.id})}
   assert(JSON.stringify(requests.at(-1)).includes("测试摘要"),"Continuation missing final checkpoint")
  }
  console.log("PASS",auto?"automatic":"manual",overflow?"chunk":"whole","real response disconnect",disconnectCancel?"cancellation":disconnectAlways?"bounded failure":"retry, progress, model and continuation")
 } else if(progressTest) {
  const work = (auto
   ? client.session.prompt({sessionID:session.id,text:"触发自动压缩。"}).then(()=>client.session.wait({sessionID:session.id}))
   : compactSession({client,location:{directory},sessionID:session.id,fields:{instructions:""}})).then(()=>undefined,error=>error)
  await until(async()=>requests.some(r=>JSON.stringify(r).includes("会话压缩指南"))?true:undefined)
  const status=()=>client.rpc(compactRpc).progress({sessionID:session.id},{location:{directory}}) as Promise<any>
  const live=(await status()).progress
  assert(live.phase==="generating" && live.endedAt===undefined,"Missing live generation progress")
  assert(live.mode===(auto?"auto":"manual") && live.calls===1,"Incorrect progress mode/counter")
  await Bun.sleep(200)
  assert((await status()).progress.startedAt===live.startedAt,"Elapsed time restarted on read")
  releaseProgress()
  const result=await work
  if(result) throw result
  const done=(await status()).progress
  assert(done.phase==="complete" && typeof done.endedAt==="number","Missing terminal progress")
  console.log("PASS",auto?"automatic":"manual","live progress and generation completion")
 } else if(overflow) {
  const count=requests.length
  if(auto) {
   await client.session.prompt({sessionID:session.id,text:"继续测试自动压缩。"})
   await client.session.wait({sessionID:session.id})
  } else {
   try {
    await compactSession({client,location:{directory},sessionID:session.id,fields:{instructions:"保留关键事实"},model:{providerID:"selected",id:"replacement"}})
    assert(!overflowFail,"Expected chunk failure")
   } catch(error) { assert(overflowFail && String(error).includes("fixture chunk failure"),String(error)) }
  }
  const custom=requests.slice(count).filter(r=>JSON.stringify(r).includes("会话压缩指南"))
  assert(custom.length>3,"Recovery did not split and retry")
  assert(fragments>=2,"Missing chunk processing")
  assert(custom.every(r=>r.model===(auto?"test":"replacement")),"Model changed during recovery")
  assert(custom.every(r=>auto?!JSON.stringify(r).includes("用户提示"):JSON.stringify(r).includes("保留关键事实")),"Requirements were not preserved across stages")
  const history=await client.session.context({sessionID:session.id})
  const completed=history.filter(m=>m.type==="compaction"&&m.status==="completed")
  if(overflowFail) {
   assert(completed.length===0,"A partial summary was committed")
   assert(history.some(m=>m.type==="user"&&m.text.includes("历史事实")),"Source history was lost")
   assert(!custom.some(r=>JSON.stringify(r).includes("[compact-stage: merge]")),"Merged after failed chunk")
   if(auto) assert((await client.session.get({sessionID:session.id})).outcome==="failed","Automatic failure did not stop")
   console.log("PASS",auto?"automatic":"manual","chunk failure preserves history without committing a summary")
  } else {
   assert(completed.length===1,"Expected exactly one completed summary")
   assert(JSON.stringify(custom.at(-1)).includes("[compact-stage: merge]"),"Final result was not merged")
   if(!auto) {
    await client.session.prompt({sessionID:session.id,text:"继续讨论 GC。"})
    await client.session.wait({sessionID:session.id})
   }
   assert(JSON.stringify(requests.at(-1)).includes("测试摘要"),"Continuation did not receive final checkpoint")
   console.log("PASS",auto?"automatic":"manual","overflow recovery, selected model, final checkpoint and continuation")
  }
 } else if(process.argv.includes("--model-switch")) {
  assert((await client.session.get({sessionID:session.id})).model?.providerID==="mock","Expected original session provider")
  const count=requests.length
  // Simulate the uncommitted composer selection: no switchModel or ordinary prompt first.
  await compactSession({client,location:{directory},sessionID:session.id,fields:{instructions:""},model:{providerID:"selected",id:"replacement"}})
  assert(requests.length===count+1,"Expected exactly one summary call")
  assert(requests[count].model==="replacement","Compaction used the old model")
  assert(requestPaths[count]==="/selected/v1/chat/completions","Compaction used the old provider endpoint")
  assert(JSON.stringify(requests[count]).includes("会话压缩指南"),"Custom prompt missing")
  assert(!JSON.stringify(requests[count]).includes("用户提示"),"Blank user prompt section leaked")
  const state=await client.session.get({sessionID:session.id})
  assert(state.model?.providerID==="selected" && state.model.id==="replacement","Selected model was not committed")
  const history=await client.session.context({sessionID:session.id})
  assert(history.some(m=>m.type==="compaction"&&m.status==="completed"),"Compaction did not complete")
  console.log("PASS direct compaction switches provider and model without a preceding message")
 } else if(process.argv.includes("--fail") && !auto) {
  const count=requests.length
  try {await compactSession({client,location:{directory},sessionID:session.id,fields:{instructions:"failure test"}});throw new Error("Expected failure")}catch(error){assert(String(error).includes("fixture generation rejected"),String(error))}
  assert(requests.length-count===1,"Failure fell back to native template")
  console.log("PASS failure does not silently compact")
 } else if(auto) {
  await client.session.prompt({sessionID:session.id,text:"继续测试自动压缩。"})
  await client.session.wait({sessionID:session.id})
  const history=await client.session.context({sessionID:session.id})
  const custom=requests.filter(r=>JSON.stringify(r).includes("会话压缩指南"))
  assert(custom.length===1,"Expected one custom automatic summary")
  assert(!JSON.stringify(custom[0]).includes("用户提示"),"Automatic compaction included user prompt section")
  assert(!JSON.stringify(custom[0]).includes("You MUST use this format"),"Native template leaked")
  if(process.argv.includes("--fail")) {
    assert((await client.session.get({sessionID:session.id})).outcome==="failed","Failed automatic summary did not stop execution")
    assert(!history.some(m=>m.type==="compaction"&&m.status==="completed"),"Failed automatic summary was persisted")
    assert(requests.length===2,"Failed automatic summary silently fell back or continued")
    console.log("PASS automatic failure preserves history without fallback")
  } else {
    assert(history.some(m=>m.type==="compaction"&&m.reason==="auto"&&m.status==="completed"&&m.summary.includes("测试摘要")),"Custom automatic compaction did not complete")
    assert(requests.length===3,"Agent did not resume after automatic compaction")
    assert(JSON.stringify(requests.at(-1)).includes("测试摘要"),"Next model call did not receive the custom checkpoint")
    console.log("PASS custom automatic compaction and agent continuation")
  }
 } else if(process.argv.includes("--hold") || process.argv.includes("--hold-native")) {
  if(process.argv.includes("--hold-native")){child.kill();await child.exited}
  await writeFile(join(root,"attach.json"),JSON.stringify({url,sessionID:session.id,directory,env,root}))
  console.log("HOLD",join(root,"attach.json"))
  await new Promise<void>(done=>{process.on("SIGTERM",done);process.on("SIGINT",done)})
 } else {
  for(const instructions of ["接下来检查 GC 写放大，保留原文。", "   "]){
   const count=requests.length
   await compactSession({client,location:{directory},sessionID:session.id,fields:{instructions}})
   const compact=requests.slice(count).filter(r=>JSON.stringify(r).includes("会话压缩指南"))
   assert(compact.length===1,`Expected one custom request: ${JSON.stringify(requests.slice(count))}`)
   assert(!JSON.stringify(compact[0]).includes("You MUST use this format"),"Default prompt leaked")
   assert(instructions.trim()?JSON.stringify(compact[0]).includes(instructions):!JSON.stringify(compact[0]).includes("## 用户提示"),"Conditional block failed")
   console.log("PASS",instructions.trim()?"with instructions":"blank instructions")
   await client.session.prompt({sessionID:session.id,text:"继续讨论 GC。"})
   await client.session.wait({sessionID:session.id})
  }
 }
} finally {releaseProgress();child.kill();await child.exited;proxy.closeAllConnections();proxy.close();model.stop()}

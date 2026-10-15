import { mkdtemp, mkdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { OpenCode } from "@opencode/client"
import { compactSession } from "../src/compact.ts"
const root = await mkdtemp(join(tmpdir(), "compact-v2-"))
const directory = join(root, "project"), configDir = join(root, "config/opencode")
await mkdir(directory, { recursive: true }); await mkdir(configDir, { recursive: true })
const requests: any[] = []
const requestPaths: string[] = []
const auto = process.argv.includes("--auto")
const promptTokens = auto ? 31000 : 200
const model = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
  const body = await req.json() as any
  requests.push(body)
  requestPaths.push(new URL(req.url).pathname)
  await writeFile(join(root, "requests.json"), JSON.stringify(requests, null, 2))
  const compact = JSON.stringify(body).includes("会话压缩指南")
  if(compact && process.argv.includes("--fail")) return Response.json({error:{message:"fixture generation rejected"}},{status:400})
  const text = compact ? "测试摘要：GC 在 free_blocks < 7 时触发；下一步检查写放大。" : "## Objective\n验证 GC 原文 A  B 中文🙂。"
  const id = `chatcmpl-${Date.now()}`
  if (!body.stream) return Response.json({ id, object: "chat.completion", created: 1, model: "test", choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }], usage: { prompt_tokens: promptTokens, completion_tokens: 30, total_tokens: promptTokens + 30 } })
  return new Response(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", model: "test", choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id, object: "chat.completion.chunk", model: "test", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: promptTokens, completion_tokens: 30, total_tokens: promptTokens + 30 } })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } })
} })
await writeFile(join(configDir, "opencode.json"), JSON.stringify({
  model: "mock/test", plugins: [{ package: pathToFileURL(resolve(".")).href }],
  compaction: { auto, keep: { tokens: 0 } },
  providers: {
    mock: { name: "Local fixture", package: "@ai-sdk/openai-compatible", settings: { baseURL: `http://127.0.0.1:${model.port}/v1`, apiKey: "local-test" }, models: { test: { name: "Local fixture", limit: { context: auto ? 32000 : 128000, output: 2048 } } } },
    selected: { name: "Selected fixture", package: "@ai-sdk/openai-compatible", settings: { baseURL: `http://127.0.0.1:${model.port}/selected/v1`, apiKey: "local-test" }, models: { replacement: { name: "Selected fixture", limit: { context: 128000, output: 2048 } } } },
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
 await client.session.prompt({sessionID:session.id,text:"讨论 GC 触发条件，原文 A  B 中文🙂。"})
 await client.session.wait({sessionID:session.id})
 if(process.argv.includes("--model-switch")) {
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
} finally {child.kill();await child.exited;model.stop()}

import { test, expect } from "bun:test"
import { mkdtemp, readFile, writeFile, readdir, rm } from "node:fs/promises"
import { join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { parse } from "jsonc-parser"

test("installer preserves JSONC and unrelated plugins; repeat install and uninstall are safe", async () => {
  const root = await mkdtemp(join(tmpdir(), "compact-install-"))
  const run = async (...args: string[]) => {
    const child = Bun.spawn(["node", "scripts/install.mjs", "--config-dir", root, ...args], { stdout: "pipe", stderr: "pipe" })
    const code = await child.exited
    if (code) throw new Error(await new Response(child.stderr).text())
  }
  try {
    await writeFile(join(root, "opencode.jsonc"), '{\n  // keep my comment\n  "plugins": ["existing-plugin"],\n  "model": "mine/test",\n}\n')
    await run(); await run()
    const text = await readFile(join(root, "opencode.jsonc"), "utf8")
    expect(text).toContain("// keep my comment")
    const cfg = parse(text)
    expect(cfg.plugins.length).toBe(2)
    expect(cfg.plugins[0]).toBe("existing-plugin")
    expect(cfg.model).toBe("mine/test")
    expect((await readdir(root)).some(name => name.includes("bak-compact"))).toBe(true)
    await run("--uninstall")
    expect(parse(await readFile(join(root, "opencode.jsonc"), "utf8")).plugins).toEqual(["existing-plugin"])
  } finally { await rm(root, { recursive: true, force: true }) }
})

test("invalid second config leaves the first config untouched", async () => {
  const root = await mkdtemp(join(tmpdir(), "compact-install-bad-"))
  try {
    await writeFile(join(root, "opencode.json"), '{"model":"keep/me"}\n')
    await writeFile(join(root, "tui.json"), 'bad json')
    const child = Bun.spawn(["node", "scripts/install.mjs", "--config-dir", root], { stdout: "pipe", stderr: "pipe" })
    expect(await child.exited).not.toBe(0)
    expect(await readFile(join(root, "opencode.json"), "utf8")).toBe('{"model":"keep/me"}\n')
  } finally { await rm(root, { recursive: true, force: true }) }
})

test("uninstall also removes a previous registration in a lower-precedence JSON file", async () => {
  const root = await mkdtemp(join(tmpdir(), "compact-install-dual-"))
  const run = async (...args: string[]) => {
    const child = Bun.spawn(["node", "scripts/install.mjs", "--config-dir", root, ...args], { stdout: "pipe", stderr: "pipe" })
    expect(await child.exited).toBe(0)
  }
  try {
    await run()
    await writeFile(join(root, "opencode.jsonc"), '{"plugins":["other"]}\n')
    await run()
    expect(parse(await readFile(join(root, "opencode.json"), "utf8")).plugins).toBeUndefined()
    await run("--uninstall")
    expect(parse(await readFile(join(root, "opencode.jsonc"), "utf8")).plugins).toEqual(["other"])
  } finally { await rm(root, { recursive: true, force: true }) }
})


test("migration removes only this plugin's v1 file entries and redundant CLI registration", async () => {
 const dir=await mkdtemp(join(tmpdir(),"compact-migrate-"))
 const base=new URL(`file://${resolve(".")}/`).href
 try {
  await writeFile(join(dir,"opencode.json"),JSON.stringify({plugin:[[base+"src/server.ts",{stateDir:"old"}],"keep-v1"],plugins:["keep-v2"]}))
  await writeFile(join(dir,"cli.json"),JSON.stringify({plugins:[{package:base+"src/tui.tsx"},"-opencode.notifications","other-plugin"]}))
  await writeFile(join(dir,"tui.json"),JSON.stringify({plugin:[[base+"src/tui.tsx",{}]],theme:"mine"}))
  const p=Bun.spawn(["node","scripts/install.mjs","--config-dir",dir],{stdout:"pipe",stderr:"pipe"});expect(await p.exited).toBe(0)
  const server=parse(await readFile(join(dir,"opencode.json"),"utf8"));expect(server.plugin).toEqual(["keep-v1"]);expect(server.plugins).toHaveLength(2)
  expect(parse(await readFile(join(dir,"cli.json"),"utf8")).plugins).toEqual(["-opencode.notifications","other-plugin"])
  expect(parse(await readFile(join(dir,"tui.json"),"utf8"))).toEqual({theme:"mine"})
 } finally {await rm(dir,{recursive:true,force:true})}
})

import { test, expect } from "bun:test"
import { mkdtemp, readFile, writeFile, readdir, rm } from "node:fs/promises"
import { join } from "node:path"
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
    await writeFile(join(root, "opencode.jsonc"), '{\n  // keep my comment\n  "plugin": ["existing-plugin"],\n  "model": "mine/test",\n}\n')
    await run(); await run()
    const text = await readFile(join(root, "opencode.jsonc"), "utf8")
    expect(text).toContain("// keep my comment")
    const cfg = parse(text)
    expect(cfg.plugin.length).toBe(2)
    expect(cfg.plugin[0]).toBe("existing-plugin")
    expect(cfg.model).toBe("mine/test")
    expect((await readdir(root)).some(name => name.includes("bak-compact"))).toBe(true)
    await run("--uninstall")
    expect(parse(await readFile(join(root, "opencode.jsonc"), "utf8")).plugin).toEqual(["existing-plugin"])
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
    await writeFile(join(root, "opencode.jsonc"), '{"plugin":["other"]}\n')
    await run()
    expect(parse(await readFile(join(root, "opencode.json"), "utf8")).plugin).toEqual([])
    await run("--uninstall")
    expect(parse(await readFile(join(root, "opencode.jsonc"), "utf8")).plugin).toEqual(["other"])
  } finally { await rm(root, { recursive: true, force: true }) }
})

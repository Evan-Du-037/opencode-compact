import { test, expect } from "bun:test"
import { readFile } from "node:fs/promises"
import { compactionInstructions, fingerprint, previousHandoff, visibleHistory, type Message } from "../src/core.ts"

const empty = { focus: "", preserve: "", discard: "", extra: "" }
test("empty and whitespace-only fields add no instructions", async () => {
  for (const blank of ["", " \t\r\n　"]) expect(await compactionInstructions({ focus: blank, preserve: blank, discard: blank, extra: blank })).toBe("")
})
test("editable template inserts all four fields without leaving template syntax", async () => {
  const fields = { focus: "重点测试内容", preserve: "原文定位测试内容", discard: "省略测试内容", extra: "额外信息测试内容" }
  const prompt = await compactionInstructions(fields)
  for (const value of Object.values(fields)) expect(prompt).toContain(value)
  expect(prompt).not.toMatch(/{{[#/]?(focus|preserve|discard|extra)}}/)
})
test("editable template drops the entire unfilled sections regardless of their wording", async () => {
  const template = await readFile(new URL("../compact-prompt.md", import.meta.url), "utf8")
  const locator = "刚刚讨论的接口定义"
  const prompt = await compactionInstructions({ ...empty, preserve: locator })
  expect(prompt).toContain(locator)
  for (const key of ["focus", "discard", "extra"]) {
    const start = template.indexOf(`{{#${key}}}`), end = template.indexOf(`{{/${key}}}`)
    const body = template.slice(start + `{{#${key}}}`.length, end)
    const heading = body.split("\n").find(line => line.trim().startsWith("#"))
    if (heading) expect(prompt).not.toContain(heading)
  }
  expect(prompt).not.toMatch(/{{[#/]?(focus|preserve|discard|extra)}}/)
})
test("history snapshot detects edits and excludes reverted messages", () => {
  const messages: Message[] = [{ info: { id: "m1", role: "user" }, parts: [{ id: "p1", type: "text", text: "old" }] }]
  expect(visibleHistory(messages, "m1")).toEqual([])
  const changed = structuredClone(messages); changed[0]!.parts[0]!.text = "new"
  expect(fingerprint(changed)).not.toBe(fingerprint(messages))
})
test("only the latest successful previous summary is carried forward", () => {
  const messages: Message[] = [
    { info: { id: "m1", role: "assistant", summary: true, finish: "stop" }, parts: [{ id: "p1", type: "text", text: "上一轮交接" }] },
    { info: { id: "m2", role: "assistant", summary: true, finish: "stop", error: {} }, parts: [{ id: "p2", type: "text", text: "失败摘要" }] },
    { info: { id: "m3", role: "assistant", summary: true }, parts: [{ id: "p3", type: "text", text: "尚未完成" }] },
  ]
  expect(previousHandoff(messages)).toBe("上一轮交接")
  expect(previousHandoff([])).toBeUndefined()
})

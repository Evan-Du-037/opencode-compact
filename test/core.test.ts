import { test, expect } from "bun:test"
import { readFile } from "node:fs/promises"
import { compactionInstructions, fingerprint, previousHandoff, visibleHistory, type Message } from "../src/core.ts"

test("empty and whitespace-only forms retain general requirements and omit the user block", async () => {
  const template = await readFile(new URL("../compact-prompt.md", import.meta.url), "utf8")
  const general = template.replace(/{{#instructions}}[\s\S]*?{{\/instructions}}/g, "").trim()
  expect(general).not.toBe("")
  expect(general).not.toContain("用户提示")
  expect(general).not.toContain("未提供")
  expect(general).not.toContain("未填写")
  for (const blank of ["", " \t\r\n　"]) expect(await compactionInstructions({ instructions: blank })).toBe(general)
})
test("editable template inserts a free-form prompt literally", async () => {
  const instructions = "下一步只检查 GC。\n刚刚那段接口定义保留原文；不需要 UI。\n## 自己的标题\n{{focus}} {{instructions}}"
  const prompt = await compactionInstructions({ instructions })
  expect(prompt).toContain(instructions)
  expect(prompt).not.toContain("{{#instructions}}")
  expect(prompt).not.toContain("{{/instructions}}")
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

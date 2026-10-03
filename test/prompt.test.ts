import { test, expect } from "bun:test"
import { mkdtemp, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { compactionInstructions, renderCompactionTemplate } from "../src/prompt.ts"

const empty = { focus: "", preserve: "", discard: "", extra: "" }
const template = "通用指令\n" + Object.keys(empty).map(key => `{{#${key}}}\n标题-${key}\n{{${key}}}\n说明-${key}\n{{/${key}}}`).join("\n")

test("empty blocks omit headings and instructions, while field contents remain literal", () => {
  const value = "中文🙂  $&\r\n{{extra}} {{#focus}}"
  const prompt = renderCompactionTemplate(template, { ...empty, focus: value, preserve: " \n" })
  expect(prompt).toContain(value)
  expect(prompt).toContain("标题-focus")
  expect(prompt).toContain("说明-focus")
  for (const name of ["preserve", "discard", "extra"]) {
    expect(prompt).not.toContain(`标题-${name}`)
    expect(prompt).not.toContain(`说明-${name}`)
  }
})

test("malformed templates fail explicitly instead of silently dropping user instructions", () => {
  for (const invalid of [
    template.replace("{{focus}}", "{{foucs}}"),
    template.replace("{{focus}}", ""),
    template.replace("{{/preserve}}", "{{/extra}}"),
    template.replace("{{/extra}}", ""),
    template.replace("{{extra}}", "{{extra}}{{extra}}"),
    template.replace("{{#preserve}}", "{{#preserve}}{{#extra}}"),
  ]) expect(() => renderCompactionTemplate(invalid, { ...empty, focus: "要求" })).toThrow("压缩模板格式错误")
})

test("template changes are loaded on the next call without module or plugin reload", async () => {
  const root = await mkdtemp(join(tmpdir(), "compact-prompt-test-")), file = join(root, "prompt.md")
  try {
    await writeFile(file, template)
    expect(await compactionInstructions({ ...empty, focus: "要求" }, file)).toContain("通用指令")
    await writeFile(file, template.replace("通用指令", "新措辞已生效"))
    const changed = await compactionInstructions({ ...empty, focus: "要求" }, file)
    expect(changed).toContain("新措辞已生效")
    expect(changed).not.toContain("通用指令")
    expect(await compactionInstructions(empty, file)).toBe("新措辞已生效")
    await rm(file)
    await expect(compactionInstructions({ ...empty, focus: "要求" }, file)).rejects.toThrow("无法读取压缩模板")
    await expect(compactionInstructions(empty, file)).rejects.toThrow("无法读取压缩模板")
  } finally { await rm(root, { recursive: true, force: true }) }
})


test("all 16 combinations retain general requirements and only populated sections", () => {
  const keys = Object.keys(empty) as Array<keyof typeof empty>
  for (let mask = 0; mask < 16; mask++) {
    const fields = { ...empty }
    keys.forEach((key, i) => { fields[key] = mask & (1 << i) ? `内容-${key}` : " \t\n　" })
    const prompt = renderCompactionTemplate(template, fields)
    expect(prompt).toContain("通用指令")
    keys.forEach((key, i) => {
      for (const prefix of ["标题", "说明", "内容"]) {
        expect(prompt.includes(`${prefix}-${key}`)).toBe(Boolean(mask & (1 << i)))
      }
    })
    expect(prompt).not.toContain("{{")
  }
})

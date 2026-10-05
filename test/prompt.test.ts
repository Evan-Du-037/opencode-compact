import { test, expect } from "bun:test"
import { mkdtemp, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { compactionInstructions, renderCompactionTemplate } from "../src/prompt.ts"

const empty = { instructions: "" }
const template = "通用指令\n{{#instructions}}\n用户提示\n{{instructions}}\n提示说明\n{{/instructions}}"

test("free-form text stays literal, including headings, whitespace and template markers", () => {
  const value = "  中文🙂  $&\r\n## 自定义标题\n{{instructions}} {{#instructions}} {{/instructions}}\n  "
  const prompt = renderCompactionTemplate(template, { instructions: value })
  expect(prompt).toContain(value)
  expect(prompt).toContain("用户提示")
  expect(prompt).toContain("提示说明")
  for (const instructions of ["", " \n\t　"]) {
    expect(renderCompactionTemplate(template, { instructions })).toBe("通用指令")
  }
})

test("malformed and legacy templates fail explicitly", () => {
  for (const invalid of [
    template.replace("{{instructions}}", "{{focus}}"),
    template.replace("{{instructions}}", ""),
    template.replace("{{/instructions}}", "{{/extra}}"),
    template.replace("{{/instructions}}", ""),
    template.replace("{{instructions}}", "{{instructions}}{{instructions}}"),
    template.replace("{{instructions}}", "{{#instructions}}{{instructions}}{{/instructions}}"),
    "{{instructions}}",
  ]) expect(() => renderCompactionTemplate(invalid, { instructions: "要求" })).toThrow("压缩模板格式错误")
})

test("template is reread even when the input is blank; missing files fail explicitly", async () => {
  const root = await mkdtemp(join(tmpdir(), "compact-prompt-test-")), file = join(root, "prompt.md")
  try {
    await writeFile(file, template)
    expect(await compactionInstructions({ instructions: "要求" }, file)).toContain("通用指令")
    await writeFile(file, template.replace("通用指令", "新措辞已生效"))
    expect(await compactionInstructions({ instructions: "要求" }, file)).toContain("新措辞已生效")
    expect(await compactionInstructions(empty, file)).toBe("新措辞已生效")
    await rm(file)
    await expect(compactionInstructions({ instructions: "要求" }, file)).rejects.toThrow("无法读取压缩模板")
    await expect(compactionInstructions(empty, file)).rejects.toThrow("无法读取压缩模板")
  } finally { await rm(root, { recursive: true, force: true }) }
})

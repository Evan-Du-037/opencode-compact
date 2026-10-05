import { readFile } from "node:fs/promises"
import type { Fields } from "./core.ts"

const keys = ["instructions"] as const
const defaultTemplate = new URL("../compact-prompt.md", import.meta.url)

/** A small, non-evaluating template renderer. Inserted field text is never parsed as template syntax. */
export function renderCompactionTemplate(template: string, fields: Fields): string {
  const values = Object.fromEntries(keys.map(key => [key, fields[key] ?? ""])) as Fields
  const counts = new Map<string, number>()
  const blocks = new Set<string>()
  let block: keyof Fields | undefined, position = 0
  const result: string[] = []
  const append = (text: string) => { if (!block || values[block].trim()) result.push(text) }
  const invalid = (reason: string): never => { throw new Error(`压缩模板格式错误：${reason}`) }
  for (const match of template.matchAll(/{{([\s\S]*?)}}/g)) {
    append(template.slice(position, match.index))
    const token = match[1]!.trim()
    const prefix = token[0] === "#" || token[0] === "/" ? token[0] : ""
    const key = (prefix ? token.slice(1) : token).trim() as keyof Fields
    if (!keys.includes(key)) invalid(`未知占位符 {{${token}}}`)
    if (prefix === "#") {
      if (block || blocks.has(key)) invalid(`{{#${key}}} 不能嵌套或重复`)
      blocks.add(key); block = key
    } else if (prefix === "/") {
      if (block !== key) invalid(`{{/${key}}} 没有对应的开始标记`)
      block = undefined
    } else {
      if (block !== key) invalid(`{{${key}}} 必须放在 {{#${key}}} 与 {{/${key}}} 之间`)
      counts.set(key, (counts.get(key) ?? 0) + 1)
      append(values[key])
    }
    position = match.index + match[0].length
  }
  if (block) invalid(`{{#${block}}} 缺少结束标记`)
  append(template.slice(position))
  for (const key of keys) if (counts.get(key) !== 1) invalid(`请保留且只保留一个 {{${key}}}`)
  // Only template whitespace around sections is trimmed; user text is inserted literally.
  return result.join("").trim()
}

/** Read on every manual compaction so wording changes do not require an OpenCode restart. */
export async function compactionInstructions(fields: Fields, templatePath: string | URL = defaultTemplate): Promise<string> {
  let template: string
  try { template = await readFile(templatePath, "utf8") }
  catch (error) { throw new Error(`无法读取压缩模板 ${templatePath}：${error instanceof Error ? error.message : String(error)}`) }
  return renderCompactionTemplate(template, fields)
}

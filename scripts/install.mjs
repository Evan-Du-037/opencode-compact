import { readFile, writeFile, mkdir, rename, unlink, copyFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parse, modify, applyEdits } from 'jsonc-parser'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
let configDir = process.env.OPENCODE_CONFIG_DIR || join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'opencode')
let uninstall = false, check = false
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--config-dir') {
    if (!args[i + 1]) throw new Error('--config-dir 需要目录参数')
    configDir = resolve(args[++i])
  } else if (args[i] === '--uninstall') uninstall = true
  else if (args[i] === '--check') check = true
  else if (args[i] !== '--allow-untested') throw new Error(`未知参数：${args[i]}`)
}
async function optional(file) {
  try { return await readFile(file, 'utf8') } catch (e) { if (e.code === 'ENOENT') return undefined; throw e }
}
async function config(name) {
  for (const suffix of ['.jsonc', '.json']) {
    const file = join(configDir, name + suffix), text = await optional(file)
    if (text !== undefined) return { file, text, exists: true }
  }
  return { file: join(configDir, name + '.json'), text: '{}\n', exists: false }
}
function decode(entry) { return Array.isArray(entry) ? entry[0] : entry }
const changes = []
for (const [name, module] of [['opencode', 'server.ts'], ['tui', 'tui.tsx']]) {
  const primary = await config(name)
  const alternateFile = join(configDir, name + (primary.file.endsWith('.jsonc') ? '.json' : '.jsonc'))
  const alternateText = await optional(alternateFile)
  const items = [primary, ...(alternateText === undefined ? [] : [{ file: alternateFile, text: alternateText, exists: true }])]
  let installed = false
  for (const item of items) {
  const errors = []
  const value = parse(item.text, errors, { allowTrailingComma: true })
  if (errors.length || !value || Array.isArray(value) || typeof value !== 'object') throw new Error(`${item.file} 不是有效 JSON/JSONC；未写入配置。`)
  if (value.plugin !== undefined && !Array.isArray(value.plugin)) throw new Error(`${item.file} 的 plugin 必须是数组。`)
  const spec = pathToFileURL(join(root, 'src', module)).href
  const matches = entry => {
    const text = decode(entry)
    if (typeof text !== 'string') return false
    try { return (text.startsWith('file:') ? fileURLToPath(text) : resolve(configDir, text)) === join(root, 'src', module) } catch { return false }
  }
  if (check) {
    installed ||= (value.plugin || []).some(matches)
    continue
  }
  const plugins = (value.plugin || []).filter(entry => !matches(entry))
  if (!uninstall && item === primary) plugins.push([spec, { stateDir: join(configDir, '.compact-form-state') }])
  if (uninstall && plugins.length === (value.plugin || []).length) continue
  if (item !== primary && plugins.length === (value.plugin || []).length) continue
  const next = applyEdits(item.text, modify(item.text, ['plugin'], plugins, { formattingOptions: { insertSpaces: true, tabSize: 2, eol: '\n' } }))
  if (next !== item.text && (!uninstall || item.exists)) changes.push({ ...item, next })
  }
  if (check) {
    console.log(`${name}: ${installed ? '已配置' : '未配置'}`)
    if (!installed) process.exitCode = 1
  }
}
if (!check) {
  await mkdir(configDir, { recursive: true })
  if (!uninstall) await mkdir(join(configDir, '.compact-form-state'), { recursive: true, mode: 0o700 })
  const stamp = new Date().toISOString().replaceAll(':', '-'), written = []
  try {
    for (const change of changes) {
      if (change.exists) await copyFile(change.file, `${change.file}.bak-compact-${stamp}`)
      await writeFile(`${change.file}.compact-tmp`, change.next, { mode: 0o600 })
      await rename(`${change.file}.compact-tmp`, change.file)
      written.push(change)
    }
  } catch (error) {
    for (const change of written.reverse()) {
      if (change.exists) await writeFile(change.file, change.text, { mode: 0o600 })
      else await unlink(change.file).catch(() => {})
    }
    throw error
  } finally {
    for (const change of changes) await unlink(`${change.file}.compact-tmp`).catch(() => {})
  }
  console.log(uninstall ? '已移除本插件的两项配置。其他插件和设置保持原样。' : '安装完成。请完全退出并重新启动 OpenCode，然后在已有会话输入 /compact。')
  console.log(`配置目录：${configDir}`)
  if (changes.some(c => c.exists)) console.log(`已有配置备份后缀：.bak-compact-${stamp}`)
}

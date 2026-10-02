import { createHash, randomUUID } from "node:crypto"
import { mkdir, readFile, writeFile, rename, unlink, stat } from "node:fs/promises"
import { realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import type { Request } from "./core.ts"

export function storeRoot(options?: Record<string, unknown>): string {
  return resolve(String(options?.stateDir ?? process.env.OPENCODE_COMPACT_STATE_DIR ?? join(tmpdir(), `opencode-compact-${process.getuid?.() ?? "local"}`)))
}
export function canonical(directory: string): string {
  try { return realpathSync(directory) } catch { return resolve(directory) }
}
function key(directory: string, sessionID = "backend") { return createHash("sha256").update(`${canonical(directory)}\0${sessionID}`).digest("hex") }
export function pathFor(root: string, directory: string, sessionID: string, kind: string) { return join(root, `${key(directory, sessionID)}.${kind}.json`) }
export async function save(file: string, value: unknown) {
  const root = resolve(file, "..")
  await mkdir(root, { recursive: true, mode: 0o700 })
  const info = await stat(root)
  if (process.getuid && info.uid !== process.getuid()) throw new Error("插件状态目录不属于当前用户。")
  const temp = `${file}.${randomUUID()}.tmp`
  await writeFile(temp, JSON.stringify(value), { mode: 0o600, flag: "wx" })
  try { await rename(temp, file) } finally { await unlink(temp).catch(() => {}) }
}
export async function read<T>(file: string): Promise<T | undefined> {
  try { return JSON.parse(await readFile(file, "utf8")) }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error }
}
export async function remove(file: string) { await unlink(file).catch(error => { if (error.code !== "ENOENT") throw error }) }
export async function publish(root: string, request: Request) {
  const file = pathFor(root, request.directory, request.sessionID, "pending")
  await mkdir(root, { recursive: true, mode: 0o700 })
  // Exclusive creation prevents a second TUI from silently replacing the first request.
  await writeFile(file, JSON.stringify(request), { flag: "wx", mode: 0o600 }).catch(error => {
    if (error.code === "EEXIST") throw new Error("此会话已有待处理的压缩请求。请取消原操作或重启后清理过期请求。")
    throw error
  })
}
export async function cancelPending(root: string, request: Request) {
  const file = pathFor(root, request.directory, request.sessionID, "pending")
  if ((await read<Request>(file))?.id === request.id) await remove(file)
}

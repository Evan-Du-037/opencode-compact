import { createHash } from "node:crypto"

export const PLUGIN_ID = "evan.compact-form"
export type Fields = { focus: string; preserve: string; discard: string; extra: string }
export type Message = {
  info: { id: string; role: string; summary?: boolean; agent?: string; parentID?: string; error?: unknown; finish?: string; model?: { providerID: string; modelID: string }; time?: { created: number } }
  parts: Array<{ id: string; type: string; text?: string; ignored?: boolean; synthetic?: boolean; auto?: boolean }>
}
export type Request = {
  version: 2; id: string; directory: string; sessionID: string; created: number;
  base: string; fields: Fields; backend: string
}

export function fingerprint(messages: Message[]): string {
  return createHash("sha256").update(JSON.stringify(messages)).digest("hex")
}

/** Exclude reverted messages. The revert marker names the first discarded message. */
export function visibleHistory(messages: Message[], revertID?: string): Message[] {
  return revertID ? messages.filter(m => m.info.id < revertID) : messages
}

export { compactionInstructions } from "./prompt.ts"

/** OpenCode excludes previous compaction summaries from its serialized history when prompt is replaced. */
export function previousHandoff(messages: Message[]): string | undefined {
  return messages.findLast(m => m.info.role === "assistant" && m.info.summary && !m.info.error && m.info.finish && m.info.finish !== "unknown")
    ?.parts.filter(p => p.type === "text" && !p.ignored).map(p => p.text ?? "").join("\n")
}

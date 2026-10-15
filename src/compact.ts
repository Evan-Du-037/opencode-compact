import type { OpenCodeClient, LocationRef, ModelRef } from "@opencode/client"
import { compactRpc } from "./rpc.ts"
import type { Fields } from "./core.ts"
export async function compactSession(input: { client: OpenCodeClient; location: LocationRef; sessionID: string; fields: Fields; model?: ModelRef; signal?: AbortSignal }) {
  const result = await input.client.rpc(compactRpc).compact({ sessionID: input.sessionID, instructions: input.fields.instructions, ...(input.model ? { model: input.model } : {}) }, { location: input.location, signal: input.signal }) as { ok: boolean; error?: string }
  if (!result.ok) throw new Error(result.error || "压缩未完成。")
}

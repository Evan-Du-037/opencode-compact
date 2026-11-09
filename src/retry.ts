import { setTimeout as delay } from "node:timers/promises"

// These failures may follow a billed request. Keep retries narrow and bounded.
export const CONNECTION_RETRY_DELAYS = [2000, 5000] as const

export function isConnectionLoss(error: unknown): boolean {
  const seen = new Set<unknown>()
  for (let depth = 0; error && depth < 8 && !seen.has(error); depth++) {
    seen.add(error)
    const value = typeof error === "object" ? error as { code?: unknown; message?: unknown; cause?: unknown } : undefined
    const message = typeof error === "string" ? error : typeof value?.message === "string" ? value.message : ""
    const code = typeof value?.code === "string" ? value.code : ""
    if (/\b(?:ECONNRESET|EPIPE|UND_ERR_SOCKET|ERR_STREAM_PREMATURE_CLOSE)\b/i.test(`${code} ${message}`) ||
        /\bconnection lost while reading the response\b|\bsocket hang up\b|\bsocket connection was closed unexpectedly\b/i.test(message)) return true
    error = value?.cause
  }
  return false
}

export async function waitForRetry(ms: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  await delay(ms, undefined, { signal })
}

import { test, expect } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { compactSession } from "../src/compact.ts"
import { pathFor, save, read } from "../src/store.ts"
import type { Request } from "../src/core.ts"

for (const scenario of ["matching", "stale", "started", "unreadable"] as const) {
  test(`summarize HTTP error uses only a matching error receipt: ${scenario}`, async () => {
    const root = await mkdtemp(join(tmpdir(), "compact-submit-test-")), directory = "/fixture", sessionID = "ses_fixture"
    const original = new Error("unexpected server error")
    try {
      await save(pathFor(root, directory, "backend", "ready"), { backend: "backend1", pid: process.pid, version: 2 })
      const api = { state: { config: {} }, client: { session: {
        messages: async () => ({ data: [{ info: { id: "msg1", role: "user", model: { providerID: "mock", modelID: "test" } }, parts: [] }] }),
        get: async () => ({ data: {} }),
        status: async () => ({ data: {} }),
        summarize: async () => {
          const request = (await read<Request>(pathFor(root, directory, sessionID, "pending")))!
          const file = pathFor(root, directory, sessionID, "receipt")
          if (scenario === "unreadable") await writeFile(file, "invalid json")
          else await save(file, { id: scenario === "stale" ? "old-request" : request.id,
            status: scenario === "started" ? "started" : "error", error: "Error: 具体校验错误" })
          throw original
        },
      } } }
      const error = await compactSession({ api: api as any, root, directory, sessionID,
        fields: { focus: "", preserve: "", discard: "", extra: "" }, signal: new AbortController().signal }).catch(e => e)
      if (scenario === "matching") {
        expect(error.message).toBe("具体校验错误")
        expect(error.cause).toBe(original)
      } else expect(error).toBe(original)
      expect(await read(pathFor(root, directory, sessionID, "pending"))).toBeUndefined()
    } finally { await rm(root, { recursive: true, force: true }) }
  })
}

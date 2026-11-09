import { Rpc } from "@opencode/plugin"
import type { ModelRef } from "@opencode/client"
export type CompactInput = { sessionID: string; instructions: string; model?: ModelRef }
export const compactRpc = Rpc.define({
  id: "evan.compact-form.v2",
  methods: {
    progress: {
      input: { type: "object", properties: { sessionID: { type: "string" } }, required: ["sessionID"], additionalProperties: false },
      output: { type: "object", properties: { progress: { anyOf: [
        { type: "null" },
        { type: "object", properties: {
          runID: { type: "string" }, mode: { type: "string", enum: ["manual", "auto"] },
          phase: { type: "string", enum: ["waiting", "generating", "splitting", "fragment", "merge", "complete", "failed", "cancelled"] },
          startedAt: { type: "number" }, endedAt: { type: "number" }, calls: { type: "number" },
          completedFragments: { type: "number" }, mergeRound: { type: "number" },
          retry: { type: "object", properties: {
            attempt: { type: "number" }, maxAttempts: { type: "number" }, retryAt: { type: "number" },
          }, required: ["attempt", "maxAttempts"], additionalProperties: false },
        }, required: ["runID", "mode", "phase", "startedAt", "calls", "completedFragments", "mergeRound"], additionalProperties: false },
      ] } }, required: ["progress"], additionalProperties: false },
    },
    compact: {
      input: { type: "object", properties: {
        sessionID: { type: "string" }, instructions: { type: "string" },
        model: { type: "object", properties: { providerID: { type: "string" }, id: { type: "string" }, variant: { type: "string" } }, required: ["providerID", "id"], additionalProperties: false },
      }, required: ["sessionID", "instructions"], additionalProperties: false },
      output: { type: "object", properties: { ok: { type: "boolean" }, error: { type: "string" } }, required: ["ok"], additionalProperties: false },
    },
  },
  events: {},
})

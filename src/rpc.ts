import { Rpc } from "@opencode/plugin"
import type { ModelRef } from "@opencode/client"
export type CompactInput = { sessionID: string; instructions: string; model?: ModelRef }
export const compactRpc = Rpc.define({
  id: "evan.compact-form.v2",
  methods: {
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

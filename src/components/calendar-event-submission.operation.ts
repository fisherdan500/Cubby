import type { OperationDeclaration } from "@/server/operation-registry/schema";

export const operation = {
  schemaVersion: 1,
  id: "client_binding:src/components/calendar-event-submission.tsx",
  ownerModule: "src/components/calendar-event-submission.tsx",
  ownerKind: "client_binding",
  bindings: [
    { kind: "global_fetch", symbol: "fetch[1]", target: "globalThis.fetch" },
    { kind: "global_fetch", symbol: "fetch[2]", target: "globalThis.fetch" },
    { kind: "server_action", symbol: "issueCalendarEventAction[1]", target: "src/app/app/calendar/actions.ts#issueCalendarEventAction" },
    { kind: "server_action", symbol: "createCalendarEventAction[1]", target: "src/app/app/calendar/actions.ts#createCalendarEventAction" }
  ],
  disposition: "observed",
  deferredGateIds: [
    "gate.carrier_authority_guard", "gate.caller_controlled_scope", "gate.service_operation_linkage",
    "gate.permission_commit_reauthorization", "gate.tenant_relationship_invariants", "gate.model_and_effects",
    "gate.variant_outcomes", "gate.worker_containment", "gate.browser_binding_staleness", "gate.executable_evidence"
  ]
} as const satisfies OperationDeclaration;

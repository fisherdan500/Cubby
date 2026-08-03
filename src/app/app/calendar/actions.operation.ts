import type { OperationDeclaration } from "@/server/operation-registry/schema";

export const operation = {
  schemaVersion: 1,
  id: "server_action:src/app/app/calendar/actions.ts",
  ownerModule: "src/app/app/calendar/actions.ts",
  ownerKind: "server_action",
  bindings: [
    {
      kind: "server_action",
      symbol: "createCalendarEventAction",
      target: "src/app/app/calendar/actions.ts#createCalendarEventAction"
    }
  ],
  disposition: "observed",
  deferredGateIds: [
    "gate.carrier_authority_guard",
    "gate.caller_controlled_scope",
    "gate.service_operation_linkage",
    "gate.permission_commit_reauthorization",
    "gate.tenant_relationship_invariants",
    "gate.model_and_effects",
    "gate.variant_outcomes",
    "gate.worker_containment",
    "gate.browser_binding_staleness",
    "gate.executable_evidence"
  ]
} as const satisfies OperationDeclaration;

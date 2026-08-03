import type { OperationDeclaration } from "@/server/operation-registry/schema";

export const operation = {
  schemaVersion: 1,
  id: "worker:src/server/sprout-source-retention-scheduler.ts",
  ownerModule: "src/server/sprout-source-retention-scheduler.ts",
  ownerKind: "worker",
  bindings: [
    {
      kind: "worker_schedule",
      symbol: "tick",
      target: "src/server/sprout-source-retention-scheduler.ts#tick"
    },
    {
      kind: "worker_start_call",
      symbol: "startSproutSourceRetentionScheduler",
      target: "src/server/sprout-source-retention-scheduler.ts#startSproutSourceRetentionScheduler"
    },
    {
      kind: "worker_tick",
      symbol: "tick",
      target: "src/server/services/sprout-source-retention.ts#runSproutSourceRetention"
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

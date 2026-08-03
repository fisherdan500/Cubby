import type { OperationDeclaration } from "@/server/operation-registry/schema";

export const operation = {
  schemaVersion: 1,
  id: "instrumentation:src/instrumentation.ts",
  ownerModule: "src/instrumentation.ts",
  ownerKind: "instrumentation",
  bindings: [
    {
      kind: "worker_dynamic_import",
      symbol: "startAutomatedBackupScheduler",
      target: "src/server/automated-backup-scheduler.ts#startAutomatedBackupScheduler"
    },
    {
      kind: "worker_dynamic_import",
      symbol: "startIntegrityScheduler",
      target: "src/server/integrity-scheduler.ts#startIntegrityScheduler"
    },
    {
      kind: "worker_dynamic_import",
      symbol: "startSproutSourceRetentionScheduler",
      target: "src/server/sprout-source-retention-scheduler.ts#startSproutSourceRetentionScheduler"
    },
    {
      kind: "worker_start_call",
      symbol: "startAutomatedBackupScheduler",
      target: "src/server/automated-backup-scheduler.ts#startAutomatedBackupScheduler"
    },
    {
      kind: "worker_start_call",
      symbol: "startIntegrityScheduler",
      target: "src/server/integrity-scheduler.ts#startIntegrityScheduler"
    },
    {
      kind: "worker_start_call",
      symbol: "startSproutSourceRetentionScheduler",
      target: "src/server/sprout-source-retention-scheduler.ts#startSproutSourceRetentionScheduler"
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

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
      kind: "worker_dynamic_import",
      symbol: "startBrowserOperationRetentionScheduler",
      target: "src/server/browser-operation-retention-scheduler.ts#startBrowserOperationRetentionScheduler"
    },
    {
      kind: "worker_dynamic_import",
      symbol: "startEmailDeliveryScheduler",
      target: "src/server/email-delivery-scheduler.ts#startEmailDeliveryScheduler"
    },
    {
      kind: "worker_dynamic_import",
      symbol: "startEmailChangeLifecycleScheduler",
      target: "src/server/email-change-lifecycle-scheduler.ts#startEmailChangeLifecycleScheduler"
    },
    {
      kind: "worker_dynamic_import",
      symbol: "startAttachmentRetentionScheduler",
      target: "src/server/attachment-retention-scheduler.ts#startAttachmentRetentionScheduler"
    },
    {
      kind: "worker_dynamic_import",
      symbol: "startPlatformHealthScheduler",
      target: "src/server/platform-health-scheduler.ts#startPlatformHealthScheduler"
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
    },
    {
      kind: "worker_start_call",
      symbol: "startBrowserOperationRetentionScheduler",
      target: "src/server/browser-operation-retention-scheduler.ts#startBrowserOperationRetentionScheduler"
    },
    {
      kind: "worker_start_call",
      symbol: "startEmailDeliveryScheduler",
      target: "src/server/email-delivery-scheduler.ts#startEmailDeliveryScheduler"
    },
    {
      kind: "worker_start_call",
      symbol: "startEmailChangeLifecycleScheduler",
      target: "src/server/email-change-lifecycle-scheduler.ts#startEmailChangeLifecycleScheduler"
    },
    {
      kind: "worker_start_call",
      symbol: "startAttachmentRetentionScheduler",
      target: "src/server/attachment-retention-scheduler.ts#startAttachmentRetentionScheduler"
    },
    {
      kind: "worker_start_call",
      symbol: "startPlatformHealthScheduler",
      target: "src/server/platform-health-scheduler.ts#startPlatformHealthScheduler"
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

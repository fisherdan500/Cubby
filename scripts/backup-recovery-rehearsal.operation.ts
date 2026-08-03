import type { OperationDeclaration } from "@/server/operation-registry/schema";

export const operation = {
  schemaVersion: 1,
  id: "package_command:scripts/backup-recovery-rehearsal.ts",
  ownerModule: "scripts/backup-recovery-rehearsal.ts",
  ownerKind: "package_command",
  bindings: [
    {
      kind: "package_script",
      symbol: "verify:backup-recovery",
      target: "package.json#scripts.verify:backup-recovery"
    },
    {
      kind: "package_script",
      symbol: "verify:update-rehearsal",
      target: "package.json#scripts.verify:update-rehearsal"
    }
  ],
  disposition: "excluded",
  exclusion: {
    category: "rehearsal",
    rationale: "isolated test or rehearsal command; structural identity only"
  },
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

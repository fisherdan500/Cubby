import type { OperationDeclaration } from "@/server/operation-registry/schema";

export const operation = {
  schemaVersion: 1,
  id: "package_command:scripts/sprout-preview-commit.acceptance-rehearsal.ts",
  ownerModule: "scripts/sprout-preview-commit.acceptance-rehearsal.ts",
  ownerKind: "package_command",
  bindings: [
    {
      kind: "package_script",
      symbol: "verify:sprout-preview-commit",
      target: "package.json#scripts.verify:sprout-preview-commit"
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

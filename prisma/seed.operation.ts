import type { OperationDeclaration } from "@/server/operation-registry/schema";

export const operation = {
  schemaVersion: 1,
  id: "package_command:prisma/seed.ts",
  ownerModule: "prisma/seed.ts",
  ownerKind: "package_command",
  bindings: [
    {
      kind: "package_script",
      symbol: "db:seed",
      target: "package.json#scripts.db:seed"
    }
  ],
  disposition: "excluded",
  exclusion: {
    category: "fixture",
    rationale: "seed fixture command; excluded from operation semantics"
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

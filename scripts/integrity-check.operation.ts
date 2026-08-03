import type { OperationDeclaration } from "@/server/operation-registry/schema";

export const operation = {
  schemaVersion: 1,
  id: "package_command:scripts/integrity-check.ts",
  ownerModule: "scripts/integrity-check.ts",
  ownerKind: "package_command",
  bindings: [
    {
      kind: "container_copy",
      symbol: "integrity-check.mjs",
      target: "Dockerfile#/app/dist/integrity-check.mjs=>/app/integrity-check.mjs"
    },
    {
      kind: "package_build_entrypoint",
      symbol: "scripts/integrity-check.ts",
      target: "scripts/integrity-check.ts=>dist/integrity-check.mjs"
    },
    {
      kind: "package_build_invocation",
      symbol: "build",
      target: "package.json#scripts.build:build:integrity"
    },
    {
      kind: "package_script",
      symbol: "build:integrity",
      target: "package.json#scripts.build:integrity"
    },
    {
      kind: "package_script",
      symbol: "verify:integrity",
      target: "package.json#scripts.verify:integrity"
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

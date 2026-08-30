import type { OperationDeclaration } from "@/server/operation-registry/schema";

export const operation = {
  schemaVersion: 1,
  id: "package_command:scripts/security-operator.ts",
  ownerModule: "scripts/security-operator.ts",
  ownerKind: "package_command",
  bindings: [
    {
      kind: "command_variant",
      symbol: "aggregate",
      target: "scripts/security-operator.ts#parseSecurityOperatorCommand:aggregate"
    },
    {
      kind: "container_copy",
      symbol: "security-operator.mjs",
      target: "Dockerfile#/app/dist/security-operator.mjs=>/app/security-operator.mjs"
    },
    {
      kind: "package_build_entrypoint",
      symbol: "scripts/security-operator.ts",
      target: "scripts/security-operator.ts=>dist/security-operator.mjs"
    },
    {
      kind: "package_build_invocation",
      symbol: "build",
      target: "package.json#scripts.build:build:security-operator"
    },
    {
      kind: "package_script",
      symbol: "build:security-operator",
      target: "package.json#scripts.build:security-operator"
    },
    {
      kind: "package_script",
      symbol: "security:operator",
      target: "package.json#scripts.security:operator"
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

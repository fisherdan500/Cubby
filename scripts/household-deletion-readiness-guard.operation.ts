import type { OperationDeclaration } from "@/server/operation-registry/schema";

export const operation = {
  schemaVersion: 1,
  id: "package_command:scripts/household-deletion-readiness-guard.ts",
  ownerModule: "scripts/household-deletion-readiness-guard.ts",
  ownerKind: "package_command",
  bindings: [
    { kind: "container_copy", symbol: "household-deletion-readiness-guard.mjs", target: "Dockerfile#/app/dist/household-deletion-readiness-guard.mjs=>/app/scripts/household-deletion-readiness-guard.mjs" },
    { kind: "container_invocation", symbol: "household-deletion-readiness-guard.mjs", target: "docker/entrypoint.sh#/app/scripts/household-deletion-readiness-guard.mjs" },
    { kind: "package_build_entrypoint", symbol: "scripts/household-deletion-readiness-guard.ts", target: "scripts/household-deletion-readiness-guard.ts=>dist/household-deletion-readiness-guard.mjs" },
    { kind: "package_build_invocation", symbol: "build", target: "package.json#scripts.build:build:household-deletion-readiness" },
    { kind: "package_script", symbol: "build:household-deletion-readiness", target: "package.json#scripts.build:household-deletion-readiness" }
  ],
  disposition: "observed",
  deferredGateIds: ["gate.carrier_authority_guard", "gate.caller_controlled_scope", "gate.service_operation_linkage", "gate.permission_commit_reauthorization", "gate.tenant_relationship_invariants", "gate.model_and_effects", "gate.variant_outcomes", "gate.worker_containment", "gate.browser_binding_staleness", "gate.executable_evidence"]
} as const satisfies OperationDeclaration;

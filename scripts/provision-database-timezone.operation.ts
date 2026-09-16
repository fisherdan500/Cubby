import type { OperationDeclaration } from "@/server/operation-registry/schema";

export const operation = {
  schemaVersion: 1,
  id: "package_command:scripts/provision-database-timezone.mjs",
  ownerModule: "scripts/provision-database-timezone.mjs",
  ownerKind: "package_command",
  bindings: [
    { kind: "container_copy", symbol: "provision-database-timezone.mjs", target: "Dockerfile#/app/dist/provision-database-timezone.mjs=>/app/provision-database-timezone.mjs" },
    { kind: "container_invocation", symbol: "provision-database-timezone.mjs", target: "docker/entrypoint.sh#/app/provision-database-timezone.mjs" },
    { kind: "package_build_entrypoint", symbol: "scripts/provision-database-timezone.mjs", target: "scripts/provision-database-timezone.mjs=>dist/provision-database-timezone.mjs" },
    { kind: "package_build_invocation", symbol: "build", target: "package.json#scripts.build:build:database-timezone" }
  ],
  disposition: "observed",
  deferredGateIds: ["gate.carrier_authority_guard","gate.caller_controlled_scope","gate.service_operation_linkage","gate.permission_commit_reauthorization","gate.tenant_relationship_invariants","gate.model_and_effects","gate.variant_outcomes","gate.worker_containment","gate.browser_binding_staleness","gate.executable_evidence"]
} as const satisfies OperationDeclaration;

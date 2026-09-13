import type { OperationDeclaration } from "@/server/operation-registry/schema";

export const operation = {
  schemaVersion: 1,
  id: "package_command:scripts/provision-invitation-runtime-roles.mjs",
  ownerModule: "scripts/provision-invitation-runtime-roles.mjs",
  ownerKind: "package_command",
  bindings: [
    { kind: "container_copy", symbol: "provision-invitation-runtime-roles.mjs", target: "Dockerfile#/app/dist/provision-invitation-runtime-roles.mjs=>/app/provision-invitation-runtime-roles.mjs" },
    { kind: "container_invocation", symbol: "provision-invitation-runtime-roles.mjs", target: "docker/entrypoint.sh#/app/provision-invitation-runtime-roles.mjs" },
    { kind: "package_build_entrypoint", symbol: "scripts/provision-invitation-runtime-roles.mjs", target: "scripts/provision-invitation-runtime-roles.mjs=>dist/provision-invitation-runtime-roles.mjs" },
    { kind: "package_build_invocation", symbol: "build", target: "package.json#scripts.build:build:invitation-runtime-roles" }
  ],
  disposition: "observed",
  deferredGateIds: ["gate.carrier_authority_guard","gate.caller_controlled_scope","gate.service_operation_linkage","gate.permission_commit_reauthorization","gate.tenant_relationship_invariants","gate.model_and_effects","gate.variant_outcomes","gate.worker_containment","gate.browser_binding_staleness","gate.executable_evidence"]
} as const satisfies OperationDeclaration;

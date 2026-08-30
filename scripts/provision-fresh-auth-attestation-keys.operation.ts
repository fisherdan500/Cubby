import type { OperationDeclaration } from "@/server/operation-registry/schema";

export const operation = {
  schemaVersion: 1,
  id: "package_command:scripts/provision-fresh-auth-attestation-keys.mjs",
  ownerModule: "scripts/provision-fresh-auth-attestation-keys.mjs",
  ownerKind: "package_command",
  bindings: [
    { kind: "container_copy", symbol: "provision-fresh-auth-attestation-keys.mjs", target: "Dockerfile#/app/dist/provision-fresh-auth-attestation-keys.mjs=>/app/provision-fresh-auth-attestation-keys.mjs" },
    { kind: "container_invocation", symbol: "provision-fresh-auth-attestation-keys.mjs", target: "docker/entrypoint.sh#/app/provision-fresh-auth-attestation-keys.mjs" },
    { kind: "package_build_entrypoint", symbol: "scripts/provision-fresh-auth-attestation-keys.mjs", target: "scripts/provision-fresh-auth-attestation-keys.mjs=>dist/provision-fresh-auth-attestation-keys.mjs" },
    { kind: "package_build_invocation", symbol: "build", target: "package.json#scripts.build:build:fresh-auth-attestation-keys" }
  ],
  disposition: "observed",
  deferredGateIds: ["gate.carrier_authority_guard","gate.caller_controlled_scope","gate.service_operation_linkage","gate.permission_commit_reauthorization","gate.tenant_relationship_invariants","gate.model_and_effects","gate.variant_outcomes","gate.worker_containment","gate.browser_binding_staleness","gate.executable_evidence"]
} as const satisfies OperationDeclaration;

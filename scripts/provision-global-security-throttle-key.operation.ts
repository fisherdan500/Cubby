import type { OperationDeclaration } from "@/server/operation-registry/schema";

export const operation = {
  schemaVersion: 1,
  id: "package_command:scripts/provision-global-security-throttle-key.mjs",
  ownerModule: "scripts/provision-global-security-throttle-key.mjs",
  ownerKind: "package_command",
  bindings: [
    { kind: "container_copy", symbol: "provision-global-security-throttle-key.mjs", target: "Dockerfile#/app/dist/provision-global-security-throttle-key.mjs=>/app/provision-global-security-throttle-key.mjs" },
    { kind: "container_invocation", symbol: "provision-global-security-throttle-key.mjs", target: "docker/entrypoint.sh#/app/provision-global-security-throttle-key.mjs" },
    { kind: "package_build_entrypoint", symbol: "scripts/provision-global-security-throttle-key.mjs", target: "scripts/provision-global-security-throttle-key.mjs=>dist/provision-global-security-throttle-key.mjs" },
    { kind: "package_build_invocation", symbol: "build", target: "package.json#scripts.build:build:global-security-throttle-key" }
  ],
  disposition: "observed",
  deferredGateIds: ["gate.carrier_authority_guard","gate.caller_controlled_scope","gate.service_operation_linkage","gate.permission_commit_reauthorization","gate.tenant_relationship_invariants","gate.model_and_effects","gate.variant_outcomes","gate.worker_containment","gate.browser_binding_staleness","gate.executable_evidence"]
} as const satisfies OperationDeclaration;

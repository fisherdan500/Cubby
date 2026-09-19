import type { OperationDeclaration } from "@/server/operation-registry/schema";

export const operation = {
  schemaVersion: 1,
  id: "package_command:scripts/provision-platform-setup-code.mjs",
  ownerModule: "scripts/provision-platform-setup-code.mjs",
  ownerKind: "package_command",
  bindings: [
    { kind: "container_copy", symbol: "provision-platform-setup-code.mjs", target: "Dockerfile#/app/dist/provision-platform-setup-code.mjs=>/app/provision-platform-setup-code.mjs" },
    { kind: "container_invocation", symbol: "provision-platform-setup-code.mjs", target: "docker/entrypoint.sh#/app/provision-platform-setup-code.mjs" },
    { kind: "package_build_entrypoint", symbol: "scripts/provision-platform-setup-code.mjs", target: "scripts/provision-platform-setup-code.mjs=>dist/provision-platform-setup-code.mjs" },
    { kind: "package_build_invocation", symbol: "build", target: "package.json#scripts.build:build:platform-setup-code" }
  ],
  disposition: "observed",
  deferredGateIds: ["gate.carrier_authority_guard","gate.caller_controlled_scope","gate.service_operation_linkage","gate.permission_commit_reauthorization","gate.tenant_relationship_invariants","gate.model_and_effects","gate.variant_outcomes","gate.worker_containment","gate.browser_binding_staleness","gate.executable_evidence"]
} as const satisfies OperationDeclaration;

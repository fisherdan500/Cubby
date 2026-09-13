import type { OperationDeclaration } from "@/server/operation-registry/schema";

export const operation = {
  schemaVersion: 1,
  id: "package_command:scripts/p1-3-node-builtin-probe.mjs",
  ownerModule: "scripts/p1-3-node-builtin-probe.mjs",
  ownerKind: "package_command",
  bindings: [
    { kind: "container_copy", symbol: "p1-3-node-builtin-probe.mjs", target: "Dockerfile#/app/dist/p1-3-node-builtin-probe.mjs=>/app/scripts/p1-3-node-builtin-probe.mjs" },
    { kind: "container_invocation", symbol: "p1-3-node-builtin-probe.mjs", target: "docker/entrypoint.sh#/app/scripts/p1-3-node-builtin-probe.mjs" },
    { kind: "package_build_entrypoint", symbol: "scripts/p1-3-node-builtin-probe.mjs", target: "scripts/p1-3-node-builtin-probe.mjs=>dist/p1-3-node-builtin-probe.mjs" },
    { kind: "package_build_invocation", symbol: "build", target: "package.json#scripts.build:build:p13-node-builtin-probe" }
  ],
  disposition: "observed",
  deferredGateIds: ["gate.carrier_authority_guard","gate.caller_controlled_scope","gate.service_operation_linkage","gate.permission_commit_reauthorization","gate.tenant_relationship_invariants","gate.model_and_effects","gate.variant_outcomes","gate.worker_containment","gate.browser_binding_staleness","gate.executable_evidence"]
} as const satisfies OperationDeclaration;

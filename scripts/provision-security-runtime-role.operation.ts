import type { OperationDeclaration } from "@/server/operation-registry/schema";

export const operation = {
  schemaVersion: 1,
  id: "package_command:scripts/provision-security-runtime-role.mjs",
  ownerModule: "scripts/provision-security-runtime-role.mjs",
  ownerKind: "package_command",
  bindings: [
    {
      kind: "container_copy",
      symbol: "provision-security-runtime-role.mjs",
      target: "Dockerfile#/app/dist/provision-security-runtime-role.mjs=>/app/provision-security-runtime-role.mjs"
    },
    {
      kind: "container_invocation",
      symbol: "provision-security-runtime-role.mjs",
      target: "docker/entrypoint.sh#/app/provision-security-runtime-role.mjs"
    },
    {
      kind: "package_build_entrypoint",
      symbol: "scripts/provision-security-runtime-role.mjs",
      target: "scripts/provision-security-runtime-role.mjs=>dist/provision-security-runtime-role.mjs"
    },
    {
      kind: "package_build_invocation",
      symbol: "build",
      target: "package.json#scripts.build:build:security-runtime-role"
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

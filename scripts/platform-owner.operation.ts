import type { OperationDeclaration } from "@/server/operation-registry/schema";

export const operation = {
  schemaVersion: 1,
  id: "package_command:scripts/platform-owner.ts",
  ownerModule: "scripts/platform-owner.ts",
  ownerKind: "package_command",
  bindings: [
    {
      kind: "command_variant",
      symbol: "attest-successor",
      target: "scripts/platform-owner.ts#parsePlatformOwnerCommand:attest-successor"
    },
    {
      kind: "command_variant",
      symbol: "authorize-backup-recovery",
      target: "scripts/platform-owner.ts#parsePlatformOwnerCommand:authorize-backup-recovery"
    },
    {
      kind: "command_variant",
      symbol: "bind",
      target: "scripts/platform-owner.ts#parsePlatformOwnerCommand:bind"
    },
    {
      kind: "command_variant",
      symbol: "inspect-backup-recovery",
      target: "scripts/platform-owner.ts#parsePlatformOwnerCommand:inspect-backup-recovery"
    },
    {
      kind: "command_variant",
      symbol: "provision-backup-recovery-target",
      target: "scripts/platform-owner.ts#parsePlatformOwnerCommand:provision-backup-recovery-target"
    },
    {
      kind: "command_variant",
      symbol: "recover",
      target: "scripts/platform-owner.ts#parsePlatformOwnerCommand:recover"
    },
    {
      kind: "command_variant",
      symbol: "verify-bootstrap",
      target: "scripts/platform-owner.ts#parsePlatformOwnerCommand:verify-bootstrap"
    },
    {
      kind: "container_copy",
      symbol: "platform-owner.mjs",
      target: "Dockerfile#/app/dist/platform-owner.mjs=>/app/platform-owner.mjs"
    },
    {
      kind: "package_build_entrypoint",
      symbol: "scripts/platform-owner.ts",
      target: "scripts/platform-owner.ts=>dist/platform-owner.mjs"
    },
    {
      kind: "package_build_invocation",
      symbol: "build",
      target: "package.json#scripts.build:build:platform-owner"
    },
    {
      kind: "package_script",
      symbol: "build:platform-owner",
      target: "package.json#scripts.build:platform-owner"
    },
    {
      kind: "package_script",
      symbol: "platform:owner",
      target: "package.json#scripts.platform:owner"
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

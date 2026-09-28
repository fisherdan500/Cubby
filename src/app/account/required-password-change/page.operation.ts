import type { OperationDeclaration } from "@/server/operation-registry/schema";

export const operation = {
  schemaVersion: 1,
  id: "server_loader:src/app/account/required-password-change/page.tsx",
  ownerModule: "src/app/account/required-password-change/page.tsx",
  ownerKind: "server_loader",
  bindings: [
    {
      kind: "server_value_import",
      symbol: "hasOutstandingRequiredChange",
      target: "src/server/services/assisted-required-change-state.ts#hasOutstandingRequiredChange"
    },
    {
      kind: "server_value_import",
      symbol: "getSession",
      target: "src/server/auth/session.ts#getSession"
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

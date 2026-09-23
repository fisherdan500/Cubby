import type { OperationDeclaration } from "@/server/operation-registry/schema";

export const operation = {
  schemaVersion: 1,
  id: "server_loader:src/app/setup/page.tsx",
  ownerModule: "src/app/setup/page.tsx",
  ownerKind: "server_loader",
  bindings: [
    {
      kind: "server_value_import",
      symbol: "getAppRegistrationPolicy",
      target: "src/server/services/registration.ts#getAppRegistrationPolicy"
    },
    {
      kind: "server_value_import",
      symbol: "getSession",
      target: "src/server/auth/session.ts#getSession"
    },
    {
      kind: "server_value_import",
      symbol: "isFirstAccountSetupAvailable",
      target: "src/server/services/platform-setup.ts#isFirstAccountSetupAvailable"
    },
    {
      kind: "server_value_import",
      symbol: "isPlatformOwner",
      target: "src/server/services/platform-authority.ts#isPlatformOwner"
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

import type { OperationDeclaration } from "@/server/operation-registry/schema";

export const operation = {
  schemaVersion: 1,
  id: "server_loader:src/app/onboarding/page.tsx",
  ownerModule: "src/app/onboarding/page.tsx",
  ownerKind: "server_loader",
  bindings: [
    {
      kind: "server_value_import",
      symbol: "getAppRegistrationPolicy",
      target: "src/server/services/registration.ts#getAppRegistrationPolicy"
    },
    {
      kind: "server_value_import",
      symbol: "getHouseholdHome",
      target: "src/server/services/households.ts#getHouseholdHome"
    },
    {
      kind: "server_value_import",
      symbol: "getHouseholdLeaveOptions",
      target: "src/server/services/household-leave.ts#getHouseholdLeaveOptions"
    },
    {
      kind: "server_value_import",
      symbol: "isPlatformOwner",
      target: "src/server/services/platform-authority.ts#isPlatformOwner"
    },
    {
      kind: "server_value_import",
      symbol: "requireUserPage",
      target: "src/server/auth/session.ts#requireUserPage"
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

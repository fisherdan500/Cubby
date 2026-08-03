import type { OperationDeclaration } from "@/server/operation-registry/schema";

export const operation = {
  schemaVersion: 1,
  id: "server_loader:src/app/app/settings/appearance/page.tsx",
  ownerModule: "src/app/app/settings/appearance/page.tsx",
  ownerKind: "server_loader",
  bindings: [
    {
      kind: "server_value_import",
      symbol: "getHouseholdAppearance",
      target: "src/server/services/appearance.ts#getHouseholdAppearance"
    },
    {
      kind: "server_value_import",
      symbol: "requireSettingsPage",
      target: "src/server/auth/page-access.ts#requireSettingsPage"
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

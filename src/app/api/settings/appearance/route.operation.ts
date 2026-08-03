import type { OperationDeclaration } from "@/server/operation-registry/schema";

export const operation = {
  schemaVersion: 1,
  id: "api_route:src/app/api/settings/appearance/route.ts",
  ownerModule: "src/app/api/settings/appearance/route.ts",
  ownerKind: "api_route",
  bindings: [
    {
      kind: "route_method",
      symbol: "GET",
      target: "src/app/api/settings/appearance/route.ts#GET"
    },
    {
      kind: "route_method",
      symbol: "PATCH",
      target: "src/app/api/settings/appearance/route.ts#PATCH"
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

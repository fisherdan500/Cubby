import type { OperationDeclaration } from "@/server/operation-registry/schema";

export const operation = {
  schemaVersion: 1,
  id: "server_loader:src/app/app/activities/[id]/page.tsx",
  ownerModule: "src/app/app/activities/[id]/page.tsx",
  ownerKind: "server_loader",
  bindings: [
    {
      kind: "server_value_import",
      symbol: "requireUserPage",
      target: "src/server/auth/session.ts#requireUserPage"
    },
    {
      kind: "server_value_import",
      symbol: "getActivityView",
      target: "src/server/services/activities.ts#getActivityView"
    },
    {
      kind: "server_value_import",
      symbol: "activityResponsesQuery",
      target: "src/server/services/activity-responses.ts#activityResponsesQuery"
    },
    {
      kind: "server_value_import",
      symbol: "listActivityPhotos",
      target: "src/server/services/activity-responses.ts#listActivityPhotos"
    },
    {
      kind: "server_value_import",
      symbol: "feedInteractionKey",
      target: "src/server/services/feed-interactions.ts#feedInteractionKey"
    },
    {
      kind: "server_value_import",
      symbol: "listFeedInteractions",
      target: "src/server/services/feed-interactions.ts#listFeedInteractions"
    },
    {
      kind: "server_value_import",
      symbol: "getHouseholdHome",
      target: "src/server/services/households.ts#getHouseholdHome"
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

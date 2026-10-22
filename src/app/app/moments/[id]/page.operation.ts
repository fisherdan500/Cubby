import type { OperationDeclaration } from "@/server/operation-registry/schema";

export const operation = {
  schemaVersion: 1,
  id: "server_loader:src/app/app/moments/[id]/page.tsx",
  ownerModule: "src/app/app/moments/[id]/page.tsx",
  ownerKind: "server_loader",
  bindings: [
    {
      kind: "server_value_import",
      symbol: "getEffectiveHouseholdContext",
      target: "src/server/auth/context.ts#getEffectiveHouseholdContext"
    },
    {
      kind: "server_value_import",
      symbol: "requireUserPage",
      target: "src/server/auth/session.ts#requireUserPage"
    },
    {
      kind: "server_value_import",
      symbol: "getHeaderBabySelector",
      target: "src/server/services/baby-selector.ts#getHeaderBabySelector"
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
      symbol: "markMomentsSeen",
      target: "src/server/services/moments-seen.ts#markMomentsSeen"
    },
    {
      kind: "server_value_import",
      symbol: "getFeedPostView",
      target: "src/server/services/feed-posts.ts#getFeedPostView"
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

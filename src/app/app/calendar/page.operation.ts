import type { OperationDeclaration } from "@/server/operation-registry/schema";

export const operation = {
  schemaVersion: 1,
  id: "server_loader:src/app/app/calendar/page.tsx",
  ownerModule: "src/app/app/calendar/page.tsx",
  ownerKind: "server_loader",
  bindings: [
    {
      kind: "server_value_import",
      symbol: "getCalendar",
      target: "src/server/services/calendar.ts#getCalendar"
    },
    {
      kind: "server_value_import",
      symbol: "getHeaderBabySelector",
      target: "src/server/services/baby-selector.ts#getHeaderBabySelector"
    },
    {
      kind: "server_value_import",
      symbol: "issueCalendarEventBrowserOperation",
      target: "src/server/services/calendar.ts#issueCalendarEventBrowserOperation"
    },
    {
      kind: "server_value_import",
      symbol: "requireUserPage",
      target: "src/server/auth/session.ts#requireUserPage"
    },
    {
      kind: "server_value_import",
      symbol: "submitCalendarEventBrowserOperation",
      target: "src/server/services/calendar.ts#submitCalendarEventBrowserOperation"
    },
    {
      kind: "server_value_import",
      symbol: "browserOperationFailureResult",
      target: "src/server/services/browser-operations.ts#browserOperationFailureResult"
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

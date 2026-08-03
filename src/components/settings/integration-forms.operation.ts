import type { OperationDeclaration } from "@/server/operation-registry/schema";

export const operation = {
  schemaVersion: 1,
  id: "client_binding:src/components/settings/integration-forms.tsx",
  ownerModule: "src/components/settings/integration-forms.tsx",
  ownerKind: "client_binding",
  bindings: [
    {
      kind: "form_action",
      symbol: "submit",
      target: "src/components/settings/integration-forms.tsx#submit"
    },
    {
      kind: "form_action",
      symbol: "submit",
      target: "src/components/settings/integration-forms.tsx#submit"
    },
    {
      kind: "global_fetch",
      symbol: "fetch[1]",
      target: "globalThis.fetch"
    },
    {
      kind: "global_fetch",
      symbol: "fetch[2]",
      target: "globalThis.fetch"
    },
    {
      kind: "global_fetch",
      symbol: "fetch[3]",
      target: "globalThis.fetch"
    },
    {
      kind: "global_fetch",
      symbol: "fetch[4]",
      target: "globalThis.fetch"
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

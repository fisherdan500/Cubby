import type { OperationDeclaration } from "@/server/operation-registry/schema";

export const operation = {
  schemaVersion: 1,
  id: "client_binding:src/components/sign-out-button.tsx",
  ownerModule: "src/components/sign-out-button.tsx",
  ownerKind: "client_binding",
  bindings: [
    {
      kind: "auth_client_call",
      symbol: "authClient.signOut[1]",
      target: "better-auth/react#createAuthClient.signOut"
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

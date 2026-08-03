import type { OperationDeclaration } from "@/server/operation-registry/schema";

export const operation = {
  schemaVersion: 1,
  id: "client_binding:src/components/settings/session-manager.tsx",
  ownerModule: "src/components/settings/session-manager.tsx",
  ownerKind: "client_binding",
  bindings: [
    {
      kind: "auth_client_call",
      symbol: "authClient.getSession[1]",
      target: "better-auth/react#createAuthClient.getSession"
    },
    {
      kind: "auth_client_call",
      symbol: "authClient.listSessions[1]",
      target: "better-auth/react#createAuthClient.listSessions"
    },
    {
      kind: "auth_client_call",
      symbol: "authClient.revokeOtherSessions[1]",
      target: "better-auth/react#createAuthClient.revokeOtherSessions"
    },
    {
      kind: "auth_client_call",
      symbol: "authClient.revokeSession[1]",
      target: "better-auth/react#createAuthClient.revokeSession"
    },
    {
      kind: "auth_client_call",
      symbol: "authClient.signOut[1]",
      target: "better-auth/react#createAuthClient.signOut"
    },
    {
      kind: "auth_client_call",
      symbol: "authClient.signOut[2]",
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

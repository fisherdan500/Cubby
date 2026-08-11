import type { SemanticExposureDeclaration } from "@/server/operation-registry/schema";

export const semantic = [{
  kind: "exposure", ownerModule: "src/app/api/platform/registration/route.ts", exportName: "GET",
  binding: { kind: "route_method", symbol: "GET", target: "src/app/api/platform/registration/route.ts#GET" },
  serviceOperationIds: ["platform.registration.settings"],
  axes: {
    carrier_authority_guard: { current: { authority: "source_reviewed", value: "GET delegates authority to the settings service", sourceReferences: [{ kind: "symbol", file: "src/app/api/platform/registration/route.ts", exportName: "GET" }] }, target: { authority: "deferred", gateId: "gate.carrier_authority_guard" } },
    caller_controlled_scope: { current: { authority: "not_applicable", rationale: "settings GET has no caller-controlled payload", sourceReferences: [{ kind: "symbol", file: "src/app/api/platform/registration/route.ts", exportName: "GET" }] }, target: { authority: "deferred", gateId: "gate.caller_controlled_scope" } },
    service_operation_linkage: { current: { authority: "source_reviewed", value: "GET without operationId calls the settings service", sourceReferences: [{ kind: "symbol", file: "src/app/api/platform/registration/route.ts", exportName: "GET" }] }, target: { authority: "deferred", gateId: "gate.service_operation_linkage" } },
    permission_commit_reauthorization: { current: { authority: "deferred", gateId: "gate.permission_commit_reauthorization" }, target: { authority: "deferred", gateId: "gate.permission_commit_reauthorization" } },
    tenant_relationship_invariants: { current: { authority: "deferred", gateId: "gate.tenant_relationship_invariants" }, target: { authority: "deferred", gateId: "gate.tenant_relationship_invariants" } },
    model_reads_writes_effects: { current: { authority: "deferred", gateId: "gate.model_and_effects" }, target: { authority: "deferred", gateId: "gate.model_and_effects" } },
    variant_specific_outcomes: { current: { authority: "source_reviewed", value: "GET without operationId returns settings", sourceReferences: [{ kind: "symbol", file: "src/app/api/platform/registration/route.ts", exportName: "GET" }] }, target: { authority: "deferred", gateId: "gate.variant_outcomes" } },
    worker_loop_claim_failure_containment: { current: { authority: "not_applicable", rationale: "settings GET does not run a worker loop", sourceReferences: [{ kind: "symbol", file: "src/app/api/platform/registration/route.ts", exportName: "GET" }] }, target: { authority: "deferred", gateId: "gate.worker_containment" } },
    browser_immutable_binding_stale_behavior: { current: { authority: "deferred", gateId: "gate.browser_binding_staleness" }, target: { authority: "deferred", gateId: "gate.browser_binding_staleness" } },
    executable_evidence_strength: { current: { authority: "deferred", gateId: "gate.executable_evidence" }, target: { authority: "deferred", gateId: "gate.executable_evidence" } }
  }
}, {
  kind: "exposure", ownerModule: "src/app/api/platform/registration/route.ts", exportName: "GET",
  binding: { kind: "route_method", symbol: "GET", target: "src/app/api/platform/registration/route.ts#GET" },
  variant: { name: "operation-status", branchAnchor: { kind: "query_param_equals", parameter: "operationId", value: "present" } },
  serviceOperationIds: ["platform.registration.operation-status"],
  axes: {
    carrier_authority_guard: { current: { authority: "source_reviewed", value: "GET delegates authority to the operation status service", sourceReferences: [{ kind: "symbol", file: "src/app/api/platform/registration/route.ts", exportName: "GET" }] }, target: { authority: "deferred", gateId: "gate.carrier_authority_guard" } },
    caller_controlled_scope: { current: { authority: "source_reviewed", value: "operationId is read from the query string", sourceReferences: [{ kind: "symbol", file: "src/app/api/platform/registration/route.ts", exportName: "GET" }] }, target: { authority: "deferred", gateId: "gate.caller_controlled_scope" } },
    service_operation_linkage: { current: { authority: "source_reviewed", value: "operationId-present GET calls the operation status service", sourceReferences: [{ kind: "symbol", file: "src/app/api/platform/registration/route.ts", exportName: "GET" }] }, target: { authority: "deferred", gateId: "gate.service_operation_linkage" } },
    permission_commit_reauthorization: { current: { authority: "deferred", gateId: "gate.permission_commit_reauthorization" }, target: { authority: "deferred", gateId: "gate.permission_commit_reauthorization" } },
    tenant_relationship_invariants: { current: { authority: "deferred", gateId: "gate.tenant_relationship_invariants" }, target: { authority: "deferred", gateId: "gate.tenant_relationship_invariants" } },
    model_reads_writes_effects: { current: { authority: "deferred", gateId: "gate.model_and_effects" }, target: { authority: "deferred", gateId: "gate.model_and_effects" } },
    variant_specific_outcomes: { current: { authority: "source_reviewed", value: "operationId-present branch returns operation status", sourceReferences: [{ kind: "symbol", file: "src/app/api/platform/registration/route.ts", exportName: "GET" }] }, target: { authority: "deferred", gateId: "gate.variant_outcomes" } },
    worker_loop_claim_failure_containment: { current: { authority: "not_applicable", rationale: "operation status GET does not run a worker loop", sourceReferences: [{ kind: "symbol", file: "src/app/api/platform/registration/route.ts", exportName: "GET" }] }, target: { authority: "deferred", gateId: "gate.worker_containment" } },
    browser_immutable_binding_stale_behavior: { current: { authority: "deferred", gateId: "gate.browser_binding_staleness" }, target: { authority: "deferred", gateId: "gate.browser_binding_staleness" } },
    executable_evidence_strength: { current: { authority: "deferred", gateId: "gate.executable_evidence" }, target: { authority: "deferred", gateId: "gate.executable_evidence" } }
  }
}, {
  kind: "exposure", ownerModule: "src/app/api/platform/registration/route.ts", exportName: "POST",
  binding: { kind: "route_method", symbol: "POST", target: "src/app/api/platform/registration/route.ts#POST" }, serviceOperationIds: ["platform.registration.allocate"],
  axes: {
    carrier_authority_guard: { current: { authority: "source_reviewed", value: "route delegates authority", sourceReferences: [{ kind: "symbol", file: "src/app/api/platform/registration/route.ts", exportName: "POST" }] }, target: { authority: "deferred", gateId: "gate.carrier_authority_guard" } },
    caller_controlled_scope: { current: { authority: "source_reviewed", value: "request body is passed as unknown", sourceReferences: [{ kind: "symbol", file: "src/app/api/platform/registration/route.ts", exportName: "POST" }] }, target: { authority: "deferred", gateId: "gate.caller_controlled_scope" } },
    service_operation_linkage: { current: { authority: "source_reviewed", value: "route calls allocation service", sourceReferences: [{ kind: "symbol", file: "src/app/api/platform/registration/route.ts", exportName: "POST" }] }, target: { authority: "deferred", gateId: "gate.service_operation_linkage" } },
    permission_commit_reauthorization: { current: { authority: "deferred", gateId: "gate.permission_commit_reauthorization" }, target: { authority: "deferred", gateId: "gate.permission_commit_reauthorization" } },
    tenant_relationship_invariants: { current: { authority: "deferred", gateId: "gate.tenant_relationship_invariants" }, target: { authority: "deferred", gateId: "gate.tenant_relationship_invariants" } },
    model_reads_writes_effects: { current: { authority: "deferred", gateId: "gate.model_and_effects" }, target: { authority: "deferred", gateId: "gate.model_and_effects" } },
    variant_specific_outcomes: { current: { authority: "not_applicable", rationale: "POST has no semantic variant", sourceReferences: [{ kind: "symbol", file: "src/app/api/platform/registration/route.ts", exportName: "POST" }] }, target: { authority: "deferred", gateId: "gate.variant_outcomes" } },
    worker_loop_claim_failure_containment: { current: { authority: "not_applicable", rationale: "POST does not run a worker loop", sourceReferences: [{ kind: "symbol", file: "src/app/api/platform/registration/route.ts", exportName: "POST" }] }, target: { authority: "deferred", gateId: "gate.worker_containment" } },
    browser_immutable_binding_stale_behavior: { current: { authority: "deferred", gateId: "gate.browser_binding_staleness" }, target: { authority: "deferred", gateId: "gate.browser_binding_staleness" } },
    executable_evidence_strength: { current: { authority: "deferred", gateId: "gate.executable_evidence" }, target: { authority: "deferred", gateId: "gate.executable_evidence" } }
  }
}, {
  kind: "exposure", ownerModule: "src/app/api/platform/registration/route.ts", exportName: "PUT",
  binding: { kind: "route_method", symbol: "PUT", target: "src/app/api/platform/registration/route.ts#PUT" }, serviceOperationIds: ["platform.registration.complete"],
  axes: {
    carrier_authority_guard: { current: { authority: "source_reviewed", value: "service authority reviewed", sourceReferences: [{ kind: "symbol", file: "src/app/api/platform/registration/route.ts", exportName: "PUT" }] }, target: { authority: "deferred", gateId: "gate.carrier_authority_guard" } },
    caller_controlled_scope: { current: { authority: "source_reviewed", value: "request body passed to service", sourceReferences: [{ kind: "symbol", file: "src/app/api/platform/registration/route.ts", exportName: "PUT" }] }, target: { authority: "deferred", gateId: "gate.caller_controlled_scope" } },
    service_operation_linkage: { current: { authority: "source_reviewed", value: "route calls completion service", sourceReferences: [{ kind: "symbol", file: "src/app/api/platform/registration/route.ts", exportName: "PUT" }] }, target: { authority: "deferred", gateId: "gate.service_operation_linkage" } },
    permission_commit_reauthorization: { current: { authority: "deferred", gateId: "gate.permission_commit_reauthorization" }, target: { authority: "deferred", gateId: "gate.permission_commit_reauthorization" } },
    tenant_relationship_invariants: { current: { authority: "deferred", gateId: "gate.tenant_relationship_invariants" }, target: { authority: "deferred", gateId: "gate.tenant_relationship_invariants" } },
    model_reads_writes_effects: { current: { authority: "deferred", gateId: "gate.model_and_effects" }, target: { authority: "deferred", gateId: "gate.model_and_effects" } },
    variant_specific_outcomes: { current: { authority: "not_applicable", rationale: "no route variant", sourceReferences: [{ kind: "symbol", file: "src/app/api/platform/registration/route.ts", exportName: "PUT" }] }, target: { authority: "deferred", gateId: "gate.variant_outcomes" } },
    worker_loop_claim_failure_containment: { current: { authority: "not_applicable", rationale: "no worker loop", sourceReferences: [{ kind: "symbol", file: "src/app/api/platform/registration/route.ts", exportName: "PUT" }] }, target: { authority: "deferred", gateId: "gate.worker_containment" } },
    browser_immutable_binding_stale_behavior: { current: { authority: "deferred", gateId: "gate.browser_binding_staleness" }, target: { authority: "deferred", gateId: "gate.browser_binding_staleness" } },
    executable_evidence_strength: { current: { authority: "deferred", gateId: "gate.executable_evidence" }, target: { authority: "deferred", gateId: "gate.executable_evidence" } }
  }
}] as const satisfies readonly SemanticExposureDeclaration[];

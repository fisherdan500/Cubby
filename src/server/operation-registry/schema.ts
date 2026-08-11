export const OPERATION_REGISTRY_SCHEMA_VERSION = 1 as const;

export type OperationOwnerKind =
  | "api_route"
  | "server_loader"
  | "client_binding"
  | "server_action"
  | "instrumentation"
  | "worker"
  | "package_command";

export type StructuralBindingKind =
  | "route_method"
  | "server_value_import"
  | "server_dynamic_import"
  | "server_action"
  | "form_action"
  | "global_fetch"
  | "auth_client_call"
  | "worker_dynamic_import"
  | "worker_static_import"
  | "worker_start_call"
  | "worker_tick"
  | "worker_schedule"
  | "package_script"
  | "package_build_entrypoint"
  | "package_build_invocation"
  | "container_copy"
  | "container_invocation"
  | "command_variant";

export type DeferredGateId =
  | "gate.carrier_authority_guard"
  | "gate.caller_controlled_scope"
  | "gate.service_operation_linkage"
  | "gate.permission_commit_reauthorization"
  | "gate.tenant_relationship_invariants"
  | "gate.model_and_effects"
  | "gate.variant_outcomes"
  | "gate.worker_containment"
  | "gate.browser_binding_staleness"
  | "gate.executable_evidence";

export type StructuralBindingDeclaration = {
  readonly kind: StructuralBindingKind;
  readonly symbol: string;
  readonly target: string;
};

export type StructuralExclusionDeclaration = {
  readonly category: "rehearsal" | "fixture" | "build_tool" | "registry_tooling";
  readonly rationale: string;
};

export type RuntimeInvocationExclusionCategory =
  | "third_party_migration_cli"
  | "application_server_runtime"
  | "healthcheck_probe_runtime";

export type RuntimeInvocationStructuralExclusion = {
  readonly category: RuntimeInvocationExclusionCategory;
  readonly rationale: string;
};

export type RuntimeInvocationLedgerEntry = {
  readonly id: string;
  readonly role: "main" | "code_module";
  readonly path: string | null;
  readonly codeOption: string | null;
  readonly anchorFile: string;
  readonly anchorStart: number;
  readonly anchorEnd: number;
  readonly anchorBytes: string;
  readonly disposition:
    | "container_invocation"
    | "structural_exclusion"
    | "unsupported";
  readonly ownerModule: string | null;
  readonly exclusion: RuntimeInvocationStructuralExclusion | null;
  readonly fingerprint: string;
};

type OperationDeclarationBase = {
  readonly schemaVersion: typeof OPERATION_REGISTRY_SCHEMA_VERSION;
  readonly id: string;
  readonly ownerModule: string;
  readonly ownerKind: OperationOwnerKind;
  readonly bindings: readonly StructuralBindingDeclaration[];
  readonly deferredGateIds: readonly DeferredGateId[];
};

export type OperationDeclaration = OperationDeclarationBase & (
  | {
      readonly disposition: "observed";
      readonly exclusion?: never;
    }
  | {
      readonly disposition: "excluded";
      readonly exclusion: StructuralExclusionDeclaration;
    }
);

export type DeferredSemanticAxis =
  | "carrier_authority_guard"
  | "caller_controlled_scope"
  | "service_operation_linkage"
  | "permission_commit_reauthorization"
  | "tenant_relationship_invariants"
  | "model_reads_writes_effects"
  | "variant_specific_outcomes"
  | "worker_loop_claim_failure_containment"
  | "browser_immutable_binding_stale_behavior"
  | "executable_evidence_strength";

export type DeferredDependencyPhase = "R2" | "R3" | "R4";

export type DeferredGateDefinition = {
  readonly id: DeferredGateId;
  readonly status: "deferred";
  readonly rationale: string;
  readonly dependencyPhase: DeferredDependencyPhase;
  readonly blockedAxes: readonly DeferredSemanticAxis[];
  readonly exitCriteria: string;
};

export type SemanticSourceReference =
  | { readonly kind: "symbol"; readonly file: string; readonly exportName: string }
  | { readonly kind: "span"; readonly file: string; readonly start: number; readonly end: number };

export type SemanticAxisCurrent =
  | { readonly authority: "deferred"; readonly gateId: DeferredGateId }
  | { readonly authority: "source_reviewed"; readonly value: string; readonly sourceReferences: readonly SemanticSourceReference[] }
  | { readonly authority: "not_applicable"; readonly rationale: string; readonly sourceReferences: readonly SemanticSourceReference[] };

export type SemanticAxisTarget = {
  readonly authority: "deferred";
  readonly gateId: DeferredGateId;
};

export type SemanticAxisDeclaration = {
  readonly current: SemanticAxisCurrent;
  readonly target: SemanticAxisTarget;
};

export type SemanticExposureVariant = {
  readonly name: string;
  readonly branchAnchor: {
    readonly kind: "query_param_equals";
    readonly parameter: string;
    readonly value: "present";
  };
};

export type SemanticExposureAlias = {
  readonly ownerModule: string;
  readonly exportName: string;
};

export type SemanticServiceLinkage =
  | readonly string[]
  | {
      readonly authority: "not_applicable";
      readonly rationale: string;
      readonly sourceReferences: readonly SemanticSourceReference[];
    };

export type SemanticServiceOperationDeclaration = {
  readonly kind: "service";
  readonly id: string;
  readonly ownerModule: string;
  readonly exportName: string;
  readonly axes: Readonly<Record<DeferredSemanticAxis, SemanticAxisDeclaration>>;
};

export type SemanticExposureDeclaration = {
  readonly kind: "exposure";
  readonly ownerModule: string;
  readonly exportName: string;
  readonly binding: StructuralBindingDeclaration;
  readonly axes: Readonly<Record<DeferredSemanticAxis, SemanticAxisDeclaration>>;
  readonly variant?: SemanticExposureVariant;
  readonly aliasOf?: SemanticExposureAlias;
  /** Non-empty linked service IDs, or a reviewed no-service policy. */
  readonly serviceOperationIds: SemanticServiceLinkage;
};

export type SemanticDeclaration =
  | SemanticExposureDeclaration
  | SemanticServiceOperationDeclaration;

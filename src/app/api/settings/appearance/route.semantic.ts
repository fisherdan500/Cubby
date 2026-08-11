import type { SemanticExposureDeclaration } from "@/server/operation-registry/schema";

export const semantic = [
  {
    "kind": "exposure",
    "ownerModule": "src/app/api/settings/appearance/route.ts",
    "exportName": "PATCH",
    "binding": {
      "kind": "route_method",
      "symbol": "PATCH",
      "target": "src/app/api/settings/appearance/route.ts#PATCH"
    },
    "serviceOperationIds": [
      "settings.appearance.update"
    ],
    "axes": {
      "carrier_authority_guard": {
        "current": {
          "authority": "source_reviewed",
          "value": "Current exposure delegates household selection to the linked service; no explicit effective-household carrier is established here.",
          "sourceReferences": [
            {
              "kind": "symbol",
              "file": "src/app/api/settings/appearance/route.ts",
              "exportName": "PATCH"
            }
          ]
        },
        "target": {
          "authority": "deferred",
          "gateId": "gate.carrier_authority_guard"
        }
      },
      "caller_controlled_scope": {
        "current": {
          "authority": "source_reviewed",
          "value": "Current exposure accepts input at this binding; caller-controlled scope remains unresolved by this declaration.",
          "sourceReferences": [
            {
              "kind": "symbol",
              "file": "src/app/api/settings/appearance/route.ts",
              "exportName": "PATCH"
            }
          ]
        },
        "target": {
          "authority": "deferred",
          "gateId": "gate.caller_controlled_scope"
        }
      },
      "service_operation_linkage": {
        "current": {
          "authority": "source_reviewed",
          "value": "Current exposure directly invokes the linked source-reviewed service operation.",
          "sourceReferences": [
            {
              "kind": "symbol",
              "file": "src/app/api/settings/appearance/route.ts",
              "exportName": "PATCH"
            }
          ]
        },
        "target": {
          "authority": "deferred",
          "gateId": "gate.service_operation_linkage"
        }
      },
      "permission_commit_reauthorization": {
        "current": {
          "authority": "deferred",
          "gateId": "gate.permission_commit_reauthorization"
        },
        "target": {
          "authority": "deferred",
          "gateId": "gate.permission_commit_reauthorization"
        }
      },
      "tenant_relationship_invariants": {
        "current": {
          "authority": "deferred",
          "gateId": "gate.tenant_relationship_invariants"
        },
        "target": {
          "authority": "deferred",
          "gateId": "gate.tenant_relationship_invariants"
        }
      },
      "model_reads_writes_effects": {
        "current": {
          "authority": "deferred",
          "gateId": "gate.model_and_effects"
        },
        "target": {
          "authority": "deferred",
          "gateId": "gate.model_and_effects"
        }
      },
      "variant_specific_outcomes": {
        "current": {
          "authority": "not_applicable",
          "rationale": "This binding has no declared semantic variant.",
          "sourceReferences": [
            {
              "kind": "symbol",
              "file": "src/app/api/settings/appearance/route.ts",
              "exportName": "PATCH"
            }
          ]
        },
        "target": {
          "authority": "deferred",
          "gateId": "gate.variant_outcomes"
        }
      },
      "worker_loop_claim_failure_containment": {
        "current": {
          "authority": "not_applicable",
          "rationale": "This browser exposure is not a worker-loop claim boundary.",
          "sourceReferences": [
            {
              "kind": "symbol",
              "file": "src/app/api/settings/appearance/route.ts",
              "exportName": "PATCH"
            }
          ]
        },
        "target": {
          "authority": "deferred",
          "gateId": "gate.worker_containment"
        }
      },
      "browser_immutable_binding_stale_behavior": {
        "current": {
          "authority": "deferred",
          "gateId": "gate.browser_binding_staleness"
        },
        "target": {
          "authority": "deferred",
          "gateId": "gate.browser_binding_staleness"
        }
      },
      "executable_evidence_strength": {
        "current": {
          "authority": "deferred",
          "gateId": "gate.executable_evidence"
        },
        "target": {
          "authority": "deferred",
          "gateId": "gate.executable_evidence"
        }
      }
    }
  }
] as const satisfies readonly SemanticExposureDeclaration[];

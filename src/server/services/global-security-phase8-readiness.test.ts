import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const readiness = JSON.parse(readFileSync(fileURLToPath(new URL("../../../docs/design/p1-3-phase8-readiness.json", import.meta.url)), "utf8"));

describe("Phase 8 source readiness", () => {
  it("activates the complete Phase 8 local candidate while keeping the program unreleased", () => {
    expect(readiness).toMatchObject({ schemaVersion: 1, phase: "phase8_private_history_throttling", activationState: "active_local_candidate", authority: "phase8_source_readiness", completeProgramReleaseState: "unreleased_until_phase9" });
    expect(readiness.surfaces).toEqual([
      "src/app/api/account/security-history/export/route.ts",
      "src/app/api/account/security-history/route.ts",
      "src/app/api/auth/[...all]/route.ts",
      "src/app/app/settings/security-history/page.tsx",
      "src/components/settings/security-history.tsx",
      "src/server/services/global-security-history.ts",
      "src/server/services/global-security-throttling.ts",
      "scripts/security-operator.ts"
    ]);
    expect(readiness.gates.map((gate: { id: string; state: string }) => `${gate.id}:${gate.state}`)).toEqual([
      "phase8.protocol:source_verified",
      "phase8.persistence:source_verified",
      "phase8.throttling_and_carriers:source_verified",
      "phase8.history_routes_export:source_verified",
      "phase8.ui:source_verified",
      "phase8.operator:source_verified",
      "phase8.postgresql_acceptance:source_verified",
      "phase8.browser_acceptance:source_verified",
      "phase8.deployment_roles:source_verified",
      "phase8.operation_registry:source_verified",
      "phase8.documentation:source_verified"
    ]);
    expect(readiness.forbiddenActions).toContain("partial_p1_3_user_release");
  });
});

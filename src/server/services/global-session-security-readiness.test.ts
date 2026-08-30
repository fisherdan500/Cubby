import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const readiness = JSON.parse(readFileSync(fileURLToPath(new URL("../../../docs/design/p1-3-phase7-readiness.json", import.meta.url)), "utf8"));
const root = fileURLToPath(new URL("../../../", import.meta.url));

describe("Phase 7 source readiness", () => {
  it("activates the complete local Phase 7 candidate only through a closed source-owned gate set", () => {
    expect(readiness).toMatchObject({ schemaVersion: 1, phase: "phase7_global_session_security", activationState: "active_local_candidate", authority: "phase7_source_readiness", completeProgramReleaseState: "unreleased_until_phase9" });
    expect(readiness.surfaces).toEqual([
      "src/app/api/account/session-activity/route.ts",
      "src/app/api/account/sessions/route.ts",
      "src/app/api/account/sessions/revoke/route.ts",
      "src/app/api/account/sessions/status/route.ts",
      "src/app/app/settings/sessions/page.tsx",
      "src/components/session-activity-reporter.tsx",
      "src/components/settings/session-manager.tsx"
    ]);
    expect(readiness.gates.map((gate: { id: string }) => gate.id)).toEqual([
      "phase7.protocol", "phase7.persistence", "phase7.service", "phase7.routes", "phase7.qualifying_carriers", "phase7.ui", "phase7.postgresql_acceptance", "phase7.browser_acceptance", "phase7.deployment_roles", "phase7.operation_registry", "phase7.documentation"
    ]);
    expect(readiness.gates.every((gate: { state: string; evidence: string }) => gate.state === "source_verified" && gate.evidence.length > 0)).toBe(true);
    expect(readiness.gates.every((gate: { evidence: string }) => existsSync(resolve(root, gate.evidence)))).toBe(true);
    expect(readiness.forbiddenActions).toEqual(["partial_p1_3_user_release", "commit", "push", "pull_request", "merge", "publish", "deploy", "normal_runtime_database", "live_security_flow"]);
  });
});

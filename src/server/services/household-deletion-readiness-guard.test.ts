import { describe, expect, it } from "vitest";

import {
  assertHouseholdDeletionDeferredFailClosed,
  householdDeletionCandidateSourceFiles,
  householdDeletionDeferredFailClosedForbiddenSurfaces,
} from "../../../scripts/household-deletion-readiness-guard";

describe("household deletion deferred fail-closed readiness guard", () => {
  it("rejects every forbidden invitation-containment surface while retaining the reviewed deferral marker", () => {
    expect(householdDeletionDeferredFailClosedForbiddenSurfaces).toEqual(expect.arrayContaining([
      "InvitationHouseholdDeleteAuthorization",
      "delete_household_with_invitation_containment_v2",
      "cubby_household_delete_runtime",
      "HOUSEHOLD_DELETE_DATABASE_URL",
      "invitation.household.contain",
      "invitation-household-delete-prisma",
      "api/households/delete",
    ]));

    expect(() => assertHouseholdDeletionDeferredFailClosed()).not.toThrow();
  });

  it("excludes its source and generated forms from the forbidden-surface scan", () => {
    const candidates = householdDeletionCandidateSourceFiles().map((path) => path.replaceAll("\\", "/"));
    expect(candidates.some((path) => /household-deletion-readiness-guard\.(?:ts|mjs)$/.test(path))).toBe(false);
    expect(candidates.some((path) => path.endsWith("/scripts/p1-3-invitation.runtime-probe.ts"))).toBe(false);
  });
});

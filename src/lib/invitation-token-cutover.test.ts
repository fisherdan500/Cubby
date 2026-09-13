import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { consumeInvitationFragment } from "@/lib/invitation-token-cutover";

describe("invitation token cutover", () => {
  it("accepts only the fragment carrier and returns a token-free replacement URL", () => {
    expect(
      consumeInvitationFragment("https://cubby.test/invite#c=raw-invitation-token")
    ).toEqual({
      rawToken: "raw-invitation-token",
      replacementUrl: "/invite"
    });
  });

  it("never accepts a token from a path, query, or unrelated fragment field", () => {
    expect(consumeInvitationFragment("https://cubby.test/invite/raw-token")).toBeNull();
    expect(consumeInvitationFragment("https://cubby.test/invite?c=raw-token")).toBeNull();
    expect(consumeInvitationFragment("https://cubby.test/invite#token=raw-token")).toBeNull();
  });

  it("removes the legacy client component and sidecar that carried raw path tokens", () => {
    for (const path of [
      "../components/actions/accept-invite-button.tsx",
      "../components/actions/accept-invite-button.operation.ts",
    ]) {
      expect(existsSync(fileURLToPath(new URL(path, import.meta.url))), path).toBe(false);
    }
  });
});

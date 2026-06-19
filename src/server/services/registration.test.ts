import { describe, expect, it } from "vitest";
import { extractInviteToken } from "@/server/services/registration";

describe("registration helpers", () => {
  it("extracts invite tokens from callback paths", () => {
    expect(extractInviteToken("/invite/token-123")).toBe("token-123");
    expect(extractInviteToken("http://localhost:3002/invite/abc?next=1")).toBe("abc");
    expect(extractInviteToken("/onboarding")).toBeUndefined();
  });
});

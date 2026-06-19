import { describe, expect, it } from "vitest";
import { hashInviteToken } from "@/server/services/invites";

describe("invite token hashing", () => {
  it("is deterministic and does not preserve the raw token", () => {
    const token = "invite-token";
    expect(hashInviteToken(token)).toBe(hashInviteToken(token));
    expect(hashInviteToken(token)).not.toBe(token);
  });
});

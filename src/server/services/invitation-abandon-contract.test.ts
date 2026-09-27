import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createInvitationServices } from "@/server/services/invitation-service";

const migration = readFileSync(resolve(process.cwd(), "prisma/migrations/20260904120000_invitation_protocol_v2/migration.sql"), "utf8");
const request = { ordinarySessionId: "session-1", subjectUserId: "user-1", issuerMembershipEpisodeId: "member-1", subjectMembershipEpisodeId: null, openingFingerprint: Buffer.alloc(32, 1), intentFingerprint: null };
const operationId = "11111111-1111-4111-8111-111111111111";

describe("manual invitation abandonment carrier contract", () => {
  it.each(["create", "replace"] as const)("signs the exact %s abandon purpose enforced by SQL", async (kind) => {
    const procedure = `abandon_manual_invite_${kind}_v2`;
    const body = migration.split(`CREATE OR REPLACE FUNCTION invitation_protocol.${procedure}(`)[1]!.split("END $$;")[0]!;
    const expectedPurpose = body.match(/assert_invitation_issuer_authority_v2\(identity_row,request_attestation,NULL,false,'([^']+)'\)/)?.[1];
    expect(expectedPurpose).toBe(kind === "create" ? "manual_invite_abandon" : "manual_invite_replace_abandon");
    const signRequest = vi.fn(() => ({ keyVersion: 1, nonce: Buffer.alloc(32), issuedAt: new Date(), mac: Buffer.alloc(32) }));
    const runtime = { $queryRaw: vi.fn().mockResolvedValue([{ receipt: { operationId, status: "abandoned" } }]) };
    const services = createInvitationServices({ runtime, expiry: runtime, maintenance: runtime, signer: { signRequest } as never });
    const receipt = kind === "create"
      ? await services.manualCreate.abandon({ operationId, householdId: "household-1", request })
      : await services.manualReplace.abandon({ operationId, inviteId: "invite-1", request });
    expect(signRequest).toHaveBeenCalledWith(expect.objectContaining({ ...request, operationId, purpose: expectedPurpose, target: kind === "create" ? "household-1" : "invite-1" }));
    expect(receipt).toEqual({ operationId, status: "abandoned" });
  });
});

import { describe, expect, it, vi } from "vitest";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { passwordSessionProofAdditionalFields } from "@/server/auth/password-session-proof";
import { withSuspendedSessionErrorTranslation } from "@/server/auth/session-adapter";

describe("suspended session adapter translation", () => {
  it("translates only the dedicated suspended-session trigger signal", async () => {
    const triggerError = new Error(
      'Database error: PostgresError { code: "CUB01", message: "Your account is disabled." }'
    );
    const create = vi.fn().mockRejectedValue(triggerError);
    const adapter = withSuspendedSessionErrorTranslation(() => ({ create }) as never)({} as never);

    await expect(adapter.create({ model: "session", data: {} })).rejects.toMatchObject({
      status: "FORBIDDEN",
      body: {
        code: "ACCOUNT_DISABLED",
        message: "Your account is disabled."
      }
    });
  });

  it("preserves unrelated session and non-session adapter errors", async () => {
    const unrelated = new Error("unrelated database failure");
    const create = vi.fn().mockRejectedValue(unrelated);
    const adapter = withSuspendedSessionErrorTranslation(() => ({ create }) as never)({} as never);

    await expect(adapter.create({ model: "session", data: {} })).rejects.toBe(unrelated);

    create.mockRejectedValue(
      new Error('Database error: PostgresError { code: "CUB01", message: "Your account is disabled." }')
    );
    await expect(adapter.create({ model: "user", data: {} })).rejects.toThrow("CUB01");
  });
});

describe("private Session proof Prisma serialization", () => {
  it("constructs the real adapter and passes strict decoded byte fields to Prisma", async () => {
    const create = vi.fn(async ({ data }: { data: Record<string, unknown> }) => data);
    const database = { session: { create } };
    const adapter = prismaAdapter(database as never, { provider: "postgresql" })({
      session: { additionalFields: passwordSessionProofAdditionalFields }
    } as never);
    const digest = Buffer.alloc(32, 3).toString("base64url");

    await adapter.create({
      model: "session",
      data: {
        id: "session-1",
        userId: "user-1",
        token: "token-1",
        expiresAt: new Date("2026-10-01T00:00:00.000Z"),
        createdAt: new Date("2026-09-27T00:00:00.000Z"),
        updatedAt: new Date("2026-09-27T00:00:00.000Z"),
        credentialProofPurpose: "credential_sign_in",
        credentialProofHashDigest: digest,
        credentialProofIssuedAt: new Date("2026-09-27T00:00:00.000Z"),
        credentialProofNonce: digest,
        credentialProofKeyVersion: 1,
        credentialProofMac: digest
      },
      forceAllowId: true
    });

    const written = create.mock.calls[0]?.[0].data as Record<string, unknown>;
    expect(written.credentialProofHashDigest).toEqual(Buffer.alloc(32, 3));
    expect(written.credentialProofNonce).toEqual(Buffer.alloc(32, 3));
    expect(written.credentialProofMac).toEqual(Buffer.alloc(32, 3));
  });

  it("rejects malformed private binary fields before Prisma", async () => {
    const create = vi.fn();
    const adapter = prismaAdapter({ session: { create } } as never, { provider: "postgresql" })({
      session: { additionalFields: passwordSessionProofAdditionalFields }
    } as never);

    await expect(adapter.create({
      model: "session",
      data: { credentialProofHashDigest: "not-base64url" },
      forceAllowId: true
    })).rejects.toThrow("password_session_proof_binary_invalid");
    expect(create).not.toHaveBeenCalled();
  });

  it("leaves optional legacy proof bytes absent instead of breaking ordinary Session persistence", async () => {
    const create = vi.fn(async ({ data }: { data: Record<string, unknown> }) => data);
    const adapter = prismaAdapter({ session: { create } } as never, { provider: "postgresql" })({
      session: { additionalFields: passwordSessionProofAdditionalFields }
    } as never);

    await expect(adapter.create({
      model: "session",
      data: { id: "trusted-session", userId: "user-1", token: "trusted-token" },
      forceAllowId: true
    })).resolves.toBeTruthy();

    expect(create.mock.calls[0]?.[0].data).not.toHaveProperty("credentialProofHashDigest");
    expect(create.mock.calls[0]?.[0].data).not.toHaveProperty("credentialProofNonce");
    expect(create.mock.calls[0]?.[0].data).not.toHaveProperty("credentialProofMac");
  });
});

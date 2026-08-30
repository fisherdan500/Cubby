import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authHandler: vi.fn(),
  runCarrier: vi.fn(),
  configuredKey: vi.fn(),
  precheck: vi.fn(),
  recordFailure: vi.fn(),
  writeEvent: vi.fn(),
  queryRaw: vi.fn(),
  transaction: vi.fn()
}));

vi.mock("@/lib/auth/auth", () => ({
  auth: { handler: mocks.authHandler }
}));
vi.mock("@/lib/db/prisma", () => ({
  prisma: { $queryRaw: mocks.queryRaw, $transaction: mocks.transaction }
}));
vi.mock("@/lib/env", () => ({
  env: { CUBBY_TRUSTED_PROXY_HOPS: 0 }
}));
vi.mock("@/server/services/global-security-throttling", () => ({
  configuredGlobalSecurityThrottleKey: mocks.configuredKey,
  precheckGlobalSecurityThrottle: mocks.precheck,
  recordGlobalSecurityThrottleFailureInTransaction: mocks.recordFailure,
  writeGlobalSecurityEvent: mocks.writeEvent
}));
vi.mock("@/server/services/sign-in-email-throttle", () => ({
  runEmailSignInThrottleCarrier: mocks.runCarrier
}));
import { GET, POST } from "@/app/api/auth/[...all]/route";

beforeEach(() => {
  vi.resetAllMocks();
  mocks.authHandler.mockResolvedValue(new Response(null, { status: 200 }));
  mocks.configuredKey.mockReturnValue(Buffer.alloc(32, 1).toString("base64url"));
  mocks.runCarrier.mockResolvedValue(new Response(null, { status: 200 }));
});

describe("global auth route boundary", () => {
  it("does not forward generic signup before a Cubby-owned initial-credential protocol exists", async () => {
    const request = new Request("http://localhost/api/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "owner@example.test", password: "example-password" })
    });

    await expect(POST(request)).resolves.toMatchObject({ status: 404 });
    expect(mocks.authHandler).not.toHaveBeenCalled();
  });

  it("wraps only canonical email sign-in with the Cubby throttle carrier", async () => {
    const request = new Request("http://localhost/api/auth/sign-in/email", { method: "POST" });

    await POST(request);

    expect(mocks.runCarrier).toHaveBeenCalledWith(request, expect.objectContaining({
      throttleKey: Buffer.alloc(32, 1).toString("base64url"),
      trustedProxyHops: 0,
      invoke: expect.any(Function)
    }));
    expect(mocks.authHandler).not.toHaveBeenCalled();
  });

  it("keeps resolved invalid-sign-in evidence in the same serializable failure transaction", async () => {
    const tx = {};
    mocks.transaction.mockImplementation(async (action: (transaction: typeof tx) => unknown) => action(tx));
    mocks.recordFailure.mockResolvedValue({ quiet: true, deadline: new Date() });
    mocks.writeEvent.mockResolvedValue(undefined);
    const request = new Request("http://localhost/api/auth/sign-in/email", { method: "POST" });

    await POST(request);
    const dependencies = mocks.runCarrier.mock.calls[0]?.[1] as {
      recordFailure: (input: { key: string; client: string }, userId: string) => Promise<unknown>;
    };
    const input = { key: Buffer.alloc(32, 1).toString("base64url"), client: "unknown_client" };
    await dependencies.recordFailure(input, "user-existing");

    expect(mocks.transaction).toHaveBeenCalledWith(expect.any(Function), { isolationLevel: "Serializable" });
    expect(mocks.recordFailure).toHaveBeenCalledWith(tx, input);
    expect(mocks.writeEvent).toHaveBeenCalledWith(tx, "user-existing", "credential", "sign_in_failed");
  });

  it("does not forward generic credential mutation endpoints before their Cubby lifecycle wrapper exists", async () => {
    const request = new Request("http://localhost/api/auth/change-password", { method: "POST" });

    const response = await POST(request);

    expect(response.status).toBe(404);
    expect(mocks.authHandler).not.toHaveBeenCalled();
  });

  it("does not forward generic auth GET endpoints before their Cubby lifecycle wrapper exists", async () => {
    await expect(GET()).resolves.toMatchObject({ status: 404 });
    expect(mocks.authHandler).not.toHaveBeenCalled();
  });
});

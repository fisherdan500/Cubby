import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authHandler: vi.fn(),
  signupPolicyForRequest: vi.fn(),
  transaction: vi.fn(),
  executeRaw: vi.fn()
}));

vi.mock("@/lib/auth/auth", () => ({
  auth: { handler: mocks.authHandler }
}));
vi.mock("@/lib/db/prisma", () => ({
  prisma: { $transaction: mocks.transaction }
}));
vi.mock("@/server/services/registration", () => ({
  signupPolicyForRequest: mocks.signupPolicyForRequest
}));

import { POST } from "@/app/api/auth/[...all]/route";

beforeEach(() => {
  vi.resetAllMocks();
  mocks.transaction.mockImplementation(async (operation: (tx: { $executeRaw: typeof mocks.executeRaw }) => unknown) =>
    operation({ $executeRaw: mocks.executeRaw })
  );
  mocks.executeRaw.mockResolvedValue(1);
  mocks.signupPolicyForRequest.mockResolvedValue({ allowed: true, reason: "bootstrap" });
  mocks.authHandler.mockResolvedValue(new Response(null, { status: 200 }));
});

describe("signup serialization", () => {
  it("acquires a transaction-scoped database lock before checking signup policy and creating an account", async () => {
    const request = new Request("http://localhost/api/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "owner@example.test", password: "example-password" })
    });

    await expect(POST(request)).resolves.toMatchObject({ status: 200 });

    expect(mocks.transaction).toHaveBeenCalledOnce();
    expect(mocks.executeRaw).toHaveBeenCalledOnce();
    expect(mocks.executeRaw.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.signupPolicyForRequest.mock.invocationCallOrder[0]
    );
    expect(mocks.signupPolicyForRequest).toHaveBeenCalledWith(
      request,
      expect.objectContaining({ $executeRaw: mocks.executeRaw })
    );
    expect(mocks.signupPolicyForRequest.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.authHandler.mock.invocationCallOrder[0]
    );
  });

  it("rejects a signup denied by the policy rechecked under the lock", async () => {
    mocks.signupPolicyForRequest.mockResolvedValue({ allowed: false, reason: "closed" });
    const request = new Request("http://localhost/api/auth/sign-up/email", {
      method: "POST",
      body: JSON.stringify({ email: "blocked@example.test" })
    });

    const response = await POST(request);

    expect(response.status).toBe(403);
    expect(mocks.authHandler).not.toHaveBeenCalled();
  });

  it("does not take the signup lock for unrelated auth operations", async () => {
    const request = new Request("http://localhost/api/auth/sign-in/email", { method: "POST" });

    await POST(request);

    expect(mocks.transaction).not.toHaveBeenCalled();
    expect(mocks.authHandler).toHaveBeenCalledWith(request);
  });
});

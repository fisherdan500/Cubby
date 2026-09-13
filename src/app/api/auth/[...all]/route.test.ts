import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authHandler: vi.fn(),
  runCarrier: vi.fn(),
  configuredKey: vi.fn(),
  precheck: vi.fn(),
  recordFailure: vi.fn(),
  writeEvent: vi.fn(),
  queryRaw: vi.fn(),
  transaction: vi.fn(),
  takeRejection: vi.fn()
}));

const fsMocks = vi.hoisted(() => ({ writeFileSync: vi.fn() }));

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
vi.mock("@/server/auth/acceptance-sign-in-rejection", () => ({
  takeBetterAuthSignInRejection: mocks.takeRejection
}));
vi.mock("node:fs", () => fsMocks);
import { GET, POST } from "@/app/api/auth/[...all]/route";

const carrierStagePath = "/run/cubby-acceptance-status/sign-in-carrier-stage";
const originalRouteSentinel = process.env.CUBBY_P13_ACCEPTANCE_ROUTE_SENTINEL;
const originalCarrierStageFile = process.env.CUBBY_P13_ACCEPTANCE_SIGN_IN_CARRIER_STAGE_FILE;

beforeEach(() => {
  vi.resetAllMocks();
  delete process.env.CUBBY_P13_ACCEPTANCE_ROUTE_SENTINEL;
  delete process.env.CUBBY_P13_ACCEPTANCE_SIGN_IN_CARRIER_STAGE_FILE;
  mocks.authHandler.mockResolvedValue(new Response(null, { status: 200 }));
  mocks.configuredKey.mockReturnValue(Buffer.alloc(32, 1).toString("base64url"));
  mocks.runCarrier.mockResolvedValue(new Response(null, { status: 200 }));
});

afterAll(() => {
  if (originalRouteSentinel === undefined) delete process.env.CUBBY_P13_ACCEPTANCE_ROUTE_SENTINEL;
  else process.env.CUBBY_P13_ACCEPTANCE_ROUTE_SENTINEL = originalRouteSentinel;
  if (originalCarrierStageFile === undefined) delete process.env.CUBBY_P13_ACCEPTANCE_SIGN_IN_CARRIER_STAGE_FILE;
  else process.env.CUBBY_P13_ACCEPTANCE_SIGN_IN_CARRIER_STAGE_FILE = originalCarrierStageFile;
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

    const carrierRequest = mocks.runCarrier.mock.calls[0]?.[0] as Request;
    await expect(carrierRequest.json()).resolves.toEqual({ callbackURL: "/invite/dispatch" });
    expect(mocks.runCarrier).toHaveBeenCalledWith(expect.any(Request), expect.objectContaining({
      throttleKey: Buffer.alloc(32, 1).toString("base64url"),
      trustedProxyHops: 0,
      invoke: expect.any(Function)
    }));
    expect(mocks.authHandler).not.toHaveBeenCalled();
  });

  it("enables a fixed content-free carrier observer only behind the exact disposable-acceptance guards", async () => {
    process.env.CUBBY_P13_ACCEPTANCE_ROUTE_SENTINEL = "1";
    process.env.CUBBY_P13_ACCEPTANCE_SIGN_IN_CARRIER_STAGE_FILE = carrierStagePath;

    await POST(new Request("http://localhost/api/auth/sign-in/email", { method: "POST" }));

    const dependencies = mocks.runCarrier.mock.calls[0]?.[1] as {
      observeFailureStage?: (stage: "handler") => void;
    };
    expect(dependencies.observeFailureStage).toEqual(expect.any(Function));
    expect(() => dependencies.observeFailureStage?.("handler")).not.toThrow();
    expect(fsMocks.writeFileSync).toHaveBeenCalledWith(
      carrierStagePath,
      "handler\n",
      { encoding: "utf8", flag: "w", mode: 0o600 }
    );
    dependencies.observeFailureStage?.("unexpected" as never);
    expect(fsMocks.writeFileSync).toHaveBeenCalledOnce();
  });

  it("refines invalid credentials with the fixed Better Auth rejection category after clearing stale categories", async () => {
    process.env.CUBBY_P13_ACCEPTANCE_ROUTE_SENTINEL = "1";
    process.env.CUBBY_P13_ACCEPTANCE_SIGN_IN_CARRIER_STAGE_FILE = carrierStagePath;
    mocks.takeRejection.mockReturnValueOnce("user-not-found").mockReturnValueOnce("password-mismatch").mockReturnValueOnce(undefined);

    await POST(new Request("http://localhost/api/auth/sign-in/email", { method: "POST" }));
    const dependencies = mocks.runCarrier.mock.calls[0]?.[1] as {
      observeFailureStage?: (stage: "invalid-credentials" | "parse") => void;
    };
    dependencies.observeFailureStage?.("invalid-credentials");
    dependencies.observeFailureStage?.("invalid-credentials");
    dependencies.observeFailureStage?.("parse");

    expect(mocks.takeRejection).toHaveBeenCalledTimes(3);
    expect(fsMocks.writeFileSync.mock.calls.map((call) => call[1])).toEqual([
      "invalid-credentials-password-mismatch\n", "invalid-credentials-unclassified\n", "parse\n"
    ]);
  });

  it("does not attach the carrier observer for a mismatched acceptance path", async () => {
    process.env.CUBBY_P13_ACCEPTANCE_ROUTE_SENTINEL = "1";
    process.env.CUBBY_P13_ACCEPTANCE_SIGN_IN_CARRIER_STAGE_FILE = "/tmp/not-allowlisted";

    await POST(new Request("http://localhost/api/auth/sign-in/email", { method: "POST" }));

    expect(mocks.runCarrier.mock.calls[0]?.[1]).not.toHaveProperty("observeFailureStage");
    expect(fsMocks.writeFileSync).not.toHaveBeenCalled();
  });

  it("swallows observer file failures so authentication behavior cannot change", async () => {
    process.env.CUBBY_P13_ACCEPTANCE_ROUTE_SENTINEL = "1";
    process.env.CUBBY_P13_ACCEPTANCE_SIGN_IN_CARRIER_STAGE_FILE = carrierStagePath;
    fsMocks.writeFileSync.mockImplementation(() => { throw new Error("unavailable"); });

    await POST(new Request("http://localhost/api/auth/sign-in/email", { method: "POST" }));
    const dependencies = mocks.runCarrier.mock.calls[0]?.[1] as {
      observeFailureStage?: (stage: "lookup") => void;
    };

    expect(() => dependencies.observeFailureStage?.("lookup")).not.toThrow();
  });

  it("replaces a caller-controlled sign-in callback with the literal invitation dispatch route", async () => {
    const request = new Request("http://localhost/api/auth/sign-in/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "parent@example.test", password: "current-password", callbackURL: "/invite/token-value" })
    });

    await POST(request);

    const carrierRequest = mocks.runCarrier.mock.calls[0]?.[0] as Request;
    await expect(carrierRequest.json()).resolves.toEqual({ email: "parent@example.test", password: "current-password", callbackURL: "/invite/dispatch" });
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

  it("keeps raw Better Auth sign-out denied until a Cubby-owned wrapper exists", async () => {
    const request = new Request("http://localhost/api/auth/sign-out", { method: "POST", headers: { cookie: "better-auth.session_token=synthetic" } });

    const response = await POST(request);

    expect(response.status).toBe(404);
    expect(mocks.authHandler).not.toHaveBeenCalled();
    expect(mocks.runCarrier).not.toHaveBeenCalled();
  });

  it("does not carry a stale content length onto the re-serialized sign-in body and keeps the caller's abort signal", async () => {
    const controller = new AbortController();
    const body = JSON.stringify({ email: "parent@example.test", password: "current-password" });
    const request = new Request("http://localhost/api/auth/sign-in/email", {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": String(body.length) },
      body,
      signal: controller.signal
    });

    await POST(request);

    const carrierRequest = mocks.runCarrier.mock.calls[0]?.[0] as Request;
    expect(carrierRequest.headers.get("content-length")).toBeNull();
    controller.abort();
    expect(carrierRequest.signal.aborted).toBe(true);
  });

  it("does not forward generic auth GET endpoints before their Cubby lifecycle wrapper exists", async () => {
    await expect(GET()).resolves.toMatchObject({ status: 404 });
    expect(mocks.authHandler).not.toHaveBeenCalled();
  });
});

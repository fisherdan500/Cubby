import { describe, expect, it, vi } from "vitest";
import { runEmailSignInThrottleCarrier } from "@/server/services/sign-in-email-throttle";

const key = Buffer.alloc(32, 9).toString("base64url");

function request(email = "casey@example.test") {
  return new Request("http://localhost/api/auth/sign-in/email", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": "198.51.100.12" },
    body: JSON.stringify({ email, password: "not-the-password" })
  });
}

function dependencies(overrides: Partial<Parameters<typeof runEmailSignInThrottleCarrier>[1]> = {}) {
  return {
    throttleKey: key,
    trustedProxyHops: 1,
    findUserIdByNormalizedEmail: vi.fn().mockResolvedValue("user-existing"),
    precheck: vi.fn().mockResolvedValue({ quiet: false, deadline: null }),
    recordFailure: vi.fn().mockResolvedValue({ quiet: false, deadline: null }),
    invoke: vi.fn().mockResolvedValue(new Response(JSON.stringify({ code: "INVALID_EMAIL_OR_PASSWORD" }), {
      status: 401,
      headers: { "content-type": "application/json" }
    })),
    ...overrides
  };
}

describe("email sign-in throttle carrier", () => {
  it("keeps existing and nonexistent invalid credentials byte/status/header equivalent while only binding the existing user privately", async () => {
    const existing = dependencies();
    const absent = dependencies({ findUserIdByNormalizedEmail: vi.fn().mockResolvedValue(undefined) });

    const existingResponse = await runEmailSignInThrottleCarrier(request(), existing);
    const absentResponse = await runEmailSignInThrottleCarrier(request(), absent);

    expect(existingResponse.status).toBe(absentResponse.status);
    expect(await existingResponse.text()).toBe(await absentResponse.text());
    expect([...existingResponse.headers]).toEqual([...absentResponse.headers]);
    expect(existing.recordFailure).toHaveBeenCalledWith(expect.objectContaining({ userId: "user-existing", accountIdentifier: "casey@example.test", client: "198.51.100.12" }), "user-existing");
    expect(absent.recordFailure).toHaveBeenCalledWith(expect.objectContaining({ userId: undefined, accountIdentifier: undefined, client: "198.51.100.12" }), undefined);
    expect(existing.recordFailure).toHaveBeenCalledWith(expect.objectContaining({ userId: "user-existing" }), "user-existing");
  });

  it("substitutes a guaranteed nonexistent synthetic email after any quiet precheck and never verifies the submitted secret", async () => {
    const invoke = vi.fn().mockResolvedValue(new Response(JSON.stringify({ code: "INVALID_EMAIL_OR_PASSWORD" }), {
      status: 401,
      headers: { "content-type": "application/json" }
    }));
    const deps = dependencies({ precheck: vi.fn().mockResolvedValue({ quiet: true, deadline: new Date() }), invoke });

    const response = await runEmailSignInThrottleCarrier(request(), deps);

    expect(response.status).toBe(401);
    expect(response.headers.get("retry-after")).toBeNull();
    const forwarded = invoke.mock.calls[0]?.[0] as Request;
    expect((await forwarded.json()).email).toMatch(/^cubby-throttle-[0-9a-f-]{36}@invalid\.test$/);
    expect(deps.recordFailure).toHaveBeenCalledWith(expect.objectContaining({ userId: "user-existing", client: "198.51.100.12" }), "user-existing");
  });

  it("records the fifth invalid credential attempt through the single failure operation and one user event", async () => {
    const deps = dependencies({ recordFailure: vi.fn().mockResolvedValue({ quiet: true, deadline: new Date() }) });

    for (let attempt = 0; attempt < 5; attempt += 1) await runEmailSignInThrottleCarrier(request(), deps);

    expect(deps.recordFailure).toHaveBeenCalledTimes(5);
    expect(deps.recordFailure).toHaveBeenLastCalledWith(expect.objectContaining({ userId: "user-existing" }), "user-existing");
  });

  it("leaves successful sign-in evidence to the atomic Session insert trigger", async () => {
    const deps = dependencies({
      invoke: vi.fn().mockResolvedValue(new Response(JSON.stringify({ token: "opaque" }), { status: 200 }))
    });

    await expect(runEmailSignInThrottleCarrier(request(), deps)).resolves.toMatchObject({ status: 200 });

    expect(deps.recordFailure).not.toHaveBeenCalled();
    expect(JSON.stringify(deps)).not.toContain("writeEvent");
  });

  it("leaves malformed and non-auth Better Auth outcomes outside throttle and history mutation", async () => {
    const malformed = dependencies();
    const protocol = dependencies({
      invoke: vi.fn().mockResolvedValue(new Response(JSON.stringify({ code: "INVALID_EMAIL" }), { status: 400 }))
    });

    await runEmailSignInThrottleCarrier(new Request("http://localhost/api/auth/sign-in/email", { method: "POST", body: "not-json" }), malformed);
    await runEmailSignInThrottleCarrier(request(), protocol);

    expect(malformed.precheck).not.toHaveBeenCalled();
    expect(malformed.recordFailure).not.toHaveBeenCalled();
    expect(protocol.recordFailure).not.toHaveBeenCalled();
  });

  it("returns one fixed account-neutral 503 without Retry-After when failure evidence cannot persist", async () => {
    const response = await runEmailSignInThrottleCarrier(request(), dependencies({ recordFailure: vi.fn().mockRejectedValue(new Error("injected")) }));
    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBeNull();
    await expect(response.json()).resolves.toEqual({ code: "security_sign_in_evidence_unavailable" });
  });

  it.each([
    {
      stage: "lookup",
      overrides: { findUserIdByNormalizedEmail: vi.fn().mockRejectedValue(new Error("injected")) },
      status: 401
    },
    {
      stage: "precheck",
      overrides: { precheck: vi.fn().mockRejectedValue(new Error("injected")) },
      status: 503
    },
    {
      stage: "handler",
      overrides: { invoke: vi.fn().mockRejectedValue(new Error("injected")) },
      status: 503
    },
    {
      stage: "failure-recording",
      overrides: { recordFailure: vi.fn().mockRejectedValue(new Error("injected")) },
      status: 503
    }
  ])("reports only the fixed $stage carrier failure stage", async ({ stage, overrides, status }) => {
    const observeFailureStage = vi.fn();
    const response = await runEmailSignInThrottleCarrier(request(), dependencies({
      ...overrides,
      observeFailureStage
    }));

    expect(response.status).toBe(status);
    expect(observeFailureStage).toHaveBeenCalledOnce();
    expect(observeFailureStage).toHaveBeenCalledWith(stage);
  });

  it("marks recorded invalid credentials and strict-parse failures with fixed stages only", async () => {
    const invalid = vi.fn();
    await expect(runEmailSignInThrottleCarrier(request(), dependencies({ observeFailureStage: invalid }))).resolves.toMatchObject({ status: 401 });
    expect(invalid).toHaveBeenCalledOnce();
    expect(invalid).toHaveBeenCalledWith("invalid-credentials");

    const miss = vi.fn();
    await runEmailSignInThrottleCarrier(request(), dependencies({ findUserIdByNormalizedEmail: vi.fn().mockResolvedValue(undefined), observeFailureStage: miss }));
    expect(miss).toHaveBeenCalledOnce();
    expect(miss).toHaveBeenCalledWith("lookup-miss");

    const parse = vi.fn();
    const malformed = dependencies({ observeFailureStage: parse });
    await expect(runEmailSignInThrottleCarrier(new Request("http://localhost/api/auth/sign-in/email", { method: "POST", body: "not-json" }), malformed)).resolves.toMatchObject({ status: 401 });
    expect(parse).toHaveBeenCalledOnce();
    expect(parse).toHaveBeenCalledWith("parse");
    expect(malformed.recordFailure).not.toHaveBeenCalled();
  });

  it("emits the fixed positive-control stage only for a successful handler response", async () => {
    const observeFailureStage = vi.fn();
    const response = await runEmailSignInThrottleCarrier(request(), dependencies({
      invoke: vi.fn().mockResolvedValue(new Response(JSON.stringify({ token: "opaque" }), { status: 200 })),
      observeFailureStage
    }));

    expect(response.status).toBe(200);
    expect(observeFailureStage).toHaveBeenCalledOnce();
    expect(observeFailureStage).toHaveBeenCalledWith("handler-ok");

    const throwing = await runEmailSignInThrottleCarrier(request(), dependencies({
      invoke: vi.fn().mockResolvedValue(new Response(JSON.stringify({ token: "opaque" }), { status: 200 })),
      observeFailureStage: () => { throw new Error("observer unavailable"); }
    }));
    expect(throwing.status).toBe(200);
  });

  it("keeps authentication behavior unchanged when the optional observer itself fails", async () => {
    const response = await runEmailSignInThrottleCarrier(request(), dependencies({
      invoke: vi.fn().mockResolvedValue(new Response("noncanonical", { status: 500 })),
      observeFailureStage: () => { throw new Error("observer unavailable"); }
    }));

    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBeNull();
    await expect(response.json()).resolves.toEqual({ code: "security_sign_in_evidence_unavailable" });
  });

  it("keeps the first causal carrier stage when a degraded fallback also fails", async () => {
    const observeFailureStage = vi.fn();
    const response = await runEmailSignInThrottleCarrier(request(), dependencies({
      findUserIdByNormalizedEmail: vi.fn().mockRejectedValue(new Error("lookup failed")),
      invoke: vi.fn().mockRejectedValue(new Error("synthetic handler failed")),
      observeFailureStage
    }));

    expect(response.status).toBe(503);
    expect(observeFailureStage).toHaveBeenCalledOnce();
    expect(observeFailureStage).toHaveBeenCalledWith("lookup");
  });

  it("normalizes canonical handler and atomic Session-event failures to the fixed neutral 503", async () => {
    for (const invoke of [
      vi.fn().mockRejectedValue(new Error("synthetic_session_event_failure")),
      vi.fn().mockResolvedValue(new Response("noncanonical", { status: 500, headers: { "retry-after": "10" } }))
    ]) {
      const deps = dependencies({ invoke });
      const response = await runEmailSignInThrottleCarrier(request(), deps);
      expect(response.status).toBe(503);
      expect(response.headers.get("retry-after")).toBeNull();
      expect(await response.json()).toEqual({ code: "security_sign_in_evidence_unavailable" });
      expect(deps.recordFailure).not.toHaveBeenCalled();
    }
  });

  it("normalizes synthetic-handler failures after quiet denial and lookup degradation", async () => {
    for (const invoke of [
      vi.fn().mockRejectedValue(new Error("synthetic_handler_failure")),
      vi.fn().mockResolvedValue(new Response("noncanonical", { status: 500, headers: { "retry-after": "10" } }))
    ]) {
      for (const overrides of [
        { precheck: vi.fn().mockResolvedValue({ quiet: true, deadline: new Date() }), invoke },
        { findUserIdByNormalizedEmail: vi.fn().mockRejectedValue(new Error("lookup_failed")), invoke }
      ]) {
        const response = await runEmailSignInThrottleCarrier(request(), dependencies(overrides));
        expect(response.status).toBe(503);
        expect(response.headers.get("cache-control")).toBe("no-store");
        expect(response.headers.get("retry-after")).toBeNull();
        expect(await response.json()).toEqual({ code: "security_sign_in_evidence_unavailable" });
      }
    }
  });
});

import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  canonicalizeTrustedClient,
  deriveThrottleIdentity,
  normalizeThrottleAccountIdentifier,
  precheckGlobalSecurityThrottle,
  recordGlobalSecurityThrottleFailure
} from "@/server/services/global-security-throttling";

const testKey = Buffer.alloc(32, 7).toString("base64url");

describe("global security throttle core", () => {
  it("uses exact uint32BE length framing for full base64url HMAC identity digests", () => {
    const domain = "cubby:phase8:account-identifier:v1";
    const value = "account_identifier_v1\0casey@example.test";
    const frame = Buffer.concat([
      Buffer.from([0, 0, 0, Buffer.byteLength(domain)]), Buffer.from(domain),
      Buffer.from([0, 0, 0, Buffer.byteLength(value)]), Buffer.from(value)
    ]);
    const expected = createHmac("sha256", Buffer.alloc(32, 7)).update(frame).digest("base64url");

    expect(deriveThrottleIdentity(testKey, domain, value)).toBe(expected);
    expect(normalizeThrottleAccountIdentifier("  CASEY@Example.Test ")).toBe("casey@example.test");
    expect(() => deriveThrottleIdentity("bad", domain, value)).toThrow("global_security_throttle_key_invalid");
  });

  it("accepts only one strict forwarded address with a configured one-hop proxy and otherwise uses unknown_client", () => {
    expect(canonicalizeTrustedClient(0, "198.51.100.12")).toBe("unknown_client");
    expect(canonicalizeTrustedClient(1, "198.51.100.12")).toBe("198.51.100.12");
    expect(canonicalizeTrustedClient(1, "198.51.100.012")).toBe("unknown_client");
    expect(canonicalizeTrustedClient(1, "[2001:0DB8:0:0:0:0:0:1]")).toBe("2001:db8::1");
    expect(canonicalizeTrustedClient(1, "198.51.100.12, 203.0.113.8")).toBe("unknown_client");
    expect(canonicalizeTrustedClient(1, "")).toBe("unknown_client");
    expect(() => canonicalizeTrustedClient(2, "198.51.100.12")).toThrow("global_security_trusted_proxy_hops_invalid");
  });

  it("calls only the neutral deadline procedures with HMAC digests and no raw identifiers", async () => {
    const $queryRaw = vi.fn()
      .mockResolvedValueOnce([{ quiet: false, deadline: null }])
      .mockResolvedValueOnce([{ quiet: true, deadline: new Date("2026-08-29T12:15:00.000Z") }]);
    const database = { $transaction: vi.fn(async (action) => action({ $queryRaw })) } as never;
    const input = { key: testKey, userId: "user_1", accountIdentifier: " Casey@example.test ", client: "198.51.100.12" };

    await expect(precheckGlobalSecurityThrottle(database, input)).resolves.toEqual({ quiet: false, deadline: null });
    await expect(recordGlobalSecurityThrottleFailure(database, input)).resolves.toEqual({ quiet: true, deadline: new Date("2026-08-29T12:15:00.000Z") });
    expect($queryRaw).toHaveBeenCalledTimes(2);
    for (const call of $queryRaw.mock.calls) expect(JSON.stringify(call)).not.toContain("Casey@example.test");
  });

  it("never lets the deployment bucket gate a proof, because tripping it would reject every correct password", async () => {
    const $queryRaw = vi.fn().mockResolvedValue([{ quiet: false, deadline: null }]);
    const database = { $transaction: vi.fn(async (action) => action({ $queryRaw })) } as never;
    // Shipped default: CUBBY_TRUSTED_PROXY_HOPS=0 makes every caller share one client bucket.
    const input = { key: testKey, userId: "user_1", accountIdentifier: "casey@example.test", client: "unknown_client" };

    await precheckGlobalSecurityThrottle(database, input);
    const [, , , accountKey, clientKey, deploymentKey] = $queryRaw.mock.calls[0]!;
    expect(accountKey).not.toBeNull();
    expect(clientKey).toBeNull();
    expect(deploymentKey).toBeNull();

    await recordGlobalSecurityThrottleFailure(database, input);
    const [, , , evidenceAccount, evidenceClient, evidenceDeployment] = $queryRaw.mock.calls[1]!;
    expect(evidenceAccount).not.toBeNull();
    expect(evidenceClient).not.toBeNull();
    expect(evidenceDeployment).not.toBeNull();
  });

  it("lets the client bucket gate a proof once a trusted hop supplies a real client identity", async () => {
    const $queryRaw = vi.fn().mockResolvedValue([{ quiet: false, deadline: null }]);
    const database = { $transaction: vi.fn(async (action) => action({ $queryRaw })) } as never;
    const input = { key: testKey, userId: "user_1", accountIdentifier: "casey@example.test", client: "198.51.100.12" };

    await precheckGlobalSecurityThrottle(database, input);
    const [, , , accountKey, clientKey, deploymentKey] = $queryRaw.mock.calls[0]!;
    expect(accountKey).not.toBeNull();
    expect(clientKey).not.toBeNull();
    expect(deploymentKey).toBeNull();
  });

  it("falls back to the deployment bucket when no discriminating layer can gate, so an account-less request still has a brake", async () => {
    const $queryRaw = vi.fn().mockResolvedValue([{ quiet: false, deadline: null }]);
    const database = { $transaction: vi.fn(async (action) => action({ $queryRaw })) } as never;
    // The unknown-address branch: no account resolved, shared client bucket. Without the fallback
    // this request reaches the password hash with no gate at all, which is unbounded free CPU.
    const input = { key: testKey, client: "unknown_client" };

    await precheckGlobalSecurityThrottle(database, input);
    const [, , userId, accountKey, clientKey, deploymentKey] = $queryRaw.mock.calls[0]!;
    expect(userId).toBeNull();
    expect(accountKey).toBeNull();
    expect(clientKey).toBeNull();
    expect(deploymentKey).not.toBeNull();

    await recordGlobalSecurityThrottleFailure(database, input);
    const [, , , , evidenceClient, evidenceDeployment] = $queryRaw.mock.calls[1]!;
    expect(evidenceClient).not.toBeNull();
    expect(evidenceDeployment).not.toBeNull();
  });
});

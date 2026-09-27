import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getPlatformOwnerContext: vi.fn(),
  userFindUnique: vi.fn(),
  transaction: vi.fn(),
  writePlatformAudit: vi.fn()
}));

vi.mock("@/server/services/platform-authority", () => ({ getPlatformOwnerContext: mocks.getPlatformOwnerContext }));
vi.mock("@/server/services/audit", () => ({ writePlatformAudit: mocks.writePlatformAudit }));
vi.mock("@/lib/db/prisma", () => ({
  prisma: { user: { findUnique: mocks.userFindUnique }, $transaction: mocks.transaction }
}));

import { classifySmtpFailure, sendPlatformTestEmail } from "@/server/services/platform-test-email";

function adapterSending(send: (payload: { recipient: string; subject: string; text: string; messageId: string }) => Promise<unknown>) {
  return () => ({ send: vi.fn(send) });
}

let monotonicNow = 0;
beforeEach(() => {
  vi.restoreAllMocks();
  vi.resetAllMocks();
  monotonicNow += 120_000;
  vi.spyOn(performance, "now").mockImplementation(() => monotonicNow);
  mocks.getPlatformOwnerContext.mockResolvedValue({ userId: "usr_owner", authorityId: "platform" });
  mocks.userFindUnique.mockResolvedValue({ email: "owner@example.test" });
  mocks.transaction.mockImplementation(async (callback) => callback({ tx: true }));
  mocks.writePlatformAudit.mockResolvedValue({ id: "audit-1" });
});

describe("sendPlatformTestEmail", () => {
  it("claims before transport construction and holds through settlement, then waits 60 seconds", async () => {
    let settle!: () => void;
    const send = vi.fn(async () => {}).mockImplementationOnce(() => new Promise<void>((resolve) => { settle = resolve; }));
    const createAdapter = vi.fn(() => ({ send }));
    const first = sendPlatformTestEmail(createAdapter);
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    monotonicNow += 120_000;
    await expect(sendPlatformTestEmail(createAdapter)).resolves.toEqual({ status: "throttled", retryAfterSeconds: 60 });
    expect(createAdapter).toHaveBeenCalledTimes(1);
    settle();
    await expect(first).resolves.toMatchObject({ status: "sent" });
    await expect(sendPlatformTestEmail(createAdapter)).resolves.toEqual({ status: "throttled", retryAfterSeconds: 60 });
    monotonicNow += 59_999;
    await expect(sendPlatformTestEmail(createAdapter)).resolves.toEqual({ status: "throttled", retryAfterSeconds: 1 });
    monotonicNow += 1;
    send.mockResolvedValueOnce();
    await expect(sendPlatformTestEmail(createAdapter)).resolves.toMatchObject({ status: "sent" });
    expect(createAdapter).toHaveBeenCalledTimes(2);
  });

  it.each(["transport", "unavailable", "audit"])("consumes cooldown after %s failure without an automatic resend", async (kind) => {
    const send = vi.fn(async () => { if (kind === "transport") throw new Error("smtp_temporary"); });
    const createAdapter = vi.fn(() => { if (kind === "unavailable") throw new Error("unavailable"); return { send }; });
    if (kind === "audit") mocks.writePlatformAudit.mockRejectedValueOnce(new Error("audit_failed"));
    if (kind === "audit") await expect(sendPlatformTestEmail(createAdapter)).rejects.toThrow("audit_failed");
    else await expect(sendPlatformTestEmail(createAdapter)).resolves.toMatchObject({ status: kind === "transport" ? "failed" : "not_configured" });
    await expect(sendPlatformTestEmail(createAdapter)).resolves.toMatchObject({ status: "throttled" });
    expect(createAdapter).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(kind === "unavailable" ? 0 : 1);
    monotonicNow += 60_000;
    await sendPlatformTestEmail(createAdapter);
    expect(createAdapter).toHaveBeenCalledTimes(2);
  });

  it("keeps admission while a successful send awaits audit settlement", async () => {
    let settle!: () => void;
    mocks.writePlatformAudit.mockImplementationOnce(() => new Promise<void>((resolve) => { settle = resolve; }));
    const createAdapter = vi.fn(() => ({ send: vi.fn(async () => {}) }));
    const first = sendPlatformTestEmail(createAdapter);
    await vi.waitFor(() => expect(mocks.writePlatformAudit).toHaveBeenCalledTimes(1));
    monotonicNow += 120_000;
    await expect(sendPlatformTestEmail(createAdapter)).resolves.toMatchObject({ status: "throttled" });
    expect(createAdapter).toHaveBeenCalledTimes(1);
    settle();
    await first;
  });

  it("sends one message to the platform owner's own address and audits it", async () => {
    const send = vi.fn(async () => ({ responseCode: 250 }));

    await expect(sendPlatformTestEmail(() => ({ send }))).resolves.toEqual({ status: "sent", recipient: "owner@example.test" });

    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      recipient: "owner@example.test",
      subject: "Cubby test email",
      messageId: expect.stringMatching(/^<cubby-test\.[0-9a-f-]+@mail\.cubby\.local>$/)
    }));
    expect(mocks.writePlatformAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "platform.email.test", actorUserId: "usr_owner", source: "email_test_sent" }),
      { tx: true }
    );
  });

  it("refuses anyone who is not the platform owner before touching mail", async () => {
    mocks.getPlatformOwnerContext.mockRejectedValue(new Error("forbidden"));
    const createAdapter = vi.fn();

    await expect(sendPlatformTestEmail(createAdapter)).rejects.toThrow("forbidden");
    expect(createAdapter).not.toHaveBeenCalled();
    expect(mocks.writePlatformAudit).not.toHaveBeenCalled();
  });

  it("reports mail as not configured when the SMTP settings are incomplete", async () => {
    const createAdapter = () => {
      throw new Error("email_delivery_smtp_unavailable");
    };

    await expect(sendPlatformTestEmail(createAdapter)).resolves.toEqual({ status: "not_configured" });
    expect(mocks.writePlatformAudit).toHaveBeenCalledWith(expect.objectContaining({ source: "email_test_not_configured" }), { tx: true });
  });

  it("reports a failed send with its category and the server's reply code, never the raw error text", async () => {
    const failure = Object.assign(new Error("Invalid login: 535 5.7.8 secret-bearing detail"), { code: "EAUTH", responseCode: 535 });

    const result = await sendPlatformTestEmail(adapterSending(async () => { throw failure; }));

    expect(result).toEqual({ status: "failed", reason: "authentication", responseCode: 535, recipient: "owner@example.test" });
    expect(JSON.stringify(result)).not.toContain("secret-bearing");
    expect(mocks.writePlatformAudit).toHaveBeenCalledWith(expect.objectContaining({ source: "email_test_failed_authentication" }), { tx: true });
  });
});

describe("classifySmtpFailure", () => {
  it.each([
    [{ code: "EAUTH" }, "authentication", null],
    [{ responseCode: 535 }, "authentication", 535],
    [{ code: "ECONNECTION" }, "connection", null],
    [{ code: "ETIMEDOUT" }, "connection", null],
    [{ code: "EDNS" }, "connection", null],
    [{ code: "ESOCKET" }, "connection", null],
    [{ message: "smtp_temporary" }, "temporary", null],
    [{ responseCode: 451 }, "temporary", 451],
    [{ message: "recipient_rejected" }, "rejected", null],
    [{ message: "smtp_rejected" }, "rejected", null],
    [{ code: "EENVELOPE", responseCode: 553 }, "rejected", 553],
    [{ responseCode: 550 }, "rejected", 550],
    [{ message: "something else" }, "unknown", null],
    ["not even an error", "unknown", null]
  ])("classifies %j as %s", (shape, reason, responseCode) => {
    const error = typeof shape === "string" ? shape : Object.assign(new Error((shape as { message?: string }).message ?? "smtp failure"), shape);
    expect(classifySmtpFailure(error)).toEqual({ reason, responseCode });
  });
});

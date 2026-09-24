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

beforeEach(() => {
  vi.resetAllMocks();
  mocks.getPlatformOwnerContext.mockResolvedValue({ userId: "usr_owner", authorityId: "platform" });
  mocks.userFindUnique.mockResolvedValue({ email: "owner@example.test" });
  mocks.transaction.mockImplementation(async (callback) => callback({ tx: true }));
  mocks.writePlatformAudit.mockResolvedValue({ id: "audit-1" });
});

describe("sendPlatformTestEmail", () => {
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

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  issue: vi.fn(), submit: vi.fn(), update: vi.fn(), remove: vi.fn(), restore: vi.fn(), suspend: vi.fn(), failure: vi.fn()
}));
vi.mock("@/server/services/invites", () => ({
  issueMemberBrowserOperation: mocks.issue, submitMemberBrowserOperation: mocks.submit,
  updateMemberRole: mocks.update, removeMember: mocks.remove, restoreMember: mocks.restore, suspendMember: mocks.suspend
}));
vi.mock("@/server/services/browser-operations", () => ({ browserOperationFailureResult: mocks.failure }));

import { PATCH, DELETE } from "@/app/api/members/[id]/route";
import { POST as restore } from "@/app/api/members/[id]/restore/route";
import { POST as suspend } from "@/app/api/members/[id]/suspend/route";

const operationId = "bmo_0123456789abcdefghjkmnpqrs";
const context = { params: Promise.resolve({ id: "member-1" }) };
const jsonRequest = (url: string, method: string, body: Record<string, unknown>) => new Request(url, {
  method,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body)
});

beforeEach(() => {
  vi.resetAllMocks();
  mocks.issue.mockResolvedValue({ status: "open", operationId, bindingId: "binding-1" });
  mocks.submit.mockResolvedValue({ status: "completed", operationId, outcome: { kind: "member", code: "role_updated", memberId: "member-1", role: "caretaker" } });
});

describe("member routes browser-v2", () => {
  it("issues and submits a role update bound to the path member", async () => {
    const response = await PATCH(jsonRequest("http://localhost/api/members/member-1", "PATCH", { operationId, role: "caretaker" }), context);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true, data: { status: "completed", operationId } });
    expect(mocks.issue).toHaveBeenCalledWith("role.update", { operationId, role: "caretaker", memberId: "member-1" });
    expect(mocks.submit).toHaveBeenCalledWith("role.update", { operationId, role: "caretaker", memberId: "member-1" });
  });

  it("issues and submits a removal bound to the path member", async () => {
    const response = await DELETE(jsonRequest("http://localhost/api/members/member-1", "DELETE", { operationId }), context);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true, data: { status: "completed", operationId } });
    expect(mocks.issue).toHaveBeenCalledWith("remove", { operationId, memberId: "member-1" });
    expect(mocks.submit).toHaveBeenCalledWith("remove", { operationId, memberId: "member-1" });
  });

  it("issues and submits a restoration bound to the path member", async () => {
    const response = await restore(jsonRequest("http://localhost/api/members/member-1/restore", "POST", { operationId }), context);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true, data: { status: "completed", operationId } });
    expect(mocks.issue).toHaveBeenCalledWith("restore", { operationId, memberId: "member-1" });
    expect(mocks.submit).toHaveBeenCalledWith("restore", { operationId, memberId: "member-1" });
  });

  it("issues and submits a suspension bound to the path member", async () => {
    const response = await suspend(jsonRequest("http://localhost/api/members/member-1/suspend", "POST", { operationId }), context);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true, data: { status: "completed", operationId } });
    expect(mocks.issue).toHaveBeenCalledWith("suspend", { operationId, memberId: "member-1" });
    expect(mocks.submit).toHaveBeenCalledWith("suspend", { operationId, memberId: "member-1" });
  });

  it("leaves legacy requests on their existing service contracts", async () => {
    mocks.update.mockResolvedValue({ id: "member-1", role: "caretaker" });
    mocks.remove.mockResolvedValue({ id: "member-1" });
    mocks.restore.mockResolvedValue({ id: "member-1" });
    mocks.suspend.mockResolvedValue({ id: "member-1" });

    await PATCH(jsonRequest("http://localhost/api/members/member-1", "PATCH", { role: "caretaker" }), context);
    await DELETE(new Request("http://localhost/api/members/member-1", { method: "DELETE" }), context);
    await restore(new Request("http://localhost/api/members/member-1/restore", { method: "POST" }), context);
    await suspend(new Request("http://localhost/api/members/member-1/suspend", { method: "POST" }), context);

    expect(mocks.update).toHaveBeenCalledWith("member-1", { role: "caretaker" });
    expect(mocks.remove).toHaveBeenCalledWith("member-1");
    expect(mocks.restore).toHaveBeenCalledWith("member-1");
    expect(mocks.suspend).toHaveBeenCalledWith("member-1");
    expect(mocks.issue).not.toHaveBeenCalled();
  });
});

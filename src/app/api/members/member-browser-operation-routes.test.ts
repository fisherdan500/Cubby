import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  issueMemberBrowserOperation: vi.fn(),
  submitMemberBrowserOperation: vi.fn(),
  updateMemberRole: vi.fn(),
  removeMember: vi.fn(),
  suspendMember: vi.fn(),
  restoreMember: vi.fn(),
  browserOperationFailureResult: vi.fn()
}));

vi.mock("@/server/services/invites", () => ({
  issueMemberBrowserOperation: mocks.issueMemberBrowserOperation,
  submitMemberBrowserOperation: mocks.submitMemberBrowserOperation,
  updateMemberRole: mocks.updateMemberRole,
  removeMember: mocks.removeMember,
  suspendMember: mocks.suspendMember,
  restoreMember: mocks.restoreMember
}));
vi.mock("@/server/services/browser-operations", () => ({ browserOperationFailureResult: mocks.browserOperationFailureResult }));

import { DELETE, PATCH } from "@/app/api/members/[id]/route";
import { POST as suspend } from "@/app/api/members/[id]/suspend/route";
import { POST as restore } from "@/app/api/members/[id]/restore/route";

const operationId = "bmo_0123456789abcdefghjkmnpqrs";
const memberId = "member-1";

type Invocation = (request: Request) => Promise<Response>;

const actions: Array<{ name: string; operation: "role.update" | "remove" | "suspend" | "restore"; invoke: Invocation; payload: Record<string, unknown> }> = [
  {
    name: "role update",
    operation: "role.update",
    payload: { role: "caretaker" },
    invoke: (request) => PATCH(request, { params: { id: memberId } })
  },
  {
    name: "remove",
    operation: "remove",
    payload: {},
    invoke: (request) => DELETE(request, { params: { id: memberId } })
  },
  {
    name: "suspend",
    operation: "suspend",
    payload: {},
    invoke: (request) => suspend(request, { params: Promise.resolve({ id: memberId }) })
  },
  {
    name: "restore",
    operation: "restore",
    payload: {},
    invoke: (request) => restore(request, { params: Promise.resolve({ id: memberId }) })
  }
];

beforeEach(() => vi.resetAllMocks());

describe("member browser-operation routes", () => {
  for (const action of actions) {
    it(`issues a prepared server reservation for ${action.name}`, async () => {
      mocks.issueMemberBrowserOperation.mockResolvedValue({ status: "prepared", operationId });

      const response = await action.invoke(new Request(`http://localhost/api/members/${memberId}?issue=1`, {
        method: action.operation === "role.update" ? "PATCH" : action.operation === "remove" ? "DELETE" : "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(action.payload)
      }));

      expect(response.status).toBe(202);
      expect(await response.json()).toEqual({ ok: true, data: { status: "prepared", operationId } });
      expect(mocks.issueMemberBrowserOperation).toHaveBeenCalledWith(action.operation, { ...action.payload, memberId });
      expect(mocks.submitMemberBrowserOperation).not.toHaveBeenCalled();
    });

    it(`submits the same prepared ID for ${action.name}`, async () => {
      mocks.issueMemberBrowserOperation.mockResolvedValue({ status: "prepared", operationId });
      mocks.submitMemberBrowserOperation.mockResolvedValue({ status: "completed", operationId, outcome: { kind: "member", code: "updated" } });

      const response = await action.invoke(new Request(`http://localhost/api/members/${memberId}`, {
        method: action.operation === "role.update" ? "PATCH" : action.operation === "remove" ? "DELETE" : "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ operationId, ...action.payload })
      }));

      expect(response.status).toBe(200);
      expect(mocks.issueMemberBrowserOperation).toHaveBeenCalledWith(action.operation, { operationId, ...action.payload, memberId });
      expect(mocks.submitMemberBrowserOperation).toHaveBeenCalledWith(action.operation, { operationId, ...action.payload, memberId });
    });
  }
});

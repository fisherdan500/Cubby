import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

globalThis.React = React;

const mocks = vi.hoisted(() => ({
  refresh: vi.fn(),
  refs: [] as Array<{ current: Map<string, unknown> }>
}));

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: mocks.refresh }) }));
vi.mock("@/lib/browser-operation-tab-scope", () => ({ tabScopedBrowserOperationStorageKey: async (_partition: string, key: string) => `${key}:tab:test` }));
vi.mock("react", async () => {
  const actual = await vi.importActual<typeof import("react")>("react");
  return {
    ...actual,
    useRef: <T,>(value: T) => {
      const ref = { current: value };
      mocks.refs.push(ref as { current: Map<string, unknown> });
      return ref;
    },
    useState: <T,>(value: T) => [value, vi.fn()] as const
  };
});

import { MemberAccessManager } from "@/components/settings/member-access-manager";

type ElementNode = { type?: unknown; props?: { children?: unknown; [key: string]: unknown } };

const members = [
  { id: "owner", name: "Owner", email: "owner@example.com", role: "owner" as const, disabledAt: null },
  { id: "member-1", name: "Jordan", email: "jordan@example.com", role: "parent" as const, disabledAt: null }
];
const invites = [{ id: "invite-1", email: "invitee@example.com", role: "parent" as const, expiresAt: "2026-08-20T00:00:00.000Z" }];

function walk(value: unknown): ElementNode[] {
  if (Array.isArray(value)) return value.flatMap(walk);
  if (!value || typeof value !== "object") return [];
  const node = value as ElementNode;
  return [node, ...walk(node.props?.children)];
}

function text(value: unknown): string {
  if (Array.isArray(value)) return value.map(text).join("");
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (!value || typeof value !== "object") return "";
  return text((value as ElementNode).props?.children);
}

function mount({
  managerMembers = members,
  managerInvites = invites
}: {
  managerMembers?: Parameters<typeof MemberAccessManager>[0]["members"];
  managerInvites?: Parameters<typeof MemberAccessManager>[0]["invites"];
} = {}) {
  mocks.refs.length = 0;
  return MemberAccessManager({ members: managerMembers, invites: managerInvites, viewerRole: "owner", timeZone: "UTC" });
}

function form(tree: unknown, predicate: (candidate: ElementNode) => boolean) {
  const node = walk(tree).find((candidate) => candidate.type === "form" && typeof candidate.props?.onSubmit === "function" && predicate(candidate));
  if (!node) throw new Error("missing form");
  return node;
}

function submitForm(tree: unknown, predicate: (candidate: ElementNode) => boolean, values: Record<string, string>) {
  const target = form(tree, predicate);
  const original = globalThis.FormData;
  Object.defineProperty(globalThis, "FormData", { configurable: true, value: class { get(name: string) { return values[name] ?? null; } } });
  (target.props?.onSubmit as (event: { preventDefault: () => void; currentTarget: unknown }) => void)({ preventDefault: () => {}, currentTarget: {} });
  Object.defineProperty(globalThis, "FormData", { configurable: true, value: original });
}

function control(tree: unknown, label: string) {
  const node = walk(tree).find((candidate) => typeof candidate.props?.onClick === "function" && text(candidate.props?.children).includes(label));
  if (!node) throw new Error(`missing control ${label}`);
  return node;
}

function response(status: number, body: unknown) {
  return { status, ok: status >= 200 && status < 300, json: async () => body } as Response;
}

let originalSessionStorage: PropertyDescriptor | undefined;
let originalWindow: PropertyDescriptor | undefined;
let originalFetch: typeof fetch;
let storage: Map<string, string>;
let removed: string[];

beforeEach(() => {
  mocks.refresh.mockReset();
  originalSessionStorage = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");
  originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  originalFetch = globalThis.fetch;
  storage = new Map();
  removed = [];
  Object.defineProperty(globalThis, "sessionStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => { removed.push(key); storage.delete(key); }
    }
  });
  Object.defineProperty(globalThis, "window", { configurable: true, value: { confirm: () => true } });
});

afterEach(() => {
  if (originalSessionStorage) Object.defineProperty(globalThis, "sessionStorage", originalSessionStorage);
  else Reflect.deleteProperty(globalThis, "sessionStorage");
  if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
  else Reflect.deleteProperty(globalThis, "window");
  globalThis.fetch = originalFetch;
});

describe("MemberAccessManager browser-operation carrier", () => {
  it("submits a retained prepared reservation with the same ID instead of issuing a replacement", async () => {
    const operationId = "bmo_0123456789abcdefghjkmnpqrs";
    const partition = "partition-a";
    storage.set(`cubby:member-administration-operation:${partition}:member-1:suspend:tab:test`, operationId);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response(200, { ok: true, data: { version: 1, scope: "household", partition } }))
      .mockResolvedValueOnce(response(202, { ok: true, data: { status: "prepared", operationId } }))
      .mockResolvedValueOnce(response(200, { ok: true, data: { status: "completed", operationId, outcome: {} } }));
    globalThis.fetch = fetchMock;

    const tree = mount();
    (control(tree, "Suspend").props?.onClick as () => void)();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));

    expect(fetchMock.mock.calls[2]).toEqual([
      "/api/members/member-1/suspend",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ operationId }) })
    ]);
    expect(removed).toEqual([`cubby:member-administration-operation:${partition}:member-1:suspend:tab:test`]);
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
  });

  it("does not clear or reissue a retained ID after an existence-neutral 404", async () => {
    const operationId = "bmo_0123456789abcdefghjkmnpqrs";
    const partition = "partition-a";
    storage.set(`cubby:member-administration-operation:${partition}:member-1:suspend:tab:test`, operationId);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response(200, { ok: true, data: { version: 1, scope: "household", partition } }))
      .mockResolvedValueOnce(response(404, { ok: false }));
    globalThis.fetch = fetchMock;

    const tree = mount();
    (control(tree, "Suspend").props?.onClick as () => void)();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    expect(removed).toEqual([]);
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("?issue=1"))).toBe(false);
    expect(mocks.refresh).not.toHaveBeenCalled();
  });

  it("clears only after an authorized 410 terminal result before issuing a new reservation", async () => {
    const oldId = "bmo_0123456789abcdefghjkmnpqrs";
    const newId = "bmo_1123456789abcdefghjkmnpqrs";
    const partition = "partition-a";
    const storageKey = `cubby:member-administration-operation:${partition}:member-1:suspend:tab:test`;
    storage.set(storageKey, oldId);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response(200, { ok: true, data: { version: 1, scope: "household", partition } }))
      .mockResolvedValueOnce(response(410, { ok: true, data: { status: "expired", operationId: oldId, code: "operation_result_expired" } }))
      .mockResolvedValueOnce(response(200, { ok: true, data: { status: "open", operationId: newId } }))
      .mockResolvedValueOnce(response(200, { ok: true, data: { status: "completed", operationId: newId, outcome: {} } }));
    globalThis.fetch = fetchMock;

    const tree = mount();
    (control(tree, "Suspend").props?.onClick as () => void)();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4));

    expect(removed).toEqual([storageKey, storageKey]);
    expect(fetchMock.mock.calls[2][0]).toBe("/api/members/member-1/suspend?issue=1");
    expect(fetchMock.mock.calls[3][1]).toEqual(expect.objectContaining({ body: JSON.stringify({ operationId: newId }) }));
  });

  it("uses server-issued prepared reservations and same-ID submit for every manager action", async () => {
    const partition = "partition-a";
    const disabledMembers = [members[0], { ...members[1], disabledAt: "2026-08-20T00:00:00.000Z" }];
    const actions = [
      {
        name: "role update",
        endpoint: "/api/members/member-1",
        method: "PATCH",
        payload: { role: "caretaker" },
        invoke: () => submitForm(mount(), (candidate) => walk(candidate).some((node) => node.props?.name === "role"), { role: "caretaker" })
      },
      {
        name: "suspend",
        endpoint: "/api/members/member-1/suspend",
        method: "POST",
        payload: {},
        invoke: () => (control(mount(), "Suspend").props?.onClick as () => void)()
      },
      {
        name: "restore",
        endpoint: "/api/members/member-1/restore",
        method: "POST",
        payload: {},
        invoke: () => (control(mount({ managerMembers: disabledMembers }), "Restore access").props?.onClick as () => void)()
      },
      {
        name: "remove",
        endpoint: "/api/members/member-1",
        method: "DELETE",
        payload: {},
        invoke: () => (control(mount(), "Remove").props?.onClick as () => void)()
      },
      {
        name: "single invite revoke",
        endpoint: "/api/invites/invite-1/revoke",
        method: "POST",
        payload: {},
        invoke: () => (control(mount(), "Revoke").props?.onClick as () => void)()
      },
      {
        name: "revoke all",
        endpoint: "/api/invites/revoke-all",
        method: "POST",
        payload: { acknowledgement: "I_REVOKE_ALL_PENDING_INVITATIONS" },
        invoke: () => submitForm(mount(), (candidate) => walk(candidate).some((node) => node.props?.name === "acknowledgement"), { acknowledgement: "I_REVOKE_ALL_PENDING_INVITATIONS" })
      }
    ];

    for (const [index, action] of actions.entries()) {
      const operationId = `bmo_${index}123456789abcdefghjkmnpqrs`;
      const fetchMock = vi.fn()
        .mockResolvedValueOnce(response(200, { ok: true, data: { version: 1, scope: "household", partition } }))
        .mockResolvedValueOnce(response(200, { ok: true, data: { status: "open", operationId } }))
        .mockResolvedValueOnce(response(200, { ok: true, data: { status: "completed", operationId, outcome: { revokedCount: 1 } } }));
      globalThis.fetch = fetchMock;

      action.invoke();
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));

      expect(fetchMock.mock.calls[1]).toEqual([
        `${action.endpoint}?issue=1`,
        expect.objectContaining({ method: action.method, body: JSON.stringify(action.payload) })
      ]);
      expect(fetchMock.mock.calls[2]).toEqual([
        action.endpoint,
        expect.objectContaining({ method: action.method, body: JSON.stringify({ operationId, ...action.payload }) })
      ]);
    }
  });

  it("does not reuse an in-memory administration operation after the partition changes", async () => {
    const operationIdA = "bmo_0123456789abcdefghjkmnpqrs";
    const operationIdB = "bmo_1123456789abcdefghjkmnpqrs";
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response(200, { ok: true, data: { version: 1, scope: "household", partition: "household-a" } }))
      .mockResolvedValueOnce(response(200, { ok: true, data: { status: "open", operationId: operationIdA } }))
      .mockResolvedValueOnce(response(202, { ok: true, data: { status: "pending", operationId: operationIdA } }))
      .mockResolvedValueOnce(response(200, { ok: true, data: { version: 1, scope: "household", partition: "household-b" } }))
      .mockResolvedValueOnce(response(200, { ok: true, data: { status: "open", operationId: operationIdB } }))
      .mockResolvedValueOnce(response(200, { ok: true, data: { status: "completed", operationId: operationIdB, outcome: {} } }));
    globalThis.fetch = fetchMock;
    const tree = mount();

    (control(tree, "Suspend").props?.onClick as () => void)();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    (control(tree, "Suspend").props?.onClick as () => void)();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(6));

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "/api/browser-operations/partition",
      "/api/members/member-1/suspend?issue=1",
      "/api/members/member-1/suspend",
      "/api/browser-operations/partition",
      "/api/members/member-1/suspend?issue=1",
      "/api/members/member-1/suspend"
    ]);
    expect(JSON.parse(String(fetchMock.mock.calls[5][1]?.body))).toEqual({ operationId: operationIdB });
  });
});

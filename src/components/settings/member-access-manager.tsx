"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { RotateCcw, ShieldCheck, Trash2, UserRoundX } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  assignableHouseholdRoles,
  canAssignHouseholdRole,
  canManageHouseholdRole,
  householdRoleDetails,
  type HouseholdRoleName
} from "@/domain/roles";
import { isAuthorizedBrowserOperation410 } from "@/lib/browser-operation-terminal";
import { tabScopedBrowserOperationStorageKey } from "@/lib/browser-operation-tab-scope";
import { formatInstantDate } from "@/lib/timezone";

type MemberRow = {
  id: string;
  name: string;
  email: string;
  role: HouseholdRoleName;
  disabledAt: string | null;
};

type InviteRow = {
  id: string;
  email: string;
  role: HouseholdRoleName;
  expiresAt: string;
};

type Partition = { version: 1; scope: "household"; partition: string };
type InMemoryOperation = { partition: string; operationId: string };

async function householdPartition(): Promise<Partition> {
  const response = await fetch("/api/browser-operations/partition", { cache: "no-store" });
  const body = await response.json().catch(() => null) as { ok?: boolean; data?: Partition } | null;
  if (!response.ok || !body?.ok || !body.data || body.data.scope !== "household") throw new Error("operation_partition_unavailable");
  return body.data;
}

function memberAdministrationStorageKey(partition: string, key: string) {
  return `cubby:member-administration-operation:${partition}:${key}`;
}

const BULK_REVOKE_ACKNOWLEDGEMENT = "I_REVOKE_ALL_PENDING_INVITATIONS";

export function MemberAccessManager({
  members,
  invites,
  viewerRole,
  timeZone
}: {
  members: MemberRow[];
  invites: InviteRow[];
  viewerRole: HouseholdRoleName;
  timeZone: string;
}) {
  const router = useRouter();
  const [message, setMessage] = useState("");
  const [busyId, setBusyId] = useState("");
  const memberOperationIds = useRef(new Map<string, InMemoryOperation>());
  const inviteOperationIds = useRef(new Map<string, InMemoryOperation>());

  function operationFor(storageKey: string, key: string, partition: string, memory: Map<string, InMemoryOperation>) {
    const remembered = memory.get(key);
    if (remembered && remembered.partition !== partition) memory.delete(key);
    let operationId = remembered?.partition === partition ? remembered.operationId : undefined;
    if (!operationId) {
      try {
        operationId = sessionStorage.getItem(storageKey) ?? undefined;
      } catch {
        // Storage failure falls back to this mounted component's memory.
      }
    }
    return { operationId, retained: Boolean(operationId) };
  }

  function clearOperation(storageKey: string, key: string, memory: Map<string, InMemoryOperation>) {
    memory.delete(key);
    try {
      sessionStorage.removeItem(storageKey);
    } catch {
      // Storage failure must not affect the terminal server outcome.
    }
  }

  async function performOperation({
    key,
    memory,
    endpoint,
    method,
    payload
  }: {
    key: string;
    memory: Map<string, InMemoryOperation>;
    endpoint: string;
    method: "POST" | "PATCH" | "DELETE";
    payload?: Record<string, unknown>;
  }) {
    try {
      const { partition } = await householdPartition();
      const storageKey = await tabScopedBrowserOperationStorageKey(partition, memberAdministrationStorageKey(partition, key));
      let { operationId, retained } = operationFor(storageKey, key, partition, memory);
      if (retained) {
        const response = await fetch(`/api/browser-operations/${operationId}`, { cache: "no-store" });
        const body = await response.json().catch(() => null) as { ok?: boolean; data?: { status?: string; outcome?: Record<string, unknown> } } | null;
        const status = body?.ok ? body.data?.status : undefined;
        if (isAuthorizedBrowserOperation410(response.status, body, operationId!)) {
          clearOperation(storageKey, key, memory);
          ({ operationId } = operationFor(storageKey, key, partition, memory));
          retained = false;
        } else if (status === "completed") {
          clearOperation(storageKey, key, memory);
          return body?.data;
        } else if (status === "prepared") {
          // The server-issued reservation is authorized for same-ID submission below.
        } else if (status === "pending") {
          setMessage("This administration request is still in progress. Reconcile it before trying again.");
          return null;
        } else if (status === "stale" || status === "rejected") {
          setMessage("This administration request is no longer current. Refresh before trying again.");
          return null;
        } else {
          setMessage("Reconcile this administration request before trying again.");
          return null;
        }
      }

      if (!operationId) {
        const issueResponse = await fetch(`${endpoint}?issue=1`, {
          method, headers: { "content-type": "application/json" }, body: JSON.stringify(payload ?? {})
        });
        const issueBody = await issueResponse.json().catch(() => null) as { ok?: boolean; data?: { operationId?: string; status?: string } } | null;
        if (!issueResponse.ok || !issueBody?.ok || !issueBody.data?.operationId || (issueBody.data.status !== "open" && issueBody.data.status !== "prepared")) {
          throw new Error("member_operation_issue_unavailable");
        }
        operationId = issueBody.data.operationId;
        memory.set(key, { partition, operationId });
        sessionStorage.setItem(storageKey, operationId);
      }
      const response = await fetch(endpoint, {
        method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ operationId, ...payload })
      });
      const body = await response.json().catch(() => null) as {
        ok?: boolean;
        data?: { status?: string; outcome?: Record<string, unknown> };
        error?: { message?: string };
      } | null;
      const status = body?.ok ? body.data?.status : undefined;
      if (isAuthorizedBrowserOperation410(response.status, body, operationId!)) {
        clearOperation(storageKey, key, memory);
        setMessage("This administration request expired. Try again to open a new request.");
        return null;
      }
      if (status === "completed") {
        clearOperation(storageKey, key, memory);
        return body?.data;
      }
      if (status === "pending") {
        setMessage("This administration request is still in progress. Reconcile it before trying again.");
        return null;
      }
      if (status === "stale" || status === "rejected") {
        setMessage("This administration request is no longer current. Refresh before trying again.");
        return null;
      }
      setMessage(body?.error?.message ?? "Reconcile this administration request before trying again.");
      return null;
    } catch {
      setMessage("Reconcile this administration request before trying again.");
      return null;
    }
  }

  async function updateRole(memberId: string, formData: FormData) {
    setMessage("");
    setBusyId(memberId);
    const result = await performOperation({
      key: `${memberId}:role.update`,
      memory: memberOperationIds.current,
      endpoint: `/api/members/${memberId}`,
      method: "PATCH",
      payload: { role: formData.get("role") }
    });
    setBusyId("");
    if (!result) return;
    router.refresh();
  }

  async function updateStatus(member: MemberRow) {
    const suspending = !member.disabledAt;
    const action = suspending ? "suspend" : "restore";
    if (suspending && !window.confirm(`Suspend ${member.name}'s access and sign them out?`)) return;
    setMessage("");
    setBusyId(member.id);
    const result = await performOperation({
      key: `${member.id}:${action}`,
      memory: memberOperationIds.current,
      endpoint: `/api/members/${member.id}/${action}`,
      method: "POST"
    });
    setBusyId("");
    if (!result) return;
    router.refresh();
  }

  async function remove(member: MemberRow) {
    if (!window.confirm(`Remove ${member.name} from this household?`)) return;
    setMessage("");
    setBusyId(member.id);
    const result = await performOperation({
      key: `${member.id}:remove`,
      memory: memberOperationIds.current,
      endpoint: `/api/members/${member.id}`,
      method: "DELETE"
    });
    setBusyId("");
    if (!result) return;
    router.refresh();
  }

  async function revoke(invite: InviteRow) {
    setMessage("");
    setBusyId(invite.id);
    const result = await performOperation({
      key: `revoke:${invite.id}`,
      memory: inviteOperationIds.current,
      endpoint: `/api/invites/${invite.id}/revoke`,
      method: "POST"
    });
    setBusyId("");
    if (!result) return;
    router.refresh();
  }

  async function revokeAll(formData: FormData) {
    setMessage("");
    setBusyId("revoke-all");
    const result = await performOperation({
      key: "revoke-all",
      memory: inviteOperationIds.current,
      endpoint: "/api/invites/revoke-all",
      method: "POST",
      payload: { acknowledgement: formData.get("acknowledgement") }
    });
    setBusyId("");
    if (!result) return;
    const revokedCount = typeof result.outcome?.revokedCount === "number" ? result.outcome.revokedCount : 0;
    setMessage(`Revoked ${revokedCount} pending invitation${revokedCount === 1 ? "" : "s"}.`);
    router.refresh();
  }

  return (
    <div className="space-y-5">
      {message ? <p role="alert" className="rounded-md bg-danger/10 p-3 text-sm font-semibold text-danger">{message}</p> : null}

      <section className="space-y-3">
        <h2 className="text-lg font-bold">People</h2>
        {members.map((member) => {
          const canManage = canManageHouseholdRole(viewerRole, member.role);
          const availableRoles = assignableHouseholdRoles.filter((role) => canAssignHouseholdRole(viewerRole, role));
          return (
            <div
              key={member.id}
              className={`rounded-lg border p-3 ${member.disabledAt ? "border-danger/40 bg-danger/5" : "border-border bg-muted/60"}`}
            >
              <div className="flex min-w-0 items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <p className="truncate font-semibold">{member.name}</p>
                  <p className="break-all text-sm text-muted-foreground">{member.email}</p>
                </div>
                <div className="flex shrink-0 flex-wrap justify-end gap-1.5">
                  <span className="rounded-full bg-primary/15 px-2.5 py-1 text-xs font-bold text-primary">
                    {householdRoleDetails[member.role].label}
                  </span>
                  <span className={`rounded-full px-2.5 py-1 text-xs font-bold ${member.disabledAt ? "bg-danger/15 text-danger" : "bg-success/15 text-success"}`}>
                    {member.disabledAt ? "Suspended" : "Active"}
                  </span>
                </div>
              </div>
              <p className="mt-2 text-xs text-muted-foreground">{householdRoleDetails[member.role].description}</p>
              {member.disabledAt ? (
                <p className="mt-2 text-xs font-semibold text-danger">
                  Access suspended {formatInstantDate(member.disabledAt, timeZone)}. Their role and history are preserved.
                </p>
              ) : null}

              {canManage ? (
                <div className="mt-3 flex flex-wrap gap-2">
                  {member.disabledAt ? (
                    <p className="self-center text-xs font-semibold text-muted-foreground">Restore access before changing this role.</p>
                  ) : (
                    <form
                      onSubmit={(event) => {
                        event.preventDefault();
                        void updateRole(member.id, new FormData(event.currentTarget));
                      }}
                      className="flex min-w-0 flex-1 basis-64 gap-2"
                    >
                      <select
                        name="role"
                        defaultValue={member.role}
                        className="min-h-11 min-w-0 flex-1 rounded-lg border border-control bg-card px-3 py-2 text-sm"
                        aria-label={`Role for ${member.name}`}
                      >
                        {availableRoles.map((role) => (
                          <option key={role} value={role}>{householdRoleDetails[role].label}</option>
                        ))}
                      </select>
                      <Button type="submit" variant="secondary" disabled={busyId === member.id}>Save</Button>
                    </form>
                  )}
                  <Button
                    type="button"
                    variant={member.disabledAt ? "secondary" : "danger"}
                    disabled={busyId === member.id}
                    onClick={() => void updateStatus(member)}
                  >
                    {member.disabledAt ? <RotateCcw className="h-4 w-4" /> : <UserRoundX className="h-4 w-4" />}
                    {member.disabledAt ? "Restore access" : "Suspend"}
                  </Button>
                  {!member.disabledAt ? (
                    <Button type="button" variant="danger" disabled={busyId === member.id} onClick={() => void remove(member)}>
                      <Trash2 className="h-4 w-4" />
                      Remove
                    </Button>
                  ) : null}
                </div>
              ) : (
                <div className="mt-3 flex items-center gap-2 text-xs font-semibold text-muted-foreground">
                  <ShieldCheck className="h-4 w-4" />
                  {member.role === "owner" ? "The household owner is protected." : "Only the owner can change this access."}
                </div>
              )}
            </div>
          );
        })}
      </section>

      <section className="space-y-3 border-t border-border pt-5">
        <h2 className="text-lg font-bold">Pending invites</h2>
        {invites.length === 0 ? <p className="text-sm text-muted-foreground">No pending invites.</p> : null}
        {invites.map((invite) => {
          const canRevoke = canManageHouseholdRole(viewerRole, invite.role);
          return (
            <div key={invite.id} className="flex flex-col gap-3 rounded-lg border border-border bg-muted/60 p-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <p className="truncate font-semibold">{invite.email}</p>
                <p className="text-sm text-muted-foreground">
                  {householdRoleDetails[invite.role].label} - expires {formatInstantDate(invite.expiresAt, timeZone)}
                </p>
              </div>
              {canRevoke ? (
                <Button type="button" variant="secondary" disabled={busyId === invite.id} onClick={() => void revoke(invite)}>
                  <Trash2 className="h-4 w-4" />
                  Revoke
                </Button>
              ) : (
                <p className="text-xs font-semibold text-muted-foreground">Owner controlled</p>
              )}
            </div>
          );
        })}
        {viewerRole === "owner" && invites.length > 0 ? (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void revokeAll(new FormData(event.currentTarget));
            }}
            className="space-y-2 rounded-lg border border-danger/40 bg-danger/5 p-3"
          >
            <p className="text-sm font-bold text-danger">Emergency revoke all pending invitations</p>
            <p className="text-xs text-muted-foreground">
              This requires a recent sign-in. Type <span className="font-mono font-semibold">{BULK_REVOKE_ACKNOWLEDGEMENT}</span> exactly.
            </p>
            <Input
              name="acknowledgement"
              aria-label="Bulk invitation revocation acknowledgement"
              autoComplete="off"
              required
            />
            <Button type="submit" variant="danger" disabled={busyId === "revoke-all"}>
              Revoke all pending invitations
            </Button>
          </form>
        ) : null}
      </section>
    </div>
  );
}

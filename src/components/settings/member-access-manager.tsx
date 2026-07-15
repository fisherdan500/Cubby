"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { RotateCcw, ShieldCheck, Trash2, UserRoundX } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  assignableHouseholdRoles,
  canAssignHouseholdRole,
  canManageHouseholdRole,
  householdRoleDetails,
  type HouseholdRoleName
} from "@/domain/roles";

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

export function MemberAccessManager({
  members,
  invites,
  viewerRole
}: {
  members: MemberRow[];
  invites: InviteRow[];
  viewerRole: HouseholdRoleName;
}) {
  const router = useRouter();
  const [message, setMessage] = useState("");
  const [busyId, setBusyId] = useState("");

  async function updateRole(memberId: string, formData: FormData) {
    setMessage("");
    setBusyId(memberId);
    const response = await fetch(`/api/members/${memberId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ role: formData.get("role") })
    });
    const result = await response.json();
    setBusyId("");
    if (!result.ok) {
      setMessage(result.error.message);
      return;
    }
    router.refresh();
  }

  async function updateStatus(member: MemberRow) {
    const suspending = !member.disabledAt;
    if (suspending && !window.confirm(`Suspend ${member.name}'s access and sign them out?`)) return;
    setMessage("");
    setBusyId(member.id);
    const response = await fetch(`/api/members/${member.id}/${suspending ? "suspend" : "restore"}`, {
      method: "POST"
    });
    const result = await response.json();
    setBusyId("");
    if (!result.ok) {
      setMessage(result.error.message);
      return;
    }
    router.refresh();
  }

  async function remove(member: MemberRow) {
    if (!window.confirm(`Remove ${member.name} from this household?`)) return;
    setMessage("");
    setBusyId(member.id);
    const response = await fetch(`/api/members/${member.id}`, { method: "DELETE" });
    const result = await response.json();
    setBusyId("");
    if (!result.ok) {
      setMessage(result.error.message);
      return;
    }
    router.refresh();
  }

  async function revoke(invite: InviteRow) {
    setMessage("");
    setBusyId(invite.id);
    const response = await fetch(`/api/invites/${invite.id}/revoke`, { method: "POST" });
    const result = await response.json();
    setBusyId("");
    if (!result.ok) {
      setMessage(result.error.message);
      return;
    }
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
                  Access suspended {new Date(member.disabledAt).toLocaleDateString()}. Their role and history are preserved.
                </p>
              ) : null}

              {canManage ? (
                <div className="mt-3 grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto_auto]">
                  {member.disabledAt ? (
                    <p className="self-center text-xs font-semibold text-muted-foreground">Restore access before changing this role.</p>
                  ) : (
                    <form
                      onSubmit={(event) => {
                        event.preventDefault();
                        void updateRole(member.id, new FormData(event.currentTarget));
                      }}
                      className="flex min-w-0 gap-2"
                    >
                      <select
                        name="role"
                        defaultValue={member.role}
                        className="min-h-11 min-w-0 flex-1 rounded-lg border border-border bg-card px-3 py-2 text-sm"
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
                  {householdRoleDetails[invite.role].label} - expires {new Date(invite.expiresAt).toLocaleDateString()}
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
      </section>
    </div>
  );
}

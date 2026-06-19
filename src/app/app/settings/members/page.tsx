import { AppShell } from "@/components/app-shell";
import { InviteForm } from "@/components/forms/invite-form";
import { Card } from "@/components/ui/card";
import { requireUserPage } from "@/server/auth/session";
import { listMembersAndInvites } from "@/server/services/invites";

export default async function MembersPage() {
  const user = await requireUserPage();
  const household = await listMembersAndInvites();

  return (
    <AppShell title="Members" userName={user.name}>
      <div className="grid gap-4 md:grid-cols-[1fr_360px] md:pl-56">
        <section className="space-y-4">
          <Card>
            <h2 className="mb-3 text-lg font-bold">Household</h2>
            <p className="text-sm text-muted-foreground">{household.name}</p>
          </Card>
          <Card className="space-y-3">
            <h2 className="text-lg font-bold">People</h2>
            {household.members.map((member) => (
              <div key={member.id} className="rounded-lg bg-muted p-3">
                <p className="font-semibold">{member.displayName ?? member.user.name}</p>
                <p className="text-sm text-muted-foreground">
                  {member.user.email} · {member.role}
                </p>
              </div>
            ))}
          </Card>
          <Card className="space-y-3">
            <h2 className="text-lg font-bold">Pending invites</h2>
            {household.invites.length === 0 ? <p className="text-sm text-muted-foreground">No pending invites.</p> : null}
            {household.invites.map((invite) => (
              <div key={invite.id} className="rounded-lg bg-muted p-3">
                <p className="font-semibold">{invite.email}</p>
                <p className="text-sm text-muted-foreground">
                  {invite.role} · expires {invite.expiresAt.toLocaleDateString()}
                </p>
              </div>
            ))}
          </Card>
        </section>
        <Card>
          <h2 className="mb-3 text-lg font-bold">Invite caretaker</h2>
          <InviteForm />
        </Card>
      </div>
    </AppShell>
  );
}

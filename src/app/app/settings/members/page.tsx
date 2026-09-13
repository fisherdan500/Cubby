import { AppShell } from "@/components/app-shell";
import { ManualInvitationManager } from "@/components/invitations/manual-invitation-manager";
import { MemberAccessManager } from "@/components/settings/member-access-manager";
import { Card } from "@/components/ui/card";
import { requireSettingsPage } from "@/server/auth/page-access";
import { listMembersAndInvites } from "@/server/services/invites";

export default async function MembersPage() {
  const { user } = await requireSettingsPage("member.manage");
  const household = await listMembersAndInvites();

  return (
    <AppShell title="Members" userName={user.name}>
      <div className="grid min-w-0 gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
        <section className="min-w-0 space-y-4">
          <Card>
            <h2 className="mb-3 text-lg font-bold">Household</h2>
            <p className="text-sm text-muted-foreground">{household.name}</p>
          </Card>
          <Card>
            <MemberAccessManager
              viewerRole={household.viewerRole}
              members={household.members.map((member) => ({
                id: member.id,
                name: member.displayName ?? member.user.name,
                email: member.user.email,
                role: member.role,
                disabledAt: member.disabledAt?.toISOString() ?? null
              }))}
              invites={[]}
            />
          </Card>
        </section>
        <Card>
          <ManualInvitationManager
            canInviteAdmin={household.viewerRole === "owner"}
            isOwner={household.viewerRole === "owner"}
            invites={household.invites.map((invite) => ({
              id: invite.id,
              email: invite.email,
              role: invite.role as "admin" | "parent" | "caretaker" | "read_only",
              expiresAt: invite.expiresAt.toISOString()
            }))}
          />
        </Card>
      </div>
    </AppShell>
  );
}

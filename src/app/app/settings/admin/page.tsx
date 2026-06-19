import { AppShell } from "@/components/app-shell";
import { RegistrationSettingsForm } from "@/components/settings/registration-settings-form";
import { Card } from "@/components/ui/card";
import { requireUserPage } from "@/server/auth/session";
import { getHouseholdSettings, getAppRegistrationPolicy } from "@/server/services/registration";

export default async function AdminSettingsPage() {
  const user = await requireUserPage();
  const [settings, policy] = await Promise.all([getHouseholdSettings(), getAppRegistrationPolicy()]);

  return (
    <AppShell title="Admin Settings" userName={user.name}>
      <div className="grid gap-4 xl:grid-cols-[1fr_360px]">
        <Card>
          <h2 className="mb-3 text-lg font-black">Registration policy</h2>
          <RegistrationSettingsForm
            allowPublicRegistration={settings.allowPublicRegistration}
            allowNewHouseholdCreation={settings.allowNewHouseholdCreation}
          />
        </Card>
        <Card className="space-y-3">
          <h2 className="text-lg font-black">Current state</h2>
          <State label="Owner exists" value={policy.hasOwner ? "Yes" : "No"} />
          <State label="First owner allowed" value={policy.firstOwnerAllowed ? "Yes" : "No"} />
          <State label="Public registration" value={policy.publicRegistrationAllowed ? "Open" : "Invite-only"} />
          <State label="New households" value={policy.newHouseholdCreationAllowed ? "Allowed" : "Blocked"} />
        </Card>
      </div>
    </AppShell>
  );
}

function State({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between rounded-md bg-muted p-3">
      <p className="text-sm font-bold text-muted-foreground">{label}</p>
      <p className="font-black">{value}</p>
    </div>
  );
}

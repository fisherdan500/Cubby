import { AppShell } from "@/components/app-shell";
import { NotificationPreferenceForm } from "@/components/settings/notification-preference-form";
import { Card } from "@/components/ui/card";
import { requireSettingsPage } from "@/server/auth/page-access";
import { getHouseholdHome } from "@/server/services/households";
import { getOwnNotificationPreference } from "@/server/services/notification-preferences";

export default async function NotificationsSettingsPage() {
  const { user } = await requireSettingsPage("notification.manage");
  const [home, preference] = await Promise.all([getHouseholdHome(), getOwnNotificationPreference()]);
  const babies = home?.household.babies.map((baby) => ({ id: baby.id, name: baby.name })) ?? [];

  return (
    <AppShell title="Notifications" userName={user.name}>
      <div className="grid gap-4 xl:grid-cols-[420px_1fr]">
        <Card>
          <h2 className="mb-3 text-lg font-black">Preference</h2>
          <NotificationPreferenceForm babies={babies} state={preference.state} />
        </Card>
        <Card className="space-y-3">
          <h2 className="text-lg font-black">Current document</h2>
          {preference.document ? <p className="text-sm text-muted-foreground">Revision {preference.document.revision}. External delivery is {preference.document.externalDeliveryEnabled ? "enabled" : "off"}.</p> : <p className="text-sm text-muted-foreground">No document is saved. External delivery is off.</p>}
        </Card>
      </div>
    </AppShell>
  );
}

import { AppShell } from "@/components/app-shell";
import { NotificationPreferenceForm } from "@/components/settings/notification-preference-form";
import { Card } from "@/components/ui/card";
import { requireUserPage } from "@/server/auth/session";
import { getHouseholdHome } from "@/server/services/households";
import { listNotificationPreferences } from "@/server/services/integrations";

export default async function NotificationsSettingsPage() {
  const user = await requireUserPage();
  const [home, preferences] = await Promise.all([getHouseholdHome(user.id), listNotificationPreferences()]);
  const babies = home?.household.babies.map((baby) => ({ id: baby.id, name: baby.name })) ?? [];

  return (
    <AppShell title="Notifications" userName={user.name}>
      <div className="grid gap-4 xl:grid-cols-[420px_1fr]">
        <Card>
          <h2 className="mb-3 text-lg font-black">Preference</h2>
          <NotificationPreferenceForm babies={babies} />
        </Card>
        <Card className="space-y-3">
          <h2 className="text-lg font-black">Saved preferences</h2>
          {preferences.length ? null : <p className="text-sm text-muted-foreground">No notification preferences yet.</p>}
          {preferences.map((preference) => (
            <div key={preference.id} className="rounded-md bg-muted p-3">
              <p className="font-black">{preference.baby?.name ?? "All babies"}</p>
              <p className="text-sm text-muted-foreground">
                Timer overdue: {preference.timerOverdue ? "on" : "off"} - Activity created:{" "}
                {preference.activityCreated ? "on" : "off"} - Reminders: {preference.reminders ? "on" : "off"}
              </p>
            </div>
          ))}
        </Card>
      </div>
    </AppShell>
  );
}

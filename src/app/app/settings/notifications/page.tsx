import { AppShell } from "@/components/app-shell";
import { NotificationPreferenceForm, type SavedPreference } from "@/components/settings/notification-preference-form";
import { NotificationSubscribeCard } from "@/components/settings/notification-subscribe-card";
import { Card } from "@/components/ui/card";
import { requireUserPage } from "@/server/auth/session";
import { getHouseholdHome } from "@/server/services/households";
import { getOwnNotificationPreference } from "@/server/services/notification-preferences";

const CATEGORY_LABELS: Record<string, string> = {
  timer_overdue: "Timer overdue",
  activity_created: "Activity created",
  reminder_due: "Reminders",
  moments: "Moments"
};

export default async function NotificationsSettingsPage() {
  const user = await requireUserPage();
  const [home, preference] = await Promise.all([getHouseholdHome(), getOwnNotificationPreference()]);
  const babies = home?.household.babies.map((baby) => ({ id: baby.id, name: baby.name })) ?? [];

  // Saving replaces the whole preference, so the form has to show what is already saved: otherwise
  // changing one setting silently clears every other one.
  const document = preference.document;
  const saved: SavedPreference | null = document
    ? {
        externalDeliveryEnabled: document.externalDeliveryEnabled,
        categories: document.categories,
        channels: document.channels,
        babyScope: document.babyScope === "selected" ? "selected" : "all",
        selectedBabyIds: document.selectedBabyIds,
        quietHoursStart: document.quietHoursStart,
        quietHoursEnd: document.quietHoursEnd,
        interruptionLevel: document.interruptionLevel
      }
    : null;

  const chosenCategories = (saved?.categories ?? []).map((value) => CATEGORY_LABELS[value] ?? value);
  // Push needs all three together, and each of them looks fine on its own - so say which one is
  // missing rather than leaving someone to work it out from three separate controls.
  const missing = saved
    ? [
        saved.externalDeliveryEnabled ? null : "external delivery",
        saved.categories.length > 0 ? null : "at least one category",
        saved.channels.includes("browser_push") ? null : "the browser push channel"
      ].filter((value): value is string => value !== null)
    : [];

  return (
    <AppShell title="Notifications" userName={user.name} parent={{ href: "/app/settings", label: "Settings" }}>
      <div className="grid gap-4 xl:grid-cols-[420px_1fr]">
        <Card>
          <h2 className="mb-3 text-lg font-semibold">Preference</h2>
          <NotificationPreferenceForm babies={babies} state={preference.state} saved={saved} />
        </Card>
        <div className="space-y-4">
          {/* Registering this phone is separate from the household preference: a member can be
              opted in and still have no device able to receive anything. */}
          <NotificationSubscribeCard />
          <Card className="space-y-3">
            <h2 className="text-lg font-semibold">What you will be sent</h2>
            {saved ? (
              <>
                <dl className="space-y-1 text-sm text-muted-foreground">
                  <div className="flex gap-2">
                    <dt className="font-medium text-foreground">External delivery</dt>
                    <dd>{saved.externalDeliveryEnabled ? "on" : "off"}</dd>
                  </div>
                  <div className="flex gap-2">
                    <dt className="font-medium text-foreground">Categories</dt>
                    <dd>{chosenCategories.length ? chosenCategories.join(", ") : "none chosen"}</dd>
                  </div>
                  <div className="flex gap-2">
                    <dt className="font-medium text-foreground">Delivered by</dt>
                    <dd>{saved.channels.includes("browser_push") ? "browser push" : "nothing chosen"}</dd>
                  </div>
                  <div className="flex gap-2">
                    <dt className="font-medium text-foreground">Quiet hours</dt>
                    <dd>{saved.quietHoursStart && saved.quietHoursEnd ? `${saved.quietHoursStart} to ${saved.quietHoursEnd}` : "none"}</dd>
                  </div>
                  <div className="flex gap-2">
                    <dt className="font-medium text-foreground">Babies</dt>
                    <dd>{saved.babyScope === "all" ? "all active babies" : `${saved.selectedBabyIds.length} selected`}</dd>
                  </div>
                </dl>
                {missing.length > 0 ? (
                  <p className="rounded-lg bg-muted p-3 text-sm text-muted-foreground" role="status">
                    Nothing will be sent yet: turn on {missing.join(", and ")}.
                  </p>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    Notifications will be sent to any device you have registered below.
                  </p>
                )}
              </>
            ) : (
              <p className="text-sm text-muted-foreground">
                Nothing is saved yet, so nothing is sent. Choose what you want on the left and save.
              </p>
            )}
          </Card>
        </div>
      </div>
    </AppShell>
  );
}

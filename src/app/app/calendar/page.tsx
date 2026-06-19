import Link from "next/link";
import { redirect } from "next/navigation";
import { addMonths, format, subMonths } from "date-fns";
import { AppShell } from "@/components/app-shell";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { activityAccent, activityLabels, type ActivityTypeName } from "@/domain/activity";
import { describeActivity } from "@/lib/activity-format";
import { requireUserPage } from "@/server/auth/session";
import { getCalendar } from "@/server/services/calendar";

export default async function CalendarPage({
  searchParams
}: {
  searchParams: { babyId?: string; month?: string; date?: string };
}) {
  const user = await requireUserPage();
  const calendar = await getCalendar(user.id, searchParams);
  if (!calendar?.home) redirect("/onboarding");
  const monthKey = format(calendar.month, "yyyy-MM");
  const previous = format(subMonths(calendar.month, 1), "yyyy-MM");
  const next = format(addMonths(calendar.month, 1), "yyyy-MM");

  return (
    <AppShell title={`${calendar.baby?.name ?? "Baby"} - Calendar`} userName={user.name}>
      {!calendar.baby ? (
        <Card>Add a baby before viewing the calendar.</Card>
      ) : (
        <div className="grid gap-5 xl:grid-cols-[1fr_380px]">
          <section className="space-y-4">
            <Card>
              <form className="grid gap-3 md:grid-cols-[1fr_auto_auto_auto]">
                <select name="babyId" defaultValue={calendar.baby.id} className="min-h-11 rounded-lg border border-border bg-card px-3">
                  {calendar.home.household.babies.map((baby) => (
                    <option key={baby.id} value={baby.id}>
                      {baby.name}
                    </option>
                  ))}
                </select>
                <input name="month" type="month" defaultValue={monthKey} className="min-h-11 rounded-lg border border-border bg-card px-3" />
                <input name="date" type="date" defaultValue={calendar.selected?.key} className="min-h-11 rounded-lg border border-border bg-card px-3" />
                <Button>Apply</Button>
              </form>
            </Card>
            <Card className="space-y-4">
              <div className="flex items-center justify-between gap-3">
                <Link href={`/app/calendar?babyId=${calendar.baby.id}&month=${previous}`} className="text-sm font-bold text-primary">
                  Previous
                </Link>
                <h2 className="text-xl font-black">{format(calendar.month, "MMMM yyyy")}</h2>
                <Link href={`/app/calendar?babyId=${calendar.baby.id}&month=${next}`} className="text-sm font-bold text-primary">
                  Next
                </Link>
              </div>
              <div className="grid grid-cols-7 gap-2 text-center text-xs font-black text-muted-foreground">
                {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((day) => (
                  <div key={day}>{day}</div>
                ))}
              </div>
              <div className="grid grid-cols-7 gap-2">
                {calendar.days.map((day) => (
                  <Link
                    key={day.key}
                    href={`/app/calendar?babyId=${calendar.baby?.id}&month=${monthKey}&date=${day.key}`}
                    className={`min-h-28 rounded-md border border-border p-2 hover:bg-muted ${
                      day.inMonth ? "bg-background/40" : "bg-muted/40 text-muted-foreground"
                    } ${calendar.selected?.key === day.key ? "ring-2 ring-primary" : ""}`}
                  >
                    <div className="flex items-center justify-between">
                      <span className="text-sm font-black">{day.date.getDate()}</span>
                      {day.total ? <span className="text-xs font-bold text-primary">{day.total}</span> : null}
                    </div>
                    <div className="mt-2 flex flex-wrap gap-1">
                      {Object.entries(day.counts)
                        .slice(0, 6)
                        .map(([type, count]) => (
                          <span key={type} className={`h-2 w-2 rounded-full ${activityAccent[type as ActivityTypeName].split(" ")[0]}`} title={`${activityLabels[type as ActivityTypeName]} ${count}`} />
                        ))}
                    </div>
                  </Link>
                ))}
              </div>
            </Card>
          </section>
          <aside>
            <Card className="space-y-3">
              <h2 className="text-lg font-black">{calendar.selected ? format(calendar.selected.date, "MMM d, yyyy") : "Day detail"}</h2>
              {calendar.selected?.activities.length ? null : <p className="text-sm text-muted-foreground">No activity for this day.</p>}
              {calendar.selected?.activities.map((activity) => {
                const type = activity.type as ActivityTypeName;
                return (
                  <Link key={activity.id} href={`/app/activities/${activity.id}/edit`} className="block rounded-md bg-muted p-3">
                    <div className="flex items-center justify-between gap-3">
                      <p className="font-black">{activityLabels[type]}</p>
                      <p className="text-xs text-muted-foreground">
                        {new Intl.DateTimeFormat("en", { hour: "numeric", minute: "2-digit" }).format(activity.occurredAt)}
                      </p>
                    </div>
                    <p className="mt-1 text-sm text-muted-foreground">{describeActivity(activity)}</p>
                  </Link>
                );
              })}
            </Card>
          </aside>
        </div>
      )}
    </AppShell>
  );
}

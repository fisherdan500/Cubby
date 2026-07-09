import Link from "next/link";
import { redirect } from "next/navigation";
import { Bed, Droplets, Milk, NotebookPen, Pill } from "lucide-react";
import { AppShell } from "@/components/app-shell";
import { PauseTimerButton, ResumeTimerButton, StopTimerButton } from "@/components/actions/activity-actions";
import { Card } from "@/components/ui/card";
import { activityLabels, type ActivityTypeName } from "@/domain/activity";
import { formatDateTime } from "@/lib/activity-format";
import { requireUserPage } from "@/server/auth/session";
import { getHeaderBabySelector } from "@/server/services/baby-selector";
import { getDashboard } from "@/server/services/dashboard";

const nurseryActions: Array<[string, string, React.ElementType]> = [
  ["/app/log/feeding", "Feeding", Milk],
  ["/app/log/diaper", "Diaper", Droplets],
  ["/app/log/sleep", "Sleep", Bed],
  ["/app/log/medicine", "Medicine", Pill],
  ["/app/log/note", "Note", NotebookPen]
];

export default async function NurseryPage({ searchParams }: { searchParams: { babyId?: string } }) {
  const user = await requireUserPage();
  const babySelector = await getHeaderBabySelector(user.id, searchParams.babyId);
  const dashboard = await getDashboard(user.id, { babyId: babySelector?.selectedBabyId ?? searchParams.babyId });
  if (!dashboard?.home) redirect("/onboarding");
  const selectedBabyId = dashboard.baby?.id;

  return (
    <AppShell title="Nursery" userName={user.name} babySelector={babySelector}>
      <div className="space-y-4">
        <section className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          {nurseryActions.map(([href, label, Icon]) => (
            <Link
              key={href}
              href={nurseryActionHref(href, selectedBabyId)}
              className="flex h-32 flex-col items-center justify-center gap-3 rounded-xl bg-primary px-4 py-3 text-lg font-black text-primary-foreground shadow-soft transition hover:opacity-95 sm:h-36"
            >
              <Icon className="h-9 w-9" />
              {label}
            </Link>
          ))}
        </section>

        <Card className="space-y-4 bg-card/80">
          <div>
            <p className="text-xs font-black uppercase tracking-normal text-muted-foreground">Nursery timers</p>
            <h2 className="text-xl font-black">Running timers</h2>
          </div>
          {dashboard.activeTimers.length === 0 ? (
            <p className="text-sm text-muted-foreground">No active timers.</p>
          ) : (
            dashboard.activeTimers.map((timer) => (
              <div key={timer.id} className="space-y-3 rounded-lg border border-border bg-muted/70 p-4">
                <div>
                  <p className="text-2xl font-black">{activityLabels[timer.type as ActivityTypeName]}</p>
                  <p className="text-sm font-semibold text-muted-foreground">
                    {timer.timerState === "paused" ? "Paused" : "Started"} {formatDateTime(timer.startedAt)}
                  </p>
                </div>
                <div className="grid grid-cols-2 gap-2 sm:flex">
                  {timer.timerState === "paused" ? <ResumeTimerButton id={timer.id} /> : <PauseTimerButton id={timer.id} />}
                  <StopTimerButton id={timer.id} />
                </div>
              </div>
            ))
          )}
        </Card>
      </div>
    </AppShell>
  );
}

function nurseryActionHref(href: string, babyId: string | undefined) {
  if (!babyId) return href;
  const returnTo = `/app/nursery?${new URLSearchParams({ babyId }).toString()}`;
  const params = new URLSearchParams({ babyId, returnTo });
  return `${href}?${params.toString()}`;
}

import Link from "next/link";
import { redirect } from "next/navigation";
import { Bed, Droplets, Milk, NotebookPen, Pill } from "lucide-react";
import { AppShell } from "@/components/app-shell";
import { StopTimerButton } from "@/components/actions/activity-actions";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
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
      <div className="space-y-5">
        <section className="grid grid-cols-2 gap-3">
          {nurseryActions.map(([href, label, Icon]) => (
            <Link key={href} href={selectedBabyId ? `${href}?babyId=${selectedBabyId}` : href}>
              <Button className="h-28 w-full flex-col text-lg">
                <Icon className="h-8 w-8" />
                {label}
              </Button>
            </Link>
          ))}
        </section>

        <Card className="space-y-3">
          <h2 className="text-lg font-bold">Running timers</h2>
          {dashboard.activeTimers.length === 0 ? (
            <p className="text-sm text-muted-foreground">No active timers.</p>
          ) : (
            dashboard.activeTimers.map((timer) => (
              <div key={timer.id} className="flex items-center justify-between rounded-lg bg-muted p-3">
                <p className="font-semibold">Started {formatDateTime(timer.startedAt)}</p>
                <StopTimerButton id={timer.id} />
              </div>
            ))
          )}
        </Card>
      </div>
    </AppShell>
  );
}

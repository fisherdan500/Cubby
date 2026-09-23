import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { ActivityArtwork } from "@/components/activity-artwork";
import { PauseTimerButton, ResumeTimerButton, StopTimerButton } from "@/components/actions/activity-actions";
import { ConfirmedActivityDelete } from "@/components/actions/confirmed-activity-delete";
import { TimerDot, TimerElapsed } from "@/components/timer-elapsed";
import { Card } from "@/components/ui/card";
import { activityLabels, type ActivityTypeName } from "@/domain/activity";
import { buildActivityDetailSections } from "@/lib/activity-detail";
import { activityBackLabel, activityEditHref, activityFallbackHref, safeActivityReturnTo } from "@/lib/activity-navigation";
import { activityUnavailableOrThrow } from "@/lib/activity-page-error";
import { env } from "@/lib/env";
import { normalizeTimeZone } from "@/lib/timezone";
import { requireUserPage } from "@/server/auth/session";
import { getActivityView } from "@/server/services/activities";
import { getHouseholdHome } from "@/server/services/households";

export default async function ActivityDetailPage({
  params,
  searchParams
}: {
  params: { id: string };
  searchParams: { returnTo?: string | string[] };
}) {
  const user = await requireUserPage();
  const home = await getHouseholdHome({ includeInactive: true });
  if (!home) redirect("/onboarding");
  const view = await getActivityView(params.id).catch(activityUnavailableOrThrow);
  if (!view) notFound();

  const { activity, canUpdate, canDelete } = view;
  const type = activity.type as ActivityTypeName;
  const returnTo =
    safeActivityReturnTo(searchParams.returnTo) ??
    activityFallbackHref({ babyId: activity.babyId, occurredAt: activity.occurredAt, timeZone: env.APP_TIMEZONE });
  const presentation = buildActivityDetailSections(activity, env.APP_TIMEZONE);
  const actorName = activity.actorMember.displayName || activity.actorMember.user.name;
  const isInactiveBaby = Boolean((activity.baby as { inactiveAt?: Date | null }).inactiveAt);
  // Pause lives here rather than on the dashboard: it is far rarer than stop, and this is the screen
  // with room for it. Stop is here too, so the whole of a timer can be managed from one place.
  const runningTimer = activity.timerState === "running" || activity.timerState === "paused";
  const paused = activity.timerState === "paused";
  const nowMs = Date.now();

  return (
    <AppShell title={activityLabels[type]} userName={user.name} timerBabyId={activity.babyId}>
      {/* Bottom padding keeps the last card clear of the fixed action bar below. */}
      <article className="mx-auto max-w-3xl space-y-4 pb-[calc(5rem+var(--active-timer-bar,0rem))]">
        <Card className="space-y-5 p-5 sm:p-6">
          <header className="flex min-w-0 items-center gap-4">
            <ActivityArtwork type={type} size="xl" />
            <div className="min-w-0">
              <p className="text-xs font-semibold uppercase tracking-normal text-muted-foreground">
                {activity.baby.name}
                {isInactiveBaby ? " - Inactive" : ""}
              </p>
              <h2 className="font-editorial text-2xl font-semibold text-foreground sm:text-3xl">{activityLabels[type]}</h2>
              <p className="mt-1 text-sm font-semibold text-muted-foreground">{formatOccurredAt(activity.occurredAt)}</p>
              <p className="mt-1 text-xs text-muted-foreground">Recorded by {actorName}</p>
            </div>
          </header>
        </Card>

        {runningTimer && canUpdate ? (
          <Card className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="flex items-center gap-2 text-sm font-semibold text-foreground">
                <TimerDot paused={paused} />
                <span>{paused ? "Timer paused" : "Timer running"}</span>
                <TimerElapsed
                  timer={{
                    timerState: activity.timerState,
                    startedAt: activity.startedAt?.toISOString() ?? null,
                    pausedAt: activity.pausedAt?.toISOString() ?? null,
                    pausedSeconds: activity.pausedSeconds
                  }}
                  nowMs={nowMs}
                  className="text-primary"
                />
              </p>
              <div className="flex flex-wrap gap-2">
                {/* Pause and Resume keep you here: you are adjusting a timer, not finishing with it. */}
                {paused ? <ResumeTimerButton id={activity.id} /> : <PauseTimerButton id={activity.id} />}
                <StopTimerButton id={activity.id} returnTo={returnTo} />
              </div>
            </div>
          </Card>
        ) : null}

        {presentation.sections.map((section) => (
          <Card key={section.title} className="space-y-3">
            <h2 className="text-sm font-semibold uppercase tracking-normal text-muted-foreground">{section.title}</h2>
            <dl className="divide-y divide-border">
              {section.rows.map((item) => (
                <div key={item.label} className="grid gap-1 py-3 first:pt-0 last:pb-0 sm:grid-cols-[11rem_1fr] sm:gap-4">
                  <dt className="text-sm font-semibold text-muted-foreground">{item.label}</dt>
                  <dd className="break-words text-sm font-bold text-foreground">{item.value}</dd>
                </div>
              ))}
            </dl>
          </Card>
        ))}

        {presentation.notes ? (
          <Card className="space-y-2">
            <h2 className="text-sm font-semibold uppercase tracking-normal text-muted-foreground">Notes</h2>
            <p className="whitespace-pre-wrap break-words text-sm leading-6 text-foreground">{presentation.notes}</p>
          </Card>
        ) : null}

        {/* Every action lives in one bar FIXED just above the phone's bottom navigation - not sticky,
            which only pinned once an activity was long enough and otherwise left the bar halfway up
            a short one. Fixed means it is in exactly the same spot for every activity and never
            scrolls. On desktop, where there is no bottom navigation, it sits at the bottom of the
            content column clear of the sidebar. Delete is a small icon and still asks to confirm. */}
        <div className="fixed inset-x-0 bottom-[calc(4.75rem+var(--active-timer-bar,0rem))] z-20 px-3 md:bottom-[calc(1rem+var(--active-timer-bar,0rem))] md:left-64 md:px-6">
        <nav
          aria-label="Activity actions"
          className="mx-auto flex max-w-3xl items-center gap-2 rounded-xl border border-border bg-card/95 p-2 shadow-soft backdrop-blur"
        >
          <Link
            replace
            href={returnTo}
            className="inline-flex min-h-11 min-w-0 flex-1 items-center rounded-lg px-3 text-sm font-bold text-primary transition hover:bg-muted"
          >
            <span className="truncate">← {activityBackLabel(returnTo)}</span>
          </Link>
          {canUpdate ? (
            <Link
              replace
              href={activityEditHref(activity.id, returnTo)}
              className="inline-flex min-h-11 shrink-0 items-center justify-center rounded-lg border border-border bg-card px-5 text-sm font-semibold text-foreground transition hover:bg-muted"
            >
              Edit
            </Link>
          ) : null}
          {canDelete ? <ConfirmedActivityDelete id={activity.id} returnTo={returnTo} trigger="icon" /> : null}
        </nav>
        </div>
      </article>
    </AppShell>
  );
}

function formatOccurredAt(value: Date) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: normalizeTimeZone(env.APP_TIMEZONE),
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit"
  }).format(value);
}

import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { ActivityArtwork } from "@/components/activity-artwork";
import { ConfirmedActivityDelete } from "@/components/actions/confirmed-activity-delete";
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
  const home = await getHouseholdHome(user.id);
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

  return (
    <AppShell title={activityLabels[type]} userName={user.name}>
      <article className="mx-auto max-w-3xl space-y-4">
        <nav aria-label="Activity navigation">
          <Link replace href={returnTo} className="inline-flex min-h-11 items-center text-sm font-bold text-primary hover:underline">
            ← {activityBackLabel(returnTo)}
          </Link>
        </nav>

        <Card className="space-y-5 p-5 sm:p-6">
          <header className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
            <div className="flex min-w-0 items-center gap-4">
              <ActivityArtwork type={type} size="xl" />
              <div className="min-w-0">
                <p className="text-xs font-black uppercase tracking-normal text-muted-foreground">{activity.baby.name}</p>
                <h2 className="font-editorial text-2xl font-black text-foreground sm:text-3xl">{activityLabels[type]}</h2>
                <p className="mt-1 text-sm font-semibold text-muted-foreground">{formatOccurredAt(activity.occurredAt)}</p>
                <p className="mt-1 text-xs text-muted-foreground">Recorded by {actorName}</p>
              </div>
            </div>
            {canUpdate ? (
              <Link
                replace
                href={activityEditHref(activity.id, returnTo)}
                className="inline-flex min-h-11 w-full items-center justify-center rounded-lg border border-border bg-card px-4 py-2 text-sm font-semibold text-foreground hover:bg-muted sm:w-auto"
              >
                Edit
              </Link>
            ) : null}
          </header>

        </Card>

        {presentation.sections.map((section) => (
          <Card key={section.title} className="space-y-3">
            <h2 className="text-sm font-black uppercase tracking-normal text-muted-foreground">{section.title}</h2>
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
            <h2 className="text-sm font-black uppercase tracking-normal text-muted-foreground">Notes</h2>
            <p className="whitespace-pre-wrap break-words text-sm leading-6 text-foreground">{presentation.notes}</p>
          </Card>
        ) : null}

        {canDelete ? <ConfirmedActivityDelete id={activity.id} returnTo={returnTo} /> : null}
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

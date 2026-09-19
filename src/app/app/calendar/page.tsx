import Link from "next/link";
import { redirect } from "next/navigation";
import { ChevronLeft, ChevronRight, Clock3, MapPin, PlusCircle, Users, X } from "lucide-react";
import { AppShell } from "@/components/app-shell";
import { CalendarDrawerShell } from "@/components/calendar-drawer-shell";
import { CalendarFocusRestore } from "@/components/calendar-focus-restore";
import { CalendarEventSubmission } from "@/components/calendar-event-submission";
import { ActivityListRow } from "@/components/activity-list-row";
import { Button } from "@/components/ui/button";
import { Input, Select, Textarea } from "@/components/ui/input";
import { activityLabels, activityVisuals, type ActivityTypeName } from "@/domain/activity";
import { parseUnitPreferences } from "@/domain/unit-preferences";
import { calendarEventTextColor, calendarFullBleedClassName } from "@/lib/calendar-layout";
import { requireUserPage } from "@/server/auth/session";
import { getHeaderBabySelector } from "@/server/services/baby-selector";
import { getCalendar } from "@/server/services/calendar";

const weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const eventTypes = ["Appointment", "Birthday", "Reminder", "Checkup", "Visit", "Other"];

export default async function CalendarPage({
  searchParams
}: {
  searchParams: { babyId?: string; month?: string; date?: string; eventId?: string; new?: string; error?: string; opener?: string };
}) {
  const user = await requireUserPage();
  const babySelector = await getHeaderBabySelector(user.id, searchParams.babyId, { includeInactive: true });
  const selectedBabyId = babySelector?.selectedBabyId ?? searchParams.babyId;
  const calendar = await getCalendar(user.id, { ...searchParams, babyId: selectedBabyId });
  if (!calendar?.home) redirect("/onboarding");
  const canAddEvent = !calendar.baby?.inactiveAt;

  return (
    <AppShell title="Calendar" userName={user.name} babySelector={babySelector}>
      {!calendar.baby ? (
        <div className="rounded-lg border border-border bg-card p-4">Add a baby before viewing the calendar.</div>
      ) : (
        <div className="space-y-0">
          {/* The month bar uses the same quiet card surface as the dashboard's day navigator, rather than
              a solid primary band, so the days - not the chrome - carry the colour. */}
          <div className={`${calendarFullBleedClassName} sticky top-16 z-10 -mt-5 md:top-20`}>
            <section className="border-b border-border bg-card/95 backdrop-blur">
              <div className="grid grid-cols-[56px_1fr_56px] items-center px-2 py-1 md:px-6">
                <Link
                  href={calendarHref(calendar.baby.id, calendar.previousMonth)}
                  className="inline-flex h-11 w-11 items-center justify-center rounded-full text-primary hover:bg-muted"
                  aria-label="Previous month"
                >
                  <ChevronLeft className="h-5 w-5" />
                </Link>
                <div className="flex min-w-0 items-center justify-center gap-1">
                  <h2 className="truncate text-lg font-black">{calendar.monthLabel}</h2>
                  {calendar.monthKey !== calendar.todayKey.slice(0, 7) ? (
                    <Link
                      href={calendarHref(calendar.baby.id, calendar.todayKey.slice(0, 7))}
                      className="inline-flex min-h-11 shrink-0 items-center rounded-lg px-2 text-sm font-bold text-primary hover:bg-muted"
                    >
                      Today
                    </Link>
                  ) : null}
                </div>
                <Link
                  href={calendarHref(calendar.baby.id, calendar.nextMonth)}
                  className="inline-flex h-11 w-11 items-center justify-center justify-self-end rounded-full text-primary hover:bg-muted"
                  aria-label="Next month"
                >
                  <ChevronRight className="h-5 w-5" />
                </Link>
              </div>
            </section>
          </div>

          {/* The month fits the screen: no sideways scrolling on a phone. A phone cell is one tap target
              showing the date and a few dots (event colours, then activity tones); the day sheet it
              opens holds the detail. From md up there is room for the event chips themselves. */}
          <div className={calendarFullBleedClassName}>
            <div className="grid grid-cols-7 border-b border-border bg-background py-2 text-center text-xs font-black text-muted-foreground md:text-sm">
              {weekdays.map((day) => (
                <div key={day}>{day}</div>
              ))}
            </div>
            <section aria-label={`${calendar.monthLabel} days`} className="grid grid-cols-7 border-l border-border">
                {calendar.days.map((day) => {
                  const activityEntries = Object.entries(day.counts);
                  const markers = [
                    ...day.events.map((event) => ({ key: `event:${event.id}`, style: { backgroundColor: event.color ?? "hsl(var(--primary))" }, className: "" })),
                    ...activityEntries.map(([type]) => ({
                      key: `activity:${type}`,
                      style: undefined,
                      className: activityVisuals[type as ActivityTypeName]?.toneClass ?? "bg-primary"
                    }))
                  ];
                  const itemCount = day.events.length + day.total;
                  return (
                    <div
                      key={day.key}
                      className={`min-w-0 border-b border-r border-border p-0.5 md:min-h-40 md:p-2 ${
                        day.inMonth ? "bg-card/70" : "bg-background/50 text-muted-foreground"
                      } ${calendar.selected?.key === day.key ? "ring-2 ring-inset ring-primary" : ""}`}
                    >
                      <Link
                        href={calendarHref(calendar.baby.id, calendar.monthKey, { date: day.key, opener: `day:${day.key}` })}
                        aria-label={`${formatDateKeyLabel(day.key)}${itemCount ? `, ${itemCount} ${itemCount === 1 ? "item" : "items"}` : ""}`}
                        className="flex min-h-14 w-full flex-col items-center justify-start gap-1 rounded-lg pt-1 hover:bg-muted md:inline-flex md:h-11 md:min-h-0 md:w-auto md:min-w-11 md:justify-center md:pt-0"
                        data-calendar-day={day.key}
                      >
                        <span
                          className={`inline-flex h-8 min-w-8 items-center justify-center rounded-full px-1.5 text-sm font-black ${
                            day.key === calendar.todayKey ? "bg-primary text-primary-foreground" : ""
                          }`}
                        >
                          {day.dayNumber}
                        </span>
                        {markers.length ? (
                          <span aria-hidden="true" className="flex max-w-full flex-wrap justify-center gap-0.5 md:hidden">
                            {markers.slice(0, 4).map((marker) => (
                              <span key={marker.key} className={`h-1.5 w-1.5 rounded-full ${marker.className}`} style={marker.style} />
                            ))}
                          </span>
                        ) : null}
                      </Link>

                      <div className="mt-2 hidden space-y-1 md:block">
                        {day.events.slice(0, 4).map((event) => (
                          <Link
                            key={event.id}
                            href={calendarHref(calendar.baby.id, calendar.monthKey, {
                              date: day.key,
                              eventId: event.id,
                              opener: `event:${event.id}`
                            })}
                            data-calendar-event={event.id}
                            className="block min-h-11 truncate rounded px-2 py-3 text-xs font-black shadow-sm"
                            style={{
                              backgroundColor: event.color ?? "hsl(var(--primary))",
                              color: calendarEventTextColor(event.color)
                            }}
                            title={event.title}
                          >
                            {event.title}
                          </Link>
                        ))}
                        {day.events.length > 4 ? (
                          <Link
                            href={calendarHref(calendar.baby.id, calendar.monthKey, { date: day.key, opener: `more:${day.key}` })}
                            data-calendar-more={day.key}
                            className="block min-h-11 rounded bg-muted px-2 py-3 text-xs font-bold text-muted-foreground"
                          >
                            +{day.events.length - 4} more events
                          </Link>
                        ) : null}
                      </div>

                      {activityEntries.length ? (
                        <Link
                          href={calendarHref(calendar.baby.id, calendar.monthKey, { date: day.key, opener: `activity:${day.key}` })}
                          data-calendar-activity-day={day.key}
                          className="mt-2 hidden min-h-11 flex-wrap items-center gap-1 md:flex"
                          aria-label={`${day.total} items on ${day.key}`}
                        >
                          {activityEntries.slice(0, 6).map(([type, count]) => (
                            <span
                              key={type}
                              className={`h-2.5 w-2.5 rounded-full ${activityVisuals[type as ActivityTypeName]?.toneClass ?? "bg-primary"}`}
                              title={`${activityLabels[type as ActivityTypeName]} ${count}`}
                            />
                          ))}
                        </Link>
                      ) : null}
                    </div>
                  );
                })}
            </section>
          </div>

          {canAddEvent && !calendar.selected && searchParams.new !== "1" ? (
            <Link
              href={calendarHref(calendar.baby.id, calendar.monthKey, { date: calendar.todayKey, new: "1", opener: "add" })}
              data-calendar-add-event
              className="fixed bottom-24 right-6 z-20 inline-flex min-h-11 items-center gap-2 rounded-full bg-primary px-5 py-3 text-sm font-black text-primary-foreground shadow-soft md:bottom-6"
            >
              <PlusCircle className="h-5 w-5" />
              Add Event
            </Link>
          ) : null}

          {!calendar.selected && searchParams.new !== "1" && searchParams.opener ? (
            <CalendarFocusRestore selector={calendarOpenerSelector(searchParams.opener, calendar.todayKey)} />
          ) : null}

          {calendar.selected || (searchParams.new === "1" && canAddEvent) ? (
            <CalendarDrawer
              calendar={calendar}
              isNew={searchParams.new === "1" && canAddEvent}
              canAddEvent={canAddEvent}
              error={searchParams.error}
              initialDate={searchParams.date ?? calendar.todayKey}
              opener={searchParams.opener}
            />
          ) : null}
        </div>
      )}
    </AppShell>
  );
}

function CalendarDrawer({
  calendar,
  isNew,
  canAddEvent,
  error,
  initialDate,
  opener
}: {
  calendar: NonNullable<Awaited<ReturnType<typeof getCalendar>>>;
  isNew: boolean;
  canAddEvent: boolean;
  error?: string;
  initialDate: string;
  opener?: string;
}) {
  if (!calendar.baby) return null;
  const closeHref = calendarHref(calendar.baby.id, calendar.monthKey, { opener });
  const selectedDate = calendar.selected?.key ?? initialDate;
  const selectedLabel = calendar.selected?.label ?? formatDateKeyLabel(selectedDate);
  const restoreFocusSelector = calendarOpenerSelector(opener, selectedDate);
  const returnTo = calendarHref(calendar.baby.id, calendar.monthKey, { date: selectedDate, opener });
  const volume = parseUnitPreferences(calendar.home.household.settings?.unitPreferences).volume;

  return (
    <CalendarDrawerShell
      closeHref={closeHref}
      restoreFocusSelector={restoreFocusSelector}
      focusKey={`${selectedDate}:${isNew ? "new" : "summary"}`}
    >
        {isNew ? (
          <NewEventForm
            babyId={calendar.baby.id}
            monthKey={calendar.monthKey}
            selectedDate={selectedDate}
            closeHref={calendarHref(calendar.baby.id, calendar.monthKey, { date: selectedDate, opener })}
            error={error}
            opener={opener}
          />
        ) : (
          <>
            <div className="flex items-start justify-between gap-3 border-b border-border p-5">
              <div>
                <h2 id="calendar-drawer-title" tabIndex={-1} data-calendar-drawer-heading className="text-2xl font-black">
                  {selectedLabel}
                </h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  {(calendar.selected?.events.length ?? 0) + (calendar.selected?.activities.length ?? 0)} calendar items
                </p>
              </div>
              <Link href={closeHref} className="inline-flex h-11 w-11 items-center justify-center rounded-full hover:bg-muted" aria-label="Close">
                <X className="h-5 w-5" />
              </Link>
            </div>

            <div className="flex-1 space-y-5 overflow-y-auto p-5">
              <section className="space-y-3">
                <h3 className="text-base font-black">Events</h3>
                {calendar.selected?.events.length ? null : <p className="text-sm text-muted-foreground">No events for this day.</p>}
                {prioritizeSelectedEvent(calendar.selected?.events ?? [], calendar.selectedEvent?.id).map((event) => (
                  <div
                    key={event.id}
                    className={`rounded-lg border p-4 ${
                      calendar.selectedEvent?.id === event.id ? "border-primary bg-muted/80" : "border-border bg-background/40"
                    }`}
                  >
                    <div className="flex items-start gap-3">
                      <span className="mt-1 h-3 w-3 rounded-full" style={{ backgroundColor: event.color ?? "hsl(var(--primary))" }} />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-lg font-black">{event.title}</p>
                        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-2 text-sm text-muted-foreground">
                          <span className="inline-flex items-center gap-2">
                            <Clock3 className="h-4 w-4" />
                            {formatEventTime(event, calendar.timezone)}
                          </span>
                          {event.location ? (
                            <span className="inline-flex items-center gap-2">
                              <MapPin className="h-4 w-4" />
                              {event.location}
                            </span>
                          ) : null}
                          {event.contacts.length ? (
                            <span className="inline-flex items-center gap-2">
                              <Users className="h-4 w-4" />
                              {event.contacts.map((link) => link.contact.name).join(", ")}
                            </span>
                          ) : null}
                        </div>
                        {event.eventType ? <p className="mt-3 text-sm font-bold text-primary">{event.eventType}</p> : null}
                        {event.description ? <p className="mt-3 whitespace-pre-wrap text-sm">{event.description}</p> : null}
                      </div>
                    </div>
                  </div>
                ))}
              </section>

              <section className="space-y-3">
                <h3 className="text-base font-black">Activity</h3>
                {calendar.selected?.activities.length ? (
                  <div className="space-y-0.5 rounded-lg border border-border bg-background/40 p-1.5">
                    {calendar.selected.activities.map((activity) => (
                      <ActivityListRow key={activity.id} activity={activity} returnTo={returnTo} timeZone={calendar.timezone} volume={volume} />
                    ))}
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">No tracked activity for this day.</p>
                )}
              </section>
            </div>

            <div className="flex justify-end gap-3 border-t border-border p-4">
              <Link
                href={closeHref}
                className="inline-flex min-h-11 items-center justify-center rounded-lg border border-border px-5 text-sm font-bold hover:bg-muted"
              >
                Close
              </Link>
              {canAddEvent ? (
                <Link
                  href={calendarHref(calendar.baby.id, calendar.monthKey, { date: selectedDate, new: "1", opener })}
                  className="inline-flex min-h-11 items-center justify-center gap-2 rounded-lg bg-primary px-5 text-sm font-black text-primary-foreground hover:opacity-95"
                >
                  <PlusCircle className="h-5 w-5" />
                  Add Event
                </Link>
              ) : null}
            </div>
          </>
        )}
    </CalendarDrawerShell>
  );
}

function NewEventForm({
  babyId,
  monthKey,
  selectedDate,
  closeHref,
  error,
  opener
}: {
  babyId: string;
  monthKey: string;
  selectedDate: string;
  closeHref: string;
  error?: string;
  opener?: string;
}) {
  return (
    <CalendarEventSubmission
      fallbackError={error}
      successHref={calendarHref(babyId, monthKey, { date: selectedDate, opener })}
    >
      <input type="hidden" name="babyId" value={babyId} />
      <input type="hidden" name="month" value={monthKey} />
      <input type="hidden" name="opener" value={opener ?? ""} />
      <div className="flex items-start justify-between gap-3 border-b border-border p-5">
        <div>
          <h2 id="calendar-drawer-title" tabIndex={-1} data-calendar-drawer-heading className="text-2xl font-black">
            New Event
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">{formatDateKeyLabel(selectedDate)}</p>
        </div>
        <Link href={closeHref} className="inline-flex h-11 w-11 items-center justify-center rounded-full hover:bg-muted" aria-label="Close">
          <X className="h-5 w-5" />
        </Link>
      </div>

      <div className="flex-1 space-y-5 overflow-y-auto p-5">
        {/* Server-provided fallback is retained only across non-JavaScript navigations. */}
        {error ? <div className="sr-only">{error}</div> : null}

        <section className="space-y-4">
          <h3 className="text-lg font-black">Event Details</h3>
          <label className="block space-y-2 text-sm font-bold">
            <span>Title *</span>
            <Input name="title" placeholder="Enter event title" required />
          </label>

          <label className="block space-y-2 text-sm font-bold">
            <span>Event Type</span>
            <Select name="eventType" defaultValue="Appointment">
              {eventTypes.map((type) => (
                <option key={type} value={type}>
                  {type}
                </option>
              ))}
            </Select>
          </label>

          <label className="flex min-h-11 items-center gap-3 text-sm font-bold">
            <input name="allDay" type="checkbox" className="h-5 w-5 rounded border-border bg-card" />
            All day event
          </label>

          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block space-y-2 text-sm font-bold">
              <span>Start Date *</span>
              <Input name="startDate" type="date" defaultValue={selectedDate} required />
            </label>
            <label className="block space-y-2 text-sm font-bold">
              <span>Start Time</span>
              <Input name="startTime" type="time" defaultValue="09:00" />
            </label>
            <label className="block space-y-2 text-sm font-bold">
              <span>End Date</span>
              <Input name="endDate" type="date" defaultValue={selectedDate} />
            </label>
            <label className="block space-y-2 text-sm font-bold">
              <span>End Time</span>
              <Input name="endTime" type="time" defaultValue="10:00" />
            </label>
          </div>

          <label className="block space-y-2 text-sm font-bold">
            <span>Location</span>
            <Input name="location" placeholder="Enter location" />
          </label>

          <label className="block space-y-2 text-sm font-bold">
            <span>Description</span>
            <Textarea name="description" placeholder="Enter event description" />
          </label>

          <label className="block space-y-2 text-sm font-bold">
            <span>Color</span>
            <div className="flex items-center gap-3">
              <input name="color" type="color" defaultValue="#14b8a6" className="h-11 w-14 rounded-lg border border-border bg-card p-1" />
              <span className="text-sm text-muted-foreground">Custom color for this event</span>
            </div>
          </label>
        </section>
      </div>

      <div className="flex justify-end gap-3 border-t border-border p-4">
        <Link
          href={closeHref}
          className="inline-flex min-h-11 items-center justify-center rounded-lg border border-border px-5 text-sm font-bold hover:bg-muted"
        >
          Cancel
        </Link>
        <Button type="submit">Save Event</Button>
      </div>
    </CalendarEventSubmission>
  );
}

function calendarHref(babyId: string, month: string, extra?: { date?: string; eventId?: string; new?: string; opener?: string }) {
  const params = new URLSearchParams({ babyId, month });
  if (extra?.date) params.set("date", extra.date);
  if (extra?.eventId) params.set("eventId", extra.eventId);
  if (extra?.new) params.set("new", extra.new);
  if (extra?.opener) params.set("opener", extra.opener);
  return `/app/calendar?${params.toString()}`;
}

function calendarOpenerSelector(opener: string | undefined, selectedDate: string) {
  if (opener === "add") return "[data-calendar-add-event]";
  const [kind, id, extra] = opener?.split(":") ?? [];
  if (extra || !id || !/^[a-z0-9-]+$/i.test(id)) return `[data-calendar-day="${selectedDate}"]`;
  if (kind === "event") return `[data-calendar-event="${id}"]`;
  if (kind === "more") return `[data-calendar-more="${id}"]`;
  if (kind === "activity") return `[data-calendar-activity-day="${id}"]`;
  return `[data-calendar-day="${id}"]`;
}

function prioritizeSelectedEvent<T extends { id: string }>(events: T[], selectedId?: string) {
  if (!selectedId) return events;
  const selected = events.find((event) => event.id === selectedId);
  if (!selected) return events;
  return [selected, ...events.filter((event) => event.id !== selectedId)];
}

function formatEventTime(event: { allDay: boolean; startTime: Date; endTime: Date | null }, timeZone: string) {
  if (event.allDay) return "All day";
  const start = formatTime(event.startTime, timeZone);
  const end = event.endTime ? formatTime(event.endTime, timeZone) : null;
  return end ? `${start} - ${end}` : start;
}

function formatTime(date: Date, timeZone: string) {
  return new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", timeZone }).format(date);
}

function formatDateKeyLabel(key: string) {
  return new Intl.DateTimeFormat("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric", timeZone: "UTC" }).format(
    new Date(`${key}T12:00:00.000Z`)
  );
}

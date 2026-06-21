import Link from "next/link";
import { redirect } from "next/navigation";
import { ChevronLeft, ChevronRight, Clock3, MapPin, PlusCircle, Users, X } from "lucide-react";
import { AppShell } from "@/components/app-shell";
import { Button } from "@/components/ui/button";
import { Input, Textarea } from "@/components/ui/input";
import { activityAccent, activityLabels, type ActivityTypeName } from "@/domain/activity";
import { describeActivity } from "@/lib/activity-format";
import { requireUserPage } from "@/server/auth/session";
import { getHeaderBabySelector } from "@/server/services/baby-selector";
import { getCalendar } from "@/server/services/calendar";
import { createCalendarEventAction } from "@/app/app/calendar/actions";

const weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const eventTypes = ["Appointment", "Birthday", "Reminder", "Checkup", "Visit", "Other"];

export default async function CalendarPage({
  searchParams
}: {
  searchParams: { babyId?: string; month?: string; date?: string; eventId?: string; new?: string; error?: string };
}) {
  const user = await requireUserPage();
  const babySelector = await getHeaderBabySelector(user.id, searchParams.babyId);
  const selectedBabyId = babySelector?.selectedBabyId ?? searchParams.babyId;
  const calendar = await getCalendar(user.id, { ...searchParams, babyId: selectedBabyId });
  if (!calendar?.home) redirect("/onboarding");

  return (
    <AppShell title="Calendar" userName={user.name} babySelector={babySelector}>
      {!calendar.baby ? (
        <div className="rounded-lg border border-border bg-card p-4">Add a baby before viewing the calendar.</div>
      ) : (
        <div className="space-y-0">
          <div className="sticky top-20 z-10 -mx-4 -mt-5 md:-mx-6">
            <section className="border-b border-border bg-primary/85 text-primary-foreground">
              <div className="grid min-h-9 grid-cols-[56px_1fr_56px] items-center px-2 py-1 md:px-6">
                <Link
                  href={calendarHref(calendar.baby.id, calendar.previousMonth)}
                  className="inline-flex h-9 w-9 items-center justify-center rounded-full hover:bg-primary-foreground/10"
                  aria-label="Previous month"
                >
                  <ChevronLeft className="h-5 w-5" />
                </Link>
                <div className="text-center">
                  <h2 className="text-xl font-black">{calendar.monthLabel}</h2>
                </div>
                <Link
                  href={calendarHref(calendar.baby.id, calendar.nextMonth)}
                  className="inline-flex h-9 w-9 items-center justify-center justify-self-end rounded-full hover:bg-primary-foreground/10"
                  aria-label="Next month"
                >
                  <ChevronRight className="h-5 w-5" />
                </Link>
              </div>
            </section>
            <div className="overflow-x-auto border-b border-border bg-background">
              <div className="grid min-w-[860px] grid-cols-7 py-3 text-center text-sm font-black text-muted-foreground">
                {weekdays.map((day) => (
                  <div key={day}>{day}</div>
                ))}
              </div>
            </div>
          </div>

          <section className="-mx-4 overflow-x-auto md:-mx-6">
            <div className="min-w-[860px]">
              <div className="grid grid-cols-7 border-l border-border">
                {calendar.days.map((day) => {
                  const activityEntries = Object.entries(day.counts);
                  return (
                    <div
                      key={day.key}
                      className={`min-h-40 border-b border-r border-border bg-card/70 p-2 ${
                        day.inMonth ? "" : "bg-background/50 text-muted-foreground"
                      } ${calendar.selected?.key === day.key ? "ring-2 ring-inset ring-primary" : ""}`}
                    >
                      <Link
                        href={calendarHref(calendar.baby.id, calendar.monthKey, { date: day.key })}
                        className={`inline-flex h-7 min-w-7 items-center justify-center rounded-full px-2 text-sm font-black hover:bg-muted ${
                          day.key === calendar.todayKey ? "bg-primary text-primary-foreground" : ""
                        }`}
                      >
                        {day.dayNumber}
                      </Link>

                      <div className="mt-2 space-y-1">
                        {day.events.slice(0, 4).map((event) => (
                          <Link
                            key={event.id}
                            href={calendarHref(calendar.baby.id, calendar.monthKey, { date: day.key, eventId: event.id })}
                            className="block truncate rounded px-2 py-1 text-xs font-black text-white shadow-sm"
                            style={{ backgroundColor: event.color ?? "hsl(var(--primary))" }}
                            title={event.title}
                          >
                            {event.title}
                          </Link>
                        ))}
                        {day.events.length > 4 ? (
                          <Link
                            href={calendarHref(calendar.baby.id, calendar.monthKey, { date: day.key })}
                            className="block rounded bg-muted px-2 py-1 text-xs font-bold text-muted-foreground"
                          >
                            +{day.events.length - 4} more events
                          </Link>
                        ) : null}
                      </div>

                      {activityEntries.length ? (
                        <Link
                          href={calendarHref(calendar.baby.id, calendar.monthKey, { date: day.key })}
                          className="mt-2 flex flex-wrap gap-1"
                          aria-label={`${day.total} items on ${day.key}`}
                        >
                          {activityEntries.slice(0, 6).map(([type, count]) => (
                            <span
                              key={type}
                              className={`h-2.5 w-2.5 rounded-full ${activityAccent[type as ActivityTypeName]?.split(" ")[0] ?? "bg-primary"}`}
                              title={`${activityLabels[type as ActivityTypeName]} ${count}`}
                            />
                          ))}
                        </Link>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            </div>
          </section>

          {!calendar.selected && searchParams.new !== "1" ? (
            <Link
              href={calendarHref(calendar.baby.id, calendar.monthKey, { date: calendar.todayKey, new: "1" })}
              className="fixed bottom-24 right-6 z-20 inline-flex min-h-11 items-center gap-2 rounded-full bg-primary px-5 py-3 text-sm font-black text-primary-foreground shadow-soft md:bottom-6"
            >
              <PlusCircle className="h-5 w-5" />
              Add Event
            </Link>
          ) : null}

          {calendar.selected || searchParams.new === "1" ? (
            <CalendarDrawer
              calendar={calendar}
              isNew={searchParams.new === "1"}
              error={searchParams.error}
              initialDate={searchParams.date ?? calendar.todayKey}
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
  error,
  initialDate
}: {
  calendar: NonNullable<Awaited<ReturnType<typeof getCalendar>>>;
  isNew: boolean;
  error?: string;
  initialDate: string;
}) {
  if (!calendar.baby) return null;
  const closeHref = calendarHref(calendar.baby.id, calendar.monthKey);
  const selectedDate = calendar.selected?.key ?? initialDate;
  const selectedLabel = calendar.selected?.label ?? formatDateKeyLabel(selectedDate);

  return (
    <div className="fixed inset-0 z-40 md:left-64">
      <Link href={closeHref} className="absolute inset-0 bg-black/60" aria-label="Close calendar drawer" />
      <aside className="absolute inset-y-0 right-0 flex w-full max-w-2xl flex-col border-l border-border bg-card shadow-soft">
        {isNew ? (
          <NewEventForm
            babyId={calendar.baby.id}
            monthKey={calendar.monthKey}
            selectedDate={selectedDate}
            closeHref={calendarHref(calendar.baby.id, calendar.monthKey, { date: selectedDate })}
            error={error}
          />
        ) : (
          <>
            <div className="flex items-start justify-between gap-3 border-b border-border p-5">
              <div>
                <h2 className="text-2xl font-black">{selectedLabel}</h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  {(calendar.selected?.events.length ?? 0) + (calendar.selected?.activities.length ?? 0)} calendar items
                </p>
              </div>
              <Link href={closeHref} className="inline-flex h-10 w-10 items-center justify-center rounded-full hover:bg-muted" aria-label="Close">
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
                {calendar.selected?.activities.length ? null : <p className="text-sm text-muted-foreground">No tracked activity for this day.</p>}
                {calendar.selected?.activities.map((activity) => {
                  const type = activity.type as ActivityTypeName;
                  return (
                    <Link key={activity.id} href={`/app/activities/${activity.id}/edit`} className="block rounded-lg border border-border bg-background/40 p-4">
                      <div className="flex items-center justify-between gap-3">
                        <p className="font-black">{activityLabels[type]}</p>
                        <p className="text-xs font-bold text-muted-foreground">{formatTime(activity.occurredAt, calendar.timezone)}</p>
                      </div>
                      <p className="mt-1 text-sm text-muted-foreground">{describeActivity(activity)}</p>
                    </Link>
                  );
                })}
              </section>
            </div>

            <div className="flex justify-end gap-3 border-t border-border p-4">
              <Link
                href={closeHref}
                className="inline-flex min-h-11 items-center justify-center rounded-lg border border-border px-5 text-sm font-bold hover:bg-muted"
              >
                Close
              </Link>
              <Link
                href={calendarHref(calendar.baby.id, calendar.monthKey, { date: selectedDate, new: "1" })}
                className="inline-flex min-h-11 items-center justify-center gap-2 rounded-lg bg-primary px-5 text-sm font-black text-primary-foreground hover:opacity-95"
              >
                <PlusCircle className="h-5 w-5" />
                Add Event
              </Link>
            </div>
          </>
        )}
      </aside>
    </div>
  );
}

function NewEventForm({
  babyId,
  monthKey,
  selectedDate,
  closeHref,
  error
}: {
  babyId: string;
  monthKey: string;
  selectedDate: string;
  closeHref: string;
  error?: string;
}) {
  return (
    <form action={createCalendarEventAction} className="flex min-h-full flex-col">
      <input type="hidden" name="babyId" value={babyId} />
      <input type="hidden" name="month" value={monthKey} />
      <div className="flex items-start justify-between gap-3 border-b border-border p-5">
        <div>
          <h2 className="text-2xl font-black">New Event</h2>
          <p className="mt-1 text-sm text-muted-foreground">{formatDateKeyLabel(selectedDate)}</p>
        </div>
        <Link href={closeHref} className="inline-flex h-10 w-10 items-center justify-center rounded-full hover:bg-muted" aria-label="Close">
          <X className="h-5 w-5" />
        </Link>
      </div>

      <div className="flex-1 space-y-5 overflow-y-auto p-5">
        {error ? <div className="rounded-lg border border-danger/40 bg-danger/15 p-3 text-sm font-bold text-danger">{error}</div> : null}

        <section className="space-y-4">
          <h3 className="text-lg font-black">Event Details</h3>
          <label className="block space-y-2 text-sm font-bold">
            <span>Title *</span>
            <Input name="title" placeholder="Enter event title" required />
          </label>

          <label className="block space-y-2 text-sm font-bold">
            <span>Event Type</span>
            <select name="eventType" defaultValue="Appointment" className="min-h-11 w-full rounded-lg border border-border bg-card px-3 text-sm">
              {eventTypes.map((type) => (
                <option key={type} value={type}>
                  {type}
                </option>
              ))}
            </select>
          </label>

          <label className="flex items-center gap-3 text-sm font-bold">
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
        <Button>Save Event</Button>
      </div>
    </form>
  );
}

function calendarHref(babyId: string, month: string, extra?: { date?: string; eventId?: string; new?: string }) {
  const params = new URLSearchParams({ babyId, month });
  if (extra?.date) params.set("date", extra.date);
  if (extra?.eventId) params.set("eventId", extra.eventId);
  if (extra?.new) params.set("new", extra.new);
  return `/app/calendar?${params.toString()}`;
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

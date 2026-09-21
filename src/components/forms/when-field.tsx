"use client";

import { type KeyboardEvent, useEffect, useId, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import {
  addMinutes,
  formatClock,
  formatDay,
  formatMinutes,
  formatRelative,
  formatWall,
  from12Hour,
  joinWall,
  minutesBetween,
  nowWallTime,
  to12Hour,
  wallParts
} from "@/lib/wall-time";

const quickOffsets = [0, 5, 15, 30, 60];
const nudges = [-5, -1, 1, 5];
const chip =
  "inline-flex min-h-11 shrink-0 items-center justify-center rounded-full border border-border bg-card px-3 text-sm font-semibold transition-colors hover:bg-muted active:bg-border";
const chipOn = "border-primary bg-primary text-primary-foreground hover:bg-primary active:bg-primary";

/** One swipeable row of chips; keeps the form a single column tall instead of wrapping into blocks. */
export const scrollRow = "-mx-1 flex gap-2 overflow-x-auto px-1 pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden";

export type WhenValue = { value: string; followsNow: boolean };

/** Keeps a "Now" value current while the caregiver fills in the rest of the form. */
export function useFollowNow(when: WhenValue, setWhen: (next: WhenValue) => void, timeZone: string) {
  useEffect(() => {
    if (!when.followsNow) return;
    const tick = () => {
      const now = nowWallTime(timeZone);
      if (now !== when.value) setWhen({ value: now, followsNow: true });
    };
    const interval = window.setInterval(tick, 15_000);
    return () => window.clearInterval(interval);
  }, [when, setWhen, timeZone]);
}

export function WhenField({
  label,
  when,
  onChange,
  timeZone
}: {
  label: string;
  when: WhenValue;
  onChange: (next: WhenValue) => void;
  timeZone: string;
}) {
  const [open, setOpen] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const openerRef = useRef<HTMLButtonElement>(null);
  const labelId = useId();
  const now = nowWallTime(timeZone);
  const future = minutesBetween(now, when.value) > 1;

  function set(value: string, followsNow = false) {
    onChange({ value, followsNow });
    setAnnouncement(`${label} set to ${formatWall(value, nowWallTime(timeZone))}`);
  }

  return (
    <div role="group" aria-labelledby={labelId} className="space-y-2">
      <p id={labelId} className="text-sm font-semibold">
        {label}
      </p>
      <button
        ref={openerRef}
        type="button"
        aria-haspopup="dialog"
        onClick={() => setOpen(true)}
        className="flex min-h-14 w-full items-center gap-3 rounded-lg border border-border bg-card py-1.5 pl-3 pr-1.5 text-left transition hover:bg-muted focus:border-ring focus:outline-none focus:ring-4 focus:ring-ring/20"
      >
        <span className="min-w-0 flex-1">
          <span className="block text-lg font-bold leading-tight tabular-nums">{formatClock(when.value)}</span>
          <span className="block text-xs font-semibold text-muted-foreground">
            {formatDay(when.value, now)} · {when.followsNow ? "Now" : formatRelative(when.value, now)}
          </span>
        </span>
        <span className="inline-flex min-h-11 items-center rounded-md bg-muted px-3 text-sm font-bold">Change</span>
      </button>
      {future ? <p className="text-xs font-semibold text-danger">This time is in the future.</p> : null}
      <div className={scrollRow}>
        {quickOffsets.map((offset) => {
          const active = offset === 0 ? when.followsNow : !when.followsNow && when.value === addMinutes(now, -offset);
          return (
            <button
              key={offset}
              type="button"
              aria-pressed={active}
              onClick={() => set(addMinutes(nowWallTime(timeZone), -offset), offset === 0)}
              className={cn(chip, active && chipOn)}
            >
              {offset === 0 ? "Now" : `${formatMinutes(offset)} ago`}
            </button>
          );
        })}
      </div>
      <p aria-live="polite" className="sr-only">
        {announcement}
      </p>
      {open ? (
        <TimeSheet
          label={label}
          value={when.value}
          timeZone={timeZone}
          onCancel={() => {
            setOpen(false);
            openerRef.current?.focus();
          }}
          onDone={(value) => {
            setOpen(false);
            if (value !== when.value) set(value);
            openerRef.current?.focus();
          }}
        />
      ) : null}
    </div>
  );
}

function TimeSheet({
  label,
  value,
  timeZone,
  onCancel,
  onDone
}: {
  label: string;
  value: string;
  timeZone: string;
  onCancel: () => void;
  onDone: (value: string) => void;
}) {
  const [draft, setDraft] = useState(() => wallParts(value));
  const dialogRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const now = nowWallTime(timeZone);
  const today = now.slice(0, 10);
  const yesterday = addMinutes(`${today}T00:00`, -1440).slice(0, 10);
  const { hour12, period } = to12Hour(draft.hour);
  const draftValue = joinWall(draft);

  useEffect(() => {
    dialogRef.current?.querySelector<HTMLElement>("[data-sheet-title]")?.focus();
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = overflow;
    };
  }, []);

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      onCancel();
      return;
    }
    if (event.key !== "Tab") return;
    const controls = Array.from(
      dialogRef.current?.querySelectorAll<HTMLElement>("button:not([disabled]), input:not([disabled]), [tabindex='0']") ?? []
    );
    if (!controls.length) return;
    const first = controls[0];
    const last = controls[controls.length - 1];
    if (event.shiftKey && (document.activeElement === first || document.activeElement?.hasAttribute("data-sheet-title"))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center">
      <button type="button" aria-hidden="true" tabIndex={-1} onClick={onCancel} className="absolute inset-0 cursor-default bg-black/60" />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onKeyDown={handleKeyDown}
        className="relative flex max-h-[90dvh] w-full max-w-md flex-col rounded-t-2xl border border-border bg-card shadow-soft sm:rounded-2xl"
      >
        <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
          <h2 id={titleId} data-sheet-title tabIndex={-1} className="font-editorial text-lg font-bold outline-none">
            {label}
          </h2>
          <p className="text-sm font-semibold text-muted-foreground">{formatWall(draftValue, now)}</p>
        </div>
        <div className="space-y-4 overflow-y-auto px-4 py-4">
          <div className="grid grid-cols-3 gap-2">
            {[
              { label: "Today", date: today },
              { label: "Yesterday", date: yesterday }
            ].map((day) => (
              <button
                key={day.label}
                type="button"
                aria-pressed={draft.date === day.date}
                onClick={() => setDraft({ ...draft, date: day.date })}
                className={cn(chip, "rounded-lg", draft.date === day.date && chipOn)}
              >
                {day.label}
              </button>
            ))}
            <label className="relative">
              <span className="sr-only">Other date</span>
              <input
                type="date"
                value={draft.date}
                max={today}
                onChange={(event) => event.target.value && setDraft({ ...draft, date: event.target.value })}
                className="min-h-11 w-full rounded-lg border border-border bg-card px-2 text-base font-semibold sm:text-sm"
              />
            </label>
          </div>
          <div className="grid grid-cols-4 gap-2">
            {nudges.map((minutes) => (
              <button
                key={minutes}
                type="button"
                aria-label={`${Math.abs(minutes)} ${Math.abs(minutes) === 1 ? "minute" : "minutes"} ${minutes < 0 ? "earlier" : "later"}`}
                onClick={() => setDraft(wallParts(addMinutes(draftValue, minutes)))}
                className={cn(chip, "rounded-lg tabular-nums")}
              >
                {minutes < 0 ? "−" : "+"}
                {Math.abs(minutes)}
              </button>
            ))}
          </div>
          <div className="relative grid grid-cols-3 gap-2 rounded-xl bg-surface-soft p-2">
            <div aria-hidden="true" className="pointer-events-none absolute inset-x-2 top-1/2 h-11 -translate-y-1/2 rounded-lg bg-muted" />
            <Wheel
              label="Hour"
              options={Array.from({ length: 12 }, (_, index) => ({ value: index + 1, text: String(index + 1) }))}
              selected={hour12}
              onSelect={(next) => setDraft({ ...draft, hour: from12Hour(next, period) })}
            />
            <Wheel
              label="Minute"
              options={Array.from({ length: 60 }, (_, index) => ({ value: index, text: String(index).padStart(2, "0") }))}
              selected={draft.minute}
              onSelect={(next) => setDraft({ ...draft, minute: next })}
            />
            <Wheel
              label="AM or PM"
              options={[
                { value: 0, text: "AM" },
                { value: 1, text: "PM" }
              ]}
              selected={period === "AM" ? 0 : 1}
              onSelect={(next) => setDraft({ ...draft, hour: from12Hour(hour12, next === 0 ? "AM" : "PM") })}
            />
          </div>
          <label className="flex items-center justify-between gap-3 text-sm font-semibold">
            Or type the time
            <input
              type="time"
              value={draftValue.slice(11)}
              onChange={(event) => {
                const [hour, minute] = event.target.value.split(":").map(Number);
                if (Number.isInteger(hour) && Number.isInteger(minute)) setDraft({ ...draft, hour, minute });
              }}
              className="min-h-11 rounded-lg border border-border bg-card px-3 text-base sm:text-sm"
            />
          </label>
        </div>
        <div className="grid grid-cols-2 gap-2 border-t border-border p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
          <button type="button" onClick={onCancel} className="min-h-12 rounded-lg bg-muted px-4 text-base font-semibold hover:bg-border">
            Cancel
          </button>
          <button
            type="button"
            onClick={() => onDone(draftValue)}
            className="min-h-12 rounded-lg bg-primary px-4 text-base font-semibold text-primary-foreground hover:brightness-95"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
}

const ROW = 44;

function Wheel({
  label,
  options,
  selected,
  onSelect
}: {
  label: string;
  options: Array<{ value: number; text: string }>;
  selected: number;
  onSelect: (value: number) => void;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const settleRef = useRef<number>();
  const idPrefix = useId();
  const selectedIndex = Math.max(0, options.findIndex((option) => option.value === selected));

  useEffect(() => {
    const list = listRef.current;
    if (!list || Math.round(list.scrollTop / ROW) === selectedIndex) return;
    list.scrollTop = selectedIndex * ROW;
  }, [selectedIndex]);

  useEffect(() => () => window.clearTimeout(settleRef.current), []);

  function handleScroll() {
    window.clearTimeout(settleRef.current);
    settleRef.current = window.setTimeout(() => {
      const list = listRef.current;
      if (!list) return;
      const index = Math.min(options.length - 1, Math.max(0, Math.round(list.scrollTop / ROW)));
      if (index !== selectedIndex) onSelect(options[index].value);
    }, 90);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const step = { ArrowUp: -1, ArrowDown: 1, PageUp: -5, PageDown: 5 }[event.key];
    if (step === undefined) return;
    event.preventDefault();
    onSelect(options[Math.min(options.length - 1, Math.max(0, selectedIndex + step))].value);
  }

  return (
    <div
      ref={listRef}
      role="listbox"
      aria-label={label}
      aria-activedescendant={`${idPrefix}-${selected}`}
      tabIndex={0}
      onScroll={handleScroll}
      onKeyDown={handleKeyDown}
      className="relative h-[220px] snap-y snap-mandatory overflow-y-auto overscroll-contain rounded-lg py-[88px] text-center outline-none [scrollbar-width:none] focus-visible:ring-4 focus-visible:ring-ring/30 [&::-webkit-scrollbar]:hidden"
    >
      {options.map((option) => (
        <div
          key={option.value}
          id={`${idPrefix}-${option.value}`}
          role="option"
          aria-selected={option.value === selected}
          onClick={() => onSelect(option.value)}
          className={cn(
            "flex h-11 cursor-pointer snap-center items-center justify-center text-xl tabular-nums transition-colors",
            option.value === selected ? "font-semibold text-foreground" : "font-semibold text-muted-foreground"
          )}
        >
          {option.text}
        </div>
      ))}
    </div>
  );
}

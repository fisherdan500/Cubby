"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { X } from "lucide-react";
import { UndoLastButton } from "@/components/actions/activity-actions";
import { takeSavedEntry, type SavedEntry } from "@/lib/saved-entry-undo";

const REMOVED_NOTICE_MS = 4_000;

/**
 * A short-lived "Feeding saved · Undo" on the screen a new entry returns to, for the tap that landed
 * on the wrong tile at 3am. It is offered only here, for an entry saved seconds ago, and pinned to that
 * entry: Undo on the log page itself was hidden because "undo whatever I did last" is easy to misfire.
 *
 * It steps aside by itself, unless the parent has started using it - an Undo in progress, or its
 * error, is never pulled out from under them.
 */
export function SavedEntryUndo() {
  const pathname = usePathname();
  const [entry, setEntry] = useState<SavedEntry | null>(null);
  const [removed, setRemoved] = useState(false);
  const engaged = useRef(false);
  const hideTimer = useRef<ReturnType<typeof setTimeout>>();

  function hideAfter(ms: number) {
    clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => {
      if (!engaged.current) setEntry(null);
    }, ms);
  }

  useEffect(() => {
    const saved = takeSavedEntry(sessionStorage, Date.now());
    if (!saved) return;
    engaged.current = false;
    setRemoved(false);
    setEntry({ activityId: saved.activityId, label: saved.label });
    hideAfter(saved.remainingMs);
  }, [pathname]);

  useEffect(() => () => clearTimeout(hideTimer.current), []);

  if (!entry) return null;

  function engage() {
    engaged.current = true;
  }

  function undone() {
    engaged.current = false;
    setRemoved(true);
    hideAfter(REMOVED_NOTICE_MS);
  }

  return (
    <div className="fixed inset-x-0 bottom-[calc(4.75rem+var(--active-timer-bar,0rem))] z-30 px-3 md:bottom-[calc(1rem+var(--active-timer-bar,0rem))] md:left-64 md:px-6 print:hidden">
      <div
        role="status"
        onPointerDown={engage}
        onFocus={engage}
        className="mx-auto flex max-w-3xl items-center gap-2 rounded-xl border border-border bg-card/97 p-2 pl-4 text-sm shadow-lift backdrop-blur"
      >
        <p className="min-w-0 flex-1 truncate font-semibold text-foreground">
          {entry.label} {removed ? "removed" : "saved"}
        </p>
        {removed ? null : <UndoLastButton activityId={entry.activityId} label="Undo" onCompleted={undone} />}
        <button
          type="button"
          aria-label="Dismiss"
          onClick={() => setEntry(null)}
          className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition hover:bg-muted hover:text-foreground"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}

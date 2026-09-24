"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Pencil } from "lucide-react";
import { ConfirmedActivityDelete } from "@/components/actions/confirmed-activity-delete";

const ACTION_WIDTH = 72;
// Movement before a gesture counts as a swipe or a scroll, so a tap with a wobble is still a tap.
const AXIS_LOCK_PX = 8;
// A click arriving this soon after a swipe ends belongs to the swipe, not to the row.
const SWIPE_CLICK_MS = 400;
const OPEN_EVENT = "cubby:swipe-row-open";

/**
 * Swipe a list row left to reveal Edit and Delete - the same two actions, with the same permission
 * rule and the same delete confirmation, as the activity's own page. A tap still opens the entry.
 *
 * Touch and pen only: a mouse user already has both actions one click away on the entry, and a mouse
 * drag over a link means selecting or dragging it. A vertical movement is left to scroll the list.
 * The actions are not in the page until the row is swiped, so the row is one link to keyboard and
 * screen-reader users, exactly as before.
 */
export function SwipeRowActions({
  id,
  returnTo,
  editHref,
  canDelete,
  children
}: React.PropsWithChildren<{
  id: string;
  returnTo: string;
  editHref?: string;
  canDelete: boolean;
}>) {
  const trayWidth = ((editHref ? 1 : 0) + (canDelete ? 1 : 0)) * ACTION_WIDTH;
  const [offset, setOffset] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const offsetRef = useRef(0);
  const gesture = useRef<{ pointerId: number; x: number; y: number; base: number; axis: "x" | "y" | null } | null>(null);
  const swipeEndedAt = useRef(0);

  function moveTo(next: number) {
    offsetRef.current = next;
    setOffset(next);
  }

  function close() {
    moveTo(0);
    setConfirming(false);
  }

  // One row open at a time: starting a swipe anywhere closes whichever row was open.
  useEffect(() => {
    function onOpen(event: Event) {
      if ((event as CustomEvent<string>).detail === id) return;
      offsetRef.current = 0;
      setOffset(0);
      setConfirming(false);
    }
    window.addEventListener(OPEN_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_EVENT, onOpen);
  }, [id]);

  const open = offset !== 0;

  return (
    <div
      className="relative overflow-hidden rounded-lg"
      onKeyDown={(event) => {
        if (event.key === "Escape" && open && !confirming) close();
      }}
    >
      {open ? (
        <div
          className={confirming ? "absolute inset-0 z-10 bg-card" : "absolute inset-y-0 right-0 flex justify-end overflow-hidden"}
          style={confirming ? undefined : { width: -offset }}
        >
          {editHref && !confirming ? (
            <Link
              replace
              href={editHref}
              className="flex h-full shrink-0 flex-col items-center justify-center gap-0.5 bg-primary text-xs font-semibold text-primary-foreground"
              style={{ width: ACTION_WIDTH }}
            >
              <Pencil className="h-4 w-4" aria-hidden="true" />
              Edit
            </Link>
          ) : null}
          {canDelete ? (
            <div className="h-full shrink-0" style={confirming ? undefined : { width: ACTION_WIDTH }}>
              <ConfirmedActivityDelete id={id} returnTo={returnTo} trigger="swipe" onConfirmingChange={setConfirming} />
            </div>
          ) : null}
        </div>
      ) : null}
      <div
        className="touch-pan-y"
        style={{ transform: `translateX(${offset}px)`, transition: dragging ? "none" : "transform 150ms ease-out" }}
        onPointerDown={(event) => {
          if (event.pointerType === "mouse" || !trayWidth) return;
          gesture.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, base: offsetRef.current, axis: null };
        }}
        onPointerMove={(event) => {
          const current = gesture.current;
          if (!current || current.pointerId !== event.pointerId) return;
          const dx = event.clientX - current.x;
          const dy = event.clientY - current.y;
          if (current.axis === null) {
            if (Math.max(Math.abs(dx), Math.abs(dy)) < AXIS_LOCK_PX) return;
            current.axis = Math.abs(dx) > Math.abs(dy) ? "x" : "y";
            if (current.axis === "x") {
              event.currentTarget.setPointerCapture?.(event.pointerId);
              window.dispatchEvent(new CustomEvent(OPEN_EVENT, { detail: id }));
              setDragging(true);
            }
          }
          if (current.axis !== "x") return;
          moveTo(Math.min(0, Math.max(-trayWidth, current.base + dx)));
        }}
        onPointerUp={(event) => {
          const current = gesture.current;
          if (!current || current.pointerId !== event.pointerId) return;
          gesture.current = null;
          if (current.axis !== "x") return;
          setDragging(false);
          swipeEndedAt.current = Date.now();
          moveTo(offsetRef.current <= -trayWidth / 2 ? -trayWidth : 0);
        }}
        onPointerCancel={() => {
          const current = gesture.current;
          gesture.current = null;
          if (current?.axis !== "x") return;
          setDragging(false);
          moveTo(current.base);
        }}
        onClickCapture={(event) => {
          const endedSwipe = Date.now() - swipeEndedAt.current < SWIPE_CLICK_MS;
          if (!endedSwipe && !open) return;
          event.preventDefault();
          event.stopPropagation();
          if (endedSwipe) swipeEndedAt.current = 0;
          else close();
        }}
      >
        {children}
      </div>
    </div>
  );
}

"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { type KeyboardEvent, type ReactNode, useEffect, useRef } from "react";

const focusableSelector = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled]):not([type='hidden'])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])"
].join(",");

export function CalendarDrawerShell({
  closeHref,
  restoreFocusSelector,
  focusKey,
  children
}: {
  closeHref: string;
  restoreFocusSelector: string;
  focusKey: string;
  children?: ReactNode;
}) {
  const router = useRouter();
  const dialogRef = useRef<HTMLElement>(null);
  const restoreTargetRef = useRef<HTMLElement | null>(null);
  const fallbackSelectorRef = useRef(restoreFocusSelector);

  useEffect(() => {
    const activeOpener =
      document.activeElement instanceof HTMLElement &&
      document.activeElement !== document.body &&
      !dialogRef.current?.contains(document.activeElement)
        ? document.activeElement
        : null;
    restoreTargetRef.current = activeOpener ?? document.querySelector<HTMLElement>(fallbackSelectorRef.current);
    if (activeOpener?.matches("[data-calendar-add-event]")) fallbackSelectorRef.current = "[data-calendar-add-event]";
    return () => {
      if (restoreTargetRef.current?.isConnected) {
        restoreTargetRef.current.focus();
        return;
      }
      requestAnimationFrame(() => document.querySelector<HTMLElement>(fallbackSelectorRef.current)?.focus());
    };
  }, []);

  useEffect(() => {
    dialogRef.current?.querySelector<HTMLElement>("[data-calendar-drawer-heading]")?.focus();
  }, [focusKey]);

  function handleKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      router.replace(closeHref);
      return;
    }
    if (event.key !== "Tab") return;

    const controls = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>(focusableSelector) ?? []);
    if (!controls.length) {
      event.preventDefault();
      return;
    }
    const first = controls[0];
    const last = controls[controls.length - 1];
    const heading = dialogRef.current?.querySelector<HTMLElement>("[data-calendar-drawer-heading]");
    if (event.shiftKey && (document.activeElement === heading || document.activeElement === first)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  return (
    <div className="fixed inset-0 z-40">
      <Link href={closeHref} className="absolute inset-0 bg-black/60" aria-hidden="true" tabIndex={-1} />
      <aside
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="calendar-drawer-title"
        className="absolute inset-y-0 right-0 flex w-full max-w-2xl flex-col border-l border-border bg-card shadow-soft"
        onKeyDown={handleKeyDown}
      >
        {children}
      </aside>
    </div>
  );
}

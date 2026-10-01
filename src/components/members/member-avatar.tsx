"use client";

import { useEffect, useRef, useState } from "react";

import { memberInitials } from "@/domain/member-identity";
import { cn } from "@/lib/utils";

/**
 * A member's picture, wherever a person is named.
 *
 * At the size a feed or a list uses, a face is barely legible, so the picture opens full size when
 * tapped. Everyone in a household can see each other's pictures: they are family, and a photo you
 * cannot look at defeats the point of having one.
 *
 * With no picture the member shows their initials and is not a button, because there is nothing to
 * open.
 */
export function MemberAvatar({
  name,
  photoAttachmentId,
  size = "sm",
  className
}: {
  name: string;
  photoAttachmentId: string | null;
  size?: "sm" | "lg";
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const openerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const dialog = dialogRef.current;
    dialog?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  useEffect(() => {
    // Returning focus to the avatar, so keyboard and screen-reader users are not dropped at the top
    // of the page when the picture closes.
    if (!open) openerRef.current?.focus({ preventScroll: true });
  }, [open]);

  const circle = cn(
    "inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-primary/15 font-semibold text-primary",
    size === "lg" ? "h-12 w-12 text-base" : "h-8 w-8 text-xs",
    className
  );

  if (!photoAttachmentId) {
    return (
      <span aria-hidden="true" className={circle}>
        {memberInitials(name)}
      </span>
    );
  }

  return (
    <>
      <button
        ref={openerRef}
        type="button"
        onClick={() => setOpen(true)}
        aria-label={`Open ${name}'s picture`}
        className={cn(circle, "transition hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary")}
      >
        {/* The small copy: a feed scrolls past dozens of these. */}
        <img src={`/api/attachments/${photoAttachmentId}?size=thumbnail`} alt={name} className="h-full w-full object-cover" />
      </button>
      {open ? (
        <div
          ref={dialogRef}
          role="dialog"
          aria-modal="true"
          aria-label={name}
          tabIndex={-1}
          onClick={() => setOpen(false)}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-6 focus:outline-none"
        >
          {/* Full size, because seeing the face is the whole reason for opening it. */}
          <img
            src={`/api/attachments/${photoAttachmentId}`}
            alt={name}
            onClick={(event) => event.stopPropagation()}
            className="max-h-full max-w-full rounded-lg object-contain"
          />
          <button
            type="button"
            onClick={() => setOpen(false)}
            aria-label="Close"
            className="absolute right-4 top-4 inline-flex h-12 w-12 items-center justify-center rounded-full bg-black/60 text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
          >
            <span aria-hidden="true" className="text-xl leading-none">
              ×
            </span>
          </button>
        </div>
      ) : null}
    </>
  );
}

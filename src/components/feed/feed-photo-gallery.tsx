"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Download, Share2, X } from "lucide-react";

type Photo = { id: string; width: number; height: number };

const photoSrc = (photo: Photo) => `/api/attachments/${photo.id}`;

const extensions: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };

/** The photo as a file, fetched from the same checked address the viewer shows it from. */
async function photoFile(photo: Photo) {
  const response = await fetch(photoSrc(photo), { credentials: "same-origin" });
  const type = response.headers.get("Content-Type")?.split(";")[0].trim() ?? "";
  if (!response.ok || !extensions[type]) throw new Error("photo_unavailable");
  return new File([await response.blob()], `cubby-${photo.id}.${extensions[type]}`, { type });
}

function download(file: File) {
  const url = URL.createObjectURL(file);
  const link = document.createElement("a");
  link.href = url;
  link.download = file.name;
  document.body.append(link);
  link.click();
  link.remove();
  // Let the download start before the temporary address goes.
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// Phones share files through the system sheet; on an iPhone that is how a photo gets into Photos,
// since a download only reaches the Files app.
function canShareFiles() {
  return typeof navigator !== "undefined" && typeof navigator.share === "function" && typeof navigator.canShare === "function";
}

const viewerButton =
  "inline-flex h-12 w-12 items-center justify-center rounded-full bg-black/60 text-white disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white";

/**
 * A post's photos (DEC-PROD-422). One shows at its own shape; several share a grid of squares. A tap
 * opens the photo full screen inside Cubby, never as a separate page: an installed app has no browser
 * back button, so leaving for the raw image stranded people there. The viewer closes with its Close
 * button, Escape, a tap outside the photo, or the phone's back gesture.
 */
export function FeedPhotoGallery({ photos }: { photos: Photo[] }) {
  const [open, setOpen] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [shareable, setShareable] = useState(false);
  // Opening adds one history step so Back closes the viewer; closing another way takes that step back.
  const pushedHistory = useRef(false);
  const closeButton = useRef<HTMLButtonElement>(null);

  const close = useCallback(() => {
    setOpen(null);
    if (pushedHistory.current) {
      pushedHistory.current = false;
      window.history.back();
    }
  }, []);

  const step = useCallback((by: number) => {
    setOpen((current) => (current === null ? null : (current + by + photos.length) % photos.length));
  }, [photos.length]);

  useEffect(() => {
    if (open === null) return;
    const onPopState = () => {
      pushedHistory.current = false;
      setOpen(null);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
      else if (event.key === "ArrowRight" && photos.length > 1) step(1);
      else if (event.key === "ArrowLeft" && photos.length > 1) step(-1);
    };
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    window.addEventListener("popstate", onPopState);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("popstate", onPopState);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [open, close, step, photos.length]);

  useEffect(() => {
    if (open !== null) closeButton.current?.focus();
    setSaveError("");
  }, [open]);

  // Known only in the browser, so decided after the first render to match the server's.
  useEffect(() => setShareable(canShareFiles()), []);

  async function keep(photo: Photo, how: "save" | "share") {
    setSaveError("");
    setSaving(true);
    try {
      const file = await photoFile(photo);
      if (how === "share" && navigator.canShare({ files: [file] })) await navigator.share({ files: [file] });
      else download(file);
    } catch (error) {
      // Closing the share sheet without choosing anything is not a failure.
      if (!(error instanceof DOMException && error.name === "AbortError")) setSaveError("Couldn't get the photo. Try again.");
    } finally {
      setSaving(false);
    }
  }

  if (photos.length === 0) return null;
  const single = photos.length === 1;
  const columns = single ? "" : photos.length === 2 || photos.length === 4 ? "grid-cols-2" : "grid-cols-3";

  function openAt(index: number) {
    if (!pushedHistory.current) {
      window.history.pushState({ cubbyPhotoViewer: true }, "");
      pushedHistory.current = true;
    }
    setOpen(index);
  }

  const shown = open === null ? null : photos[open];

  return (
    <>
      <ul aria-label="Photos" className={single ? "" : `grid gap-1 ${columns}`}>
        {photos.map((photo, index) => (
          <li key={photo.id}>
            <button
              type="button"
              aria-label={`Open photo ${index + 1} of ${photos.length}`}
              onClick={() => openAt(index)}
              className="block w-full overflow-hidden rounded-lg bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {/* Served by Cubby's own checked endpoint; the image optimizer could not carry the viewer's session. */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={photoSrc(photo)}
                width={photo.width}
                height={photo.height}
                loading="lazy"
                alt={`Photo ${index + 1} of ${photos.length}`}
                className={single ? "h-auto max-h-[32rem] w-full object-contain" : "aspect-square h-full w-full object-cover"}
              />
            </button>
          </li>
        ))}
      </ul>

      {shown && open !== null ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={`Photo ${open + 1} of ${photos.length}`}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/95"
        >
          <div data-testid="photo-viewer-backdrop" className="absolute inset-0" onClick={close} />
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={photoSrc(shown)}
            width={shown.width}
            height={shown.height}
            alt={`Photo ${open + 1} of ${photos.length}`}
            className="relative max-h-full max-w-full object-contain"
          />
          <div className="absolute right-3 top-[max(0.75rem,env(safe-area-inset-top))] flex gap-2">
            {shareable ? (
              <button type="button" aria-label="Share photo" disabled={saving} onClick={() => void keep(shown, "share")} className={viewerButton}>
                <Share2 className="h-6 w-6" aria-hidden="true" />
              </button>
            ) : null}
            <button type="button" aria-label="Save photo" disabled={saving} onClick={() => void keep(shown, "save")} className={viewerButton}>
              <Download className="h-6 w-6" aria-hidden="true" />
            </button>
            <button ref={closeButton} type="button" aria-label="Close photo" onClick={close} className={viewerButton}>
              <X className="h-6 w-6" aria-hidden="true" />
            </button>
          </div>
          {saveError ? (
            <p role="alert" className="absolute left-3 right-3 top-[calc(max(0.75rem,env(safe-area-inset-top))+3.5rem)] rounded-lg bg-black/80 px-3 py-2 text-center text-sm font-semibold text-white">
              {saveError}
            </p>
          ) : null}
          {photos.length > 1 ? (
            <>
              <button
                type="button"
                aria-label="Previous photo"
                onClick={() => step(-1)}
                className="absolute left-2 top-1/2 inline-flex h-12 w-12 -translate-y-1/2 items-center justify-center rounded-full bg-black/60 text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
              >
                <ChevronLeft className="h-6 w-6" aria-hidden="true" />
              </button>
              <button
                type="button"
                aria-label="Next photo"
                onClick={() => step(1)}
                className="absolute right-2 top-1/2 inline-flex h-12 w-12 -translate-y-1/2 items-center justify-center rounded-full bg-black/60 text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
              >
                <ChevronRight className="h-6 w-6" aria-hidden="true" />
              </button>
              <p className="absolute bottom-[max(1rem,env(safe-area-inset-bottom))] left-0 right-0 text-center text-sm font-semibold text-white/80">
                {open + 1} of {photos.length}
              </p>
            </>
          ) : null}
        </div>
      ) : null}
    </>
  );
}

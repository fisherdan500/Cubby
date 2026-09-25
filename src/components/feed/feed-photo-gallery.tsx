"use client";

import { useCallback, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type TouchEvent as ReactTouchEvent } from "react";
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

/**
 * How this device keeps a photo. A web page cannot write to a phone's photo library; the system share
 * sheet can, and on an iPhone its Save Image is the only way into Photos - a download reaches only the
 * Files app. So on a touch screen that can share files, Save opens the sheet ("save"); a computer
 * downloads, with Share beside it where it can share ("button"); otherwise there is only the download.
 */
function sharingMode(): "none" | "button" | "save" {
  if (typeof navigator === "undefined" || typeof navigator.share !== "function" || typeof navigator.canShare !== "function") return "none";
  const touch = typeof window.matchMedia === "function" && window.matchMedia("(pointer: coarse)").matches;
  return touch ? "save" : "button";
}

const CONTROLS_SHOWN_MS = 2000;
// How far a finger travels before a swipe counts: sideways to step, down to close.
const STEP_SWIPE_PX = 50;
const CLOSE_SWIPE_PX = 100;
// A tap within this share of the screen's width from either side steps that way.
const EDGE_TAP_SHARE = 0.25;

const viewerButton =
  "inline-flex h-12 w-12 items-center justify-center rounded-full bg-black/60 text-white disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white";

/**
 * A post's photos (DEC-PROD-422). One shows at its own shape; several share a grid of squares. A tap
 * opens the photo full screen inside Cubby, never as a separate page: an installed app has no browser
 * back button, so leaving for the raw image stranded people there. It works like a phone's photo
 * viewer: swipe or tap near either side to move between photos, stopping at the ends; swipe down to
 * close, well clear of the bottom edge a phone keeps for switching apps; tap the middle to show or
 * hide the buttons, which fade on their own. Close, Escape and the back gesture close it too.
 */
export function FeedPhotoGallery({ photos }: { photos: Photo[] }) {
  const [open, setOpen] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [saveNote, setSaveNote] = useState("");
  const [sharing, setSharing] = useState<"none" | "button" | "save">("none");
  // Photos fetched for keeping, by id. A phone only opens the share sheet straight from a tap, so the
  // open photo is fetched ahead and the sheet opens the moment Save is tapped.
  const requests = useRef(new Map<string, Promise<File>>());
  const [ready, setReady] = useState<Record<string, File>>({});
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

  // Stops at the first and last photo, as a phone's photo viewer does, rather than wrapping around.
  const step = useCallback((by: number) => {
    setOpen((current) => (current === null ? null : Math.min(photos.length - 1, Math.max(0, current + by))));
  }, [photos.length]);

  // The buttons show when a photo opens and fade after a moment, so the photo is clear; a tap in the
  // middle brings them back or puts them away.
  const [controls, setControls] = useState(true);
  const hideTimer = useRef<number>();
  const showControls = useCallback(() => {
    setControls(true);
    window.clearTimeout(hideTimer.current);
    hideTimer.current = window.setTimeout(() => setControls(false), CONTROLS_SHOWN_MS);
  }, []);
  const hideControls = useCallback(() => {
    window.clearTimeout(hideTimer.current);
    setControls(false);
  }, []);
  const viewing = open !== null;
  useEffect(() => {
    if (viewing) showControls();
    return () => window.clearTimeout(hideTimer.current);
  }, [viewing, showControls]);

  // A swipe left or right steps; a swipe down closes, as in Photos. The photo follows the finger along
  // whichever way the swipe first went.
  const touchStart = useRef<{ x: number; y: number; axis?: "x" | "y" } | null>(null);
  const [drag, setDrag] = useState<{ x: number; y: number } | null>(null);

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
    setSaveNote("");
  }, [open]);

  // Known only in the browser, so decided after the first render to match the server's.
  useEffect(() => setSharing(sharingMode()), []);

  const fetchFile = useCallback((photo: Photo) => {
    let pending = requests.current.get(photo.id);
    if (!pending) {
      pending = photoFile(photo);
      requests.current.set(photo.id, pending);
      pending.then(
        (file) => setReady((current) => ({ ...current, [photo.id]: file })),
        () => requests.current.delete(photo.id)
      );
    }
    return pending;
  }, []);

  const shownId = open === null ? undefined : photos[open]?.id;
  useEffect(() => {
    const photo = photos.find((candidate) => candidate.id === shownId);
    if (sharing === "save" && photo) fetchFile(photo).catch(() => undefined);
  }, [sharing, shownId, photos, fetchFile]);

  async function shareFile(file: File) {
    try {
      if (!navigator.canShare({ files: [file] })) {
        download(file);
        return;
      }
      await navigator.share({ files: [file] });
    } catch (error) {
      const name = error instanceof DOMException ? error.name : "";
      // Closing the sheet without choosing anything is not a failure.
      if (name === "AbortError") return;
      // The phone refused a sheet that did not come straight from the tap; the photo is here now.
      if (name === "NotAllowedError") setSaveNote("The photo is ready. Tap Save again, then Save Image.");
      else setSaveError("Couldn't save the photo. Try again.");
    }
  }

  async function keep(photo: Photo, how: "download" | "share") {
    setSaveError("");
    setSaveNote("");
    const file = ready[photo.id];
    if (how === "share" && file) {
      // Nothing awaited before the sheet opens, so it still counts as the tap's own.
      void shareFile(file);
      return;
    }
    setSaving(true);
    try {
      const fetched = await fetchFile(photo);
      if (how === "share") await shareFile(fetched);
      else download(fetched);
    } catch {
      setSaveError("Couldn't get the photo. Try again.");
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
  const first = open === 0;
  const last = open === photos.length - 1;

  function onTouchStart(event: ReactTouchEvent) {
    const touch = event.touches[0];
    if (!touch || event.touches.length > 1) return;
    touchStart.current = { x: touch.clientX, y: touch.clientY };
  }

  function onTouchMove(event: ReactTouchEvent) {
    const start = touchStart.current;
    const touch = event.touches[0];
    if (!start || !touch) return;
    const dx = touch.clientX - start.x;
    const dy = touch.clientY - start.y;
    if (!start.axis && Math.max(Math.abs(dx), Math.abs(dy)) > 10) start.axis = Math.abs(dx) > Math.abs(dy) ? "x" : "y";
    // Past either end the photo moves only a little, to show there is nothing more that way.
    const pastEnd = (dx > 0 && first) || (dx < 0 && last);
    if (start.axis === "x") setDrag({ x: pastEnd ? dx / 4 : dx, y: 0 });
    else if (start.axis === "y") setDrag({ x: 0, y: Math.max(0, dy) });
  }

  function onTouchEnd(event: ReactTouchEvent) {
    const start = touchStart.current;
    const touch = event.changedTouches[0];
    touchStart.current = null;
    setDrag(null);
    if (!start || !touch) return;
    const dx = touch.clientX - start.x;
    const dy = touch.clientY - start.y;
    if (Math.abs(dx) >= STEP_SWIPE_PX && Math.abs(dx) > Math.abs(dy)) step(dx < 0 ? 1 : -1);
    else if (dy >= CLOSE_SWIPE_PX && dy > Math.abs(dx)) close();
  }

  function onSurfaceClick(event: ReactMouseEvent) {
    // The buttons do their own thing, even where they sit over an edge.
    if (event.target instanceof Element && event.target.closest("button")) return;
    const width = window.innerWidth;
    if (event.clientX < width * EDGE_TAP_SHARE) {
      if (!first) step(-1);
    } else if (event.clientX > width * (1 - EDGE_TAP_SHARE)) {
      if (!last) step(1);
    } else if (controls) {
      hideControls();
    } else {
      showControls();
    }
  }

  const controlsClass = `transition-opacity duration-300 ${controls ? "opacity-100" : "pointer-events-none opacity-0"}`;

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
          data-controls={controls ? "shown" : "hidden"}
          onClick={onSurfaceClick}
          onTouchStart={onTouchStart}
          onTouchMove={onTouchMove}
          onTouchEnd={onTouchEnd}
          onTouchCancel={() => {
            touchStart.current = null;
            setDrag(null);
          }}
          // The viewer handles every touch itself, so the page behind neither scrolls nor bounces.
          className="fixed inset-0 z-50 flex touch-none select-none items-center justify-center bg-black"
          style={{ backgroundColor: drag?.y ? `rgb(0 0 0 / ${Math.max(0.4, 1 - drag.y / 600)})` : undefined }}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={photoSrc(shown)}
            width={shown.width}
            height={shown.height}
            alt={`Photo ${open + 1} of ${photos.length}`}
            draggable={false}
            className="relative max-h-full max-w-full object-contain"
            style={{
              transform: drag ? `translate(${drag.x}px, ${drag.y}px) scale(${1 - Math.min(drag.y, 400) / 1600})` : undefined,
              transition: drag ? "none" : "transform 150ms ease-out"
            }}
          />
          <div className={`absolute right-3 top-[max(0.75rem,env(safe-area-inset-top))] flex gap-2 ${controlsClass}`}>
            {sharing === "button" ? (
              <button type="button" aria-label="Share photo" disabled={saving} onClick={() => void keep(shown, "share")} className={viewerButton}>
                <Share2 className="h-6 w-6" aria-hidden="true" />
              </button>
            ) : null}
            <button
              type="button"
              aria-label="Save photo"
              data-ready={sharing === "save" ? String(Boolean(ready[shown.id])) : undefined}
              disabled={saving}
              onClick={() => void keep(shown, sharing === "save" ? "share" : "download")}
              className={viewerButton}
            >
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
          {saveNote ? (
            <p role="status" className="absolute left-3 right-3 top-[calc(max(0.75rem,env(safe-area-inset-top))+3.5rem)] rounded-lg bg-black/80 px-3 py-2 text-center text-sm font-semibold text-white">
              {saveNote}
            </p>
          ) : null}
          {photos.length > 1 ? (
            <>
              {!first ? (
                <button
                  type="button"
                  aria-label="Previous photo"
                  onClick={() => {
                    step(-1);
                    showControls();
                  }}
                  className={`absolute left-2 top-1/2 -translate-y-1/2 ${viewerButton} ${controlsClass}`}
                >
                  <ChevronLeft className="h-6 w-6" aria-hidden="true" />
                </button>
              ) : null}
              {!last ? (
                <button
                  type="button"
                  aria-label="Next photo"
                  onClick={() => {
                    step(1);
                    showControls();
                  }}
                  className={`absolute right-2 top-1/2 -translate-y-1/2 ${viewerButton} ${controlsClass}`}
                >
                  <ChevronRight className="h-6 w-6" aria-hidden="true" />
                </button>
              ) : null}
              <p className={`pointer-events-none absolute bottom-[max(1rem,env(safe-area-inset-bottom))] left-0 right-0 text-center text-sm font-semibold text-white/80 ${controlsClass}`}>
                {open + 1} of {photos.length}
              </p>
            </>
          ) : null}
        </div>
      ) : null}
    </>
  );
}

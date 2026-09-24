/**
 * After a new entry is saved, the screen the form returns to offers a short-lived Undo for it.
 *
 * The form and that screen never exist at the same time, so the entry is handed across in session
 * storage: written as the form finishes, taken (and removed) by the next screen, and ignored once the
 * window has passed. Storage is per tab, so another tab never offers to undo this one's entry.
 */

export const SAVED_ENTRY_UNDO_MS = 10_000;

const STORAGE_KEY = "cubby:saved-entry-undo";

type EntryStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export type SavedEntry = { activityId: string; label: string };

export function rememberSavedEntry(storage: EntryStorage, entry: SavedEntry, nowMs: number) {
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify({ ...entry, savedAt: nowMs }));
  } catch {
    // Undo is a convenience: blocked storage only means it is not offered.
  }
}

export function takeSavedEntry(storage: EntryStorage, nowMs: number): (SavedEntry & { remainingMs: number }) | null {
  let raw: string | null;
  try {
    raw = storage.getItem(STORAGE_KEY);
    storage.removeItem(STORAGE_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object") return null;
  const { activityId, label, savedAt } = value as Record<string, unknown>;
  if (typeof activityId !== "string" || !activityId || typeof label !== "string" || typeof savedAt !== "number") return null;
  const elapsed = nowMs - savedAt;
  if (elapsed < 0 || elapsed >= SAVED_ENTRY_UNDO_MS) return null;
  return { activityId, label, remainingMs: SAVED_ENTRY_UNDO_MS - elapsed };
}

/** The new entry's id, from a completed create only: an edit has nothing for Undo to take back. */
export function createdActivityId(data: { status?: string; outcome?: Record<string, unknown> } | undefined) {
  if (data?.status !== "completed" || data.outcome?.action !== "create") return undefined;
  return typeof data.outcome.activityId === "string" && data.outcome.activityId ? data.outcome.activityId : undefined;
}

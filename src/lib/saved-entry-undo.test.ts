import { beforeEach, describe, expect, it } from "vitest";
import {
  SAVED_ENTRY_UNDO_MS,
  createdActivityId,
  rememberSavedEntry,
  takeSavedEntry
} from "@/lib/saved-entry-undo";

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
    size: () => values.size
  };
}

describe("saved entry undo hand-off", () => {
  let storage: ReturnType<typeof memoryStorage>;
  beforeEach(() => { storage = memoryStorage(); });

  it("hands the next screen the entry just saved, once, with the time left to undo it", () => {
    rememberSavedEntry(storage, { activityId: "activity-1", label: "Feeding" }, 1_000);

    expect(takeSavedEntry(storage, 4_000)).toEqual({ activityId: "activity-1", label: "Feeding", remainingMs: SAVED_ENTRY_UNDO_MS - 3_000 });
    // A refresh or a second screen must not offer to undo the same entry again.
    expect(takeSavedEntry(storage, 4_000)).toBeNull();
  });

  it("offers nothing once the undo window has passed", () => {
    rememberSavedEntry(storage, { activityId: "activity-1", label: "Feeding" }, 1_000);

    expect(takeSavedEntry(storage, 1_000 + SAVED_ENTRY_UNDO_MS)).toBeNull();
    expect(storage.size()).toBe(0);
  });

  it("offers nothing for a malformed or foreign value", () => {
    for (const value of ["not json", "{}", JSON.stringify({ activityId: 3, label: "Feeding", savedAt: 1 })]) {
      storage.setItem("cubby:saved-entry-undo", value);
      expect(takeSavedEntry(storage, 2)).toBeNull();
    }
  });

  it("offers nothing for an entry dated in the future, such as after a clock change", () => {
    rememberSavedEntry(storage, { activityId: "activity-1", label: "Feeding" }, 10_000);
    expect(takeSavedEntry(storage, 5_000)).toBeNull();
  });

  it("never lets blocked storage break saving or navigating", () => {
    const blocked = {
      getItem: () => { throw new Error("blocked"); },
      setItem: () => { throw new Error("blocked"); },
      removeItem: () => { throw new Error("blocked"); }
    };
    expect(() => rememberSavedEntry(blocked, { activityId: "activity-1", label: "Feeding" }, 1)).not.toThrow();
    expect(takeSavedEntry(blocked, 1)).toBeNull();
  });

  it("reads the new entry's id only from a completed create", () => {
    expect(createdActivityId({ status: "completed", outcome: { action: "create", activityId: "activity-1" } })).toBe("activity-1");
    expect(createdActivityId({ status: "completed", outcome: { action: "update", activityId: "activity-1" } })).toBeUndefined();
    expect(createdActivityId({ status: "completed" })).toBeUndefined();
    expect(createdActivityId(undefined)).toBeUndefined();
  });
});

import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { activityTypes, type ActivityTypeName } from "@/domain/activity";
import {
  ACTIVITY_DETAIL_RELATION,
  activityBackupDetailKeys,
  activityFields
} from "@/domain/activity-field-matrix";
import { activityRestoreSchema } from "@/lib/validation/activity";

vi.mock("@/lib/db/prisma", () => ({ prisma: {} }));
vi.mock("@/server/auth/context", () => ({ getEffectiveHouseholdContext: vi.fn(), requirePermission: vi.fn() }));
vi.mock("@/server/services/audit", () => ({ writeAudit: vi.fn() }));

import { activityToInput } from "@/server/services/backups";
import { specificCreate } from "@/server/services/activities";

const schema = readFileSync(new URL("../../../prisma/schema.prisma", import.meta.url), "utf8");

/**
 * Fields a backup deliberately leaves out, and why, read from the matrix that declares them rather than
 * restated here. `documentUrl` belongs to vaccine attachments, which backup-format.ts excludes from the
 * format entirely; `contactId` is exported once on the activity itself, because restore has to remap it.
 */
function deliberatelyNotInDetail(type: ActivityTypeName) {
  return activityFields(type)
    .filter((field) => field.omitted?.backup !== undefined)
    .map((field) => field.name);
}

const detailModels = Object.fromEntries(
  activityTypes.map((type) => [type, ACTIVITY_DETAIL_RELATION[type].model])
) as Record<ActivityTypeName, string>;

/** The model's own stored columns: no id, no activityId, no relation fields. */
function storedColumns(model: string) {
  const block = schema.split(/\r?\n(?=model\s)/).find((candidate) => candidate.startsWith(`model ${model} {`));
  if (!block) throw new Error(`missing model ${model}`);
  return block
    .split(/\r?\n/)
    .slice(1)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("}") && !line.startsWith("@@") && !line.startsWith("//"))
    .map((line) => line.split(/\s+/))
    .filter(([name, type]) => name && type && !["id", "activityId"].includes(name) && !/^(ActivityLog|Contact|VaccineDocument)/.test(type))
    .map(([name]) => name);
}


// One fully populated detail record per type, as the database would hold it.
const details: Record<ActivityTypeName, Record<string, unknown>> = {
  feeding: { mode: "bottle", amount: "4.5", unit: "oz", side: "left", bottleType: "Glass", food: "Oat", leftSeconds: 300, rightSeconds: 240 },
  diaper: { kind: "mixed", color: "Yellow", consistency: "Seedy", rashConcern: true, condition: "Mild", blowout: true, creamApplied: true },
  sleep: { sleepType: "nap", location: "Crib", quality: "settled" },
  pumping: { amount: "6", leftAmount: "3", rightAmount: "3", unit: "oz", inventoryAction: "stored" },
  medicine: { name: "Ibuprofen", dose: "2.5", unit: "mL" },
  measurement: { weight: "14.2", weightUnit: "lb", length: "24", lengthUnit: "in", headCircumference: "16", headUnit: "in", temperature: "98.6", temperatureUnit: "F", measurementType: "Checkup" },
  milestone: { title: "First steps", category: "Motor" },
  note: { text: "Tried avocado", category: "Feeding" },
  bath: { bathType: "Sponge", products: "Gentle wash", waterTemp: "Warm" },
  play: { activityName: "Tummy time", location: "Living room", intensity: "active" },
  mood: { mood: "Content", intensity: 3, context: "After nap" },
  supplement: { name: "Vitamin D", dose: "1", unit: "drop" },
  vaccine: { name: "DTaP", dose: "1 of 5", lot: "A123", provider: "Dr. Lee", dueDate: new Date("2026-10-01T00:00:00.000Z") },
  milk_inventory: { action: "stored", amount: "5", unit: "oz", storage: "Freezer", label: "Sept batch" }
};

const relationProperty: Record<ActivityTypeName, string> = {
  feeding: "feeding", diaper: "diaper", sleep: "sleep", pumping: "pumping", medicine: "medicine",
  measurement: "measurement", milestone: "milestone", note: "note", bath: "bath", play: "play",
  mood: "mood", supplement: "supplement", vaccine: "vaccine", milk_inventory: "milkInventory"
};

function savedActivity(type: ActivityTypeName) {
  return {
    id: "activity-1",
    babyId: "baby-1",
    type,
    occurredAt: new Date("2026-09-19T10:30:00.000Z"),
    startedAt: null,
    endedAt: null,
    timezone: "Etc/UTC",
    notes: "Written on the way out",
    source: "manual",
    externalActorName: null,
    timerState: "none",
    durationSeconds: null,
    pausedSeconds: 0,
    [relationProperty[type]]: details[type]
  } as never;
}

describe("backup activity round trip", () => {
  it("has a fixture for every activity type", () => {
    expect(Object.keys(details).sort()).toEqual([...activityTypes].sort());
  });

  it.each([...activityTypes])("exports every stored %s column, or documents why not", (type) => {
    const model = detailModels[type];
    const missing = storedColumns(model)
      .filter((column) => !activityBackupDetailKeys(type).includes(column))
      .filter((column) => !deliberatelyNotInDetail(type).includes(column));

    // A new detail column that nobody declares is silently dropped from every backup, and lost on
    // restore. Declare it in the activity field matrix, or give it an `omitted.backup` reason there.
    expect({ model, missing }).toEqual({ model, missing: [] });
  });

  it.each([...activityTypes])("restores a %s with the same detail it exported", (type) => {
    const exported = activityToInput(savedActivity(type));
    const restored = specificCreate(activityRestoreSchema.parse({
      ...exported.detail,
      babyId: "baby-2",
      type,
      occurredAt: exported.occurredAt,
      timezone: exported.timezone,
      notes: exported.notes ?? undefined,
      activeTimer: false
    })) as unknown as Record<string, { create: Record<string, unknown> } | undefined>;

    const saved = restored[relationProperty[type]]?.create ?? {};
    for (const [field, value] of Object.entries(details[type])) {
      if (deliberatelyNotInDetail(type).includes(field)) continue;
      const round = saved[field];
      const comparable = round instanceof Date ? round.toISOString() : round?.toString?.() ?? round;
      const original = value instanceof Date ? value.toISOString() : value?.toString?.() ?? value;
      expect({ field, value: comparable }).toEqual({ field, value: original });
    }
    expect(exported.notes).toBe("Written on the way out");
  });
});

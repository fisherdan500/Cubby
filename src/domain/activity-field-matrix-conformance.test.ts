import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { activityTypes, type ActivityTypeName } from "@/domain/activity";
import {
  ACTIVITY_DETAIL_RELATION,
  ACTIVITY_FIELD_MATRIX,
  ACTIVITY_FIELD_MATRIX_VERSION,
  activityBackupDetailKeys,
  activityDetailFields,
  activityFields,
  activityFormFields
} from "@/domain/activity-field-matrix";
import { activityEditInitial } from "@/lib/activity-edit-initial";
import { buildActivityDetailSections, activityDetailText } from "@/lib/activity-detail";
import { activityRestoreSchema } from "@/lib/validation/activity";

vi.mock("@/lib/db/prisma", () => ({ prisma: {} }));

import { specificCreate } from "@/server/services/activities";

/**
 * The matrix is only worth having if the surfaces actually answer to it. These tests are the binding:
 * a field declared here has to be stored, accepted, saved, shown, exported and backed up, and a column
 * that exists in the database has to be declared. Adding a field to one place and forgetting the rest
 * fails here rather than in a household's export six months later.
 */

const schema = readFileSync(new URL("../../prisma/schema.prisma", import.meta.url), "utf8");

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

/** A value of the right shape for each kind, so one populated entry exercises every field. */
function sampleValue(type: ActivityTypeName, name: string) {
  const field = activityFields(type).find((candidate) => candidate.name === name)!;
  if (field.values) return field.values[0]!;
  switch (field.kind) {
    case "quantity":
      return "4.5";
    case "unit":
      return "oz";
    case "duration":
      return 300;
    case "scale":
      return 3;
    case "boolean":
      return true;
    case "date":
      return "2026-10-01";
    default:
      return `sample-${name}`;
  }
}

function populatedDetail(type: ActivityTypeName) {
  return Object.fromEntries(activityFields(type).map(({ name }) => [name, sampleValue(type, name)]));
}

/** A saved activity of that type, populated in every declared field, as the database would hold it. */
function populatedActivity(type: ActivityTypeName) {
  const detail = populatedDetail(type);
  return {
    id: "activity-1",
    babyId: "baby-1",
    type,
    occurredAt: new Date("2026-09-20T12:00:00.000Z"),
    startedAt: null,
    endedAt: null,
    durationSeconds: null,
    timezone: "UTC",
    notes: null,
    timerState: "none",
    updatedAt: new Date("2026-09-20T12:00:00.000Z"),
    [ACTIVITY_DETAIL_RELATION[type].property]: {
      ...detail,
      ...(activityFields(type).some((field) => field.kind === "date")
        ? Object.fromEntries(
            activityFields(type)
              .filter((field) => field.kind === "date")
              .map(({ name }) => [name, new Date(`${detail[name]}T00:00:00.000Z`)])
          )
        : {})
    }
  } as never;
}

describe("activity field matrix conformance", () => {
  it("declares a versioned matrix covering every activity type exactly once", () => {
    expect(ACTIVITY_FIELD_MATRIX_VERSION).toBe(1);
    expect(Object.keys(ACTIVITY_FIELD_MATRIX).sort()).toEqual([...activityTypes].sort());
  });

  it.each([...activityTypes])("declares %s fields that are internally coherent", (type) => {
    const fields = activityFields(type);
    const names = fields.map((field) => field.name);
    expect(new Set(names).size).toBe(names.length);

    for (const field of fields) {
      // A field is either shown under a label, or says why it never appears on its own.
      expect({ name: field.name, explained: Boolean(field.label || field.note || field.kind === "unit") })
        .toEqual({ name: field.name, explained: true });
      if (field.kind === "quantity") {
        expect({ name: field.name, unit: field.unitField && names.includes(field.unitField) })
          .toEqual({ name: field.name, unit: true });
      }
      if (field.unitField) {
        expect(fields.find((candidate) => candidate.name === field.unitField)?.kind).toBe("unit");
      }
    }
  });

  it.each([...activityTypes])("declares exactly the columns %s actually stores", (type) => {
    const declared = activityFields(type).map((field) => field.name).sort();
    // Both directions matter: an undeclared column is invisible to every surface driven from here, and
    // a declared field with no column behind it would be saved nowhere.
    expect(declared).toEqual(storedColumns(ACTIVITY_DETAIL_RELATION[type].model).sort());
  });

  it.each([...activityTypes])("accepts and saves every declared %s field", (type) => {
    const input = activityRestoreSchema.parse({
      ...populatedDetail(type),
      babyId: "baby-1",
      type,
      occurredAt: "2026-09-20T12:00:00.000Z",
      timezone: "UTC",
      activeTimer: false
    });
    const draft = specificCreate(input) as unknown as Record<string, { create: Record<string, unknown> } | undefined>;
    const saved = draft[ACTIVITY_DETAIL_RELATION[type].property]?.create ?? {};

    // A field the validation schema drops, or the create mapping forgets, never reaches the database.
    const lost = activityFields(type)
      .map((field) => field.name)
      .filter((name) => saved[name] === undefined || saved[name] === null);
    expect({ type, lost }).toEqual({ type, lost: [] });
  });

  it.each([...activityTypes])("shows every labelled %s field in the detail view, in declaration order", (type) => {
    const { sections } = buildActivityDetailSections(populatedActivity(type), "UTC");
    const details = sections.find((section) => section.title === "Details");
    expect(details?.rows.map((row) => row.label)).toEqual(activityDetailFields(type).map((field) => field.label));
  });

  it.each([...activityTypes])("carries every labelled %s field into an export", (type) => {
    const exported = activityDetailText(populatedActivity(type), "UTC");
    const missing = activityDetailFields(type)
      .map((field) => field.label!)
      .filter((label) => !exported.includes(`${label}: `));

    // An export is the household's own copy of its records; a stored field that never reaches it is
    // lost the moment the data leaves the app.
    expect({ type, missing }).toEqual({ type, missing: [] });
  });

  it.each([...activityTypes])("backs up every declared %s field, or says why not", (type) => {
    expect(activityBackupDetailKeys(type)).toEqual(
      activityFields(type).filter((field) => !field.omitted?.backup).map((field) => field.name)
    );
    for (const field of activityFields(type)) {
      // A reason, not a bare exclusion: the next reader has to be able to tell a decision from a slip.
      for (const reason of Object.values(field.omitted ?? {})) {
        expect({ name: field.name, explained: reason.length > 20 }).toEqual({ name: field.name, explained: true });
      }
    }
  });

  it.each([...activityTypes])("offers every declared %s field back to the form when editing", (type) => {
    const initial = activityEditInitial(populatedActivity(type), "UTC");
    const missing = activityFormFields(type)
      .map((field) => field.name)
      .filter((name) => !(name in initial));

    // A field the edit form cannot show is one a caregiver can save once and then never correct.
    expect({ type, missing }).toEqual({ type, missing: [] });
  });
});

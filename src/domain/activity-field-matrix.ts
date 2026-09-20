import type { ActivityTypeName } from "@/domain/activity";

/**
 * One declaration of what every activity type stores.
 *
 * Adding a field to an activity used to mean editing six places that each held their own copy of the
 * type's field list: the validation schema, the create mapping, the form's initial values, the detail
 * view, the backup export and the exported description. Nothing tied them together, so a field could be
 * saved and then silently vanish from an export or a restore, which is how nursing per-side times and a
 * vaccine's lot number came to be missing from exports.
 *
 * This matrix is the single declaration. The surfaces that can be driven from it are; the ones that
 * cannot are checked against it, and a field that is deliberately absent from a surface says so here,
 * with its reason. `activity-field-matrix-conformance.test.ts` is what makes that binding real.
 *
 * One surface is deliberately not bound: the dashboard's one-line summary (`describeActivity`) stays
 * terse, because a list row has to stay readable on a phone. Completeness belongs to the detail view,
 * the export and the backup, which is why those three are driven from here.
 *
 * The version changes when the shape of a declaration changes, not when a field is added.
 */
export const ACTIVITY_FIELD_MATRIX_VERSION = 1;

export type ActivityFieldKind =
  /** Free text, shown as it was written. */
  | "text"
  /** A stored token shown through `displayLabel`, so "milk_inventory" reads as "Milk inventory". */
  | "enum"
  /** A number shown with whatever unit its `unitField` holds. */
  | "quantity"
  /** The unit carrier for a quantity. It is stored and restored, but never its own row. */
  | "unit"
  /** Seconds, shown as a duration. */
  | "duration"
  /** A 1-5 rating, shown as "3/5". */
  | "scale"
  /** Shown only when true. */
  | "boolean"
  /** A calendar date, stored as midnight UTC and read back in UTC. */
  | "date";

export type ActivityFieldDeclaration = {
  /** The form field name, the validation key and the stored column. All three agree. */
  name: string;
  kind: ActivityFieldKind;
  /**
   * The row label wherever the field is shown to a person: the detail view and the export. A field
   * without one is never shown on its own — a unit carrier appears beside its quantity, and an
   * identifier is not something a caregiver reads. `note` says which.
   */
  label?: string;
  /** Why a field has no label of its own. */
  note?: string;
  /** For a quantity: the field holding its unit. */
  unitField?: string;
  /** The values the type accepts, where it constrains them. */
  values?: readonly string[];
  /** Whether an entry of this type cannot be saved without it. */
  required?: boolean;
  /**
   * Surfaces that deliberately leave the field out, each with the reason. Only surfaces a test
   * enforces appear here, so an entry is a decision someone can check rather than a note.
   */
  omitted?: Partial<Record<"backup" | "form", string>>;
};

const VOLUME_ACTIONS = ["stored", "fed", "discarded", "thawed", "donated", "expired"] as const;

/**
 * Field order is the order the detail view shows them, which is the order a caregiver reads the entry
 * back in. A unit carrier sits directly after the quantity it belongs to.
 */
export const ACTIVITY_FIELD_MATRIX: Record<ActivityTypeName, readonly ActivityFieldDeclaration[]> = {
  feeding: [
    { name: "mode", kind: "enum", label: "Kind", values: ["breast", "bottle", "formula", "solids"], required: true },
    { name: "amount", kind: "quantity", label: "Amount", unitField: "unit" },
    { name: "unit", kind: "unit" },
    { name: "side", kind: "enum", label: "Side", values: ["left", "right", "both"] },
    { name: "bottleType", kind: "text", label: "Bottle type" },
    { name: "food", kind: "text", label: "Food" },
    { name: "leftSeconds", kind: "duration", label: "Left side" },
    { name: "rightSeconds", kind: "duration", label: "Right side" }
  ],
  diaper: [
    { name: "kind", kind: "enum", label: "Kind", values: ["wet", "dirty", "mixed", "dry"], required: true },
    { name: "color", kind: "text", label: "Color" },
    { name: "consistency", kind: "text", label: "Consistency" },
    { name: "condition", kind: "text", label: "Condition" },
    { name: "rashConcern", kind: "boolean", label: "Rash concern" },
    { name: "blowout", kind: "boolean", label: "Blowout" },
    { name: "creamApplied", kind: "boolean", label: "Cream applied" }
  ],
  sleep: [
    { name: "sleepType", kind: "enum", label: "Sleep type" },
    { name: "location", kind: "text", label: "Location" },
    { name: "quality", kind: "enum", label: "Quality" }
  ],
  pumping: [
    { name: "amount", kind: "quantity", label: "Amount", unitField: "unit" },
    { name: "unit", kind: "unit" },
    { name: "leftAmount", kind: "quantity", label: "Left amount", unitField: "unit" },
    { name: "rightAmount", kind: "quantity", label: "Right amount", unitField: "unit" },
    // Named as the form asks it, so the saved answer reads back under the same question.
    { name: "inventoryAction", kind: "enum", label: "Milk went to", values: VOLUME_ACTIONS }
  ],
  medicine: [
    { name: "name", kind: "text", label: "Medicine", required: true },
    { name: "dose", kind: "quantity", label: "Dose", unitField: "unit" },
    { name: "unit", kind: "unit" },
    {
      name: "contactId",
      kind: "text",
      note: "an identifier rather than something a caregiver reads back",
      omitted: {
        backup: "carried on the activity record itself, because restore has to remap it to the contact created in the target household",
        form: "set when the medicine comes from a contact, and preserved by the update path when an edit does not send it"
      }
    }
  ],
  measurement: [
    { name: "measurementType", kind: "enum", label: "Measurement type" },
    { name: "weight", kind: "quantity", label: "Weight", unitField: "weightUnit" },
    { name: "weightUnit", kind: "unit" },
    { name: "length", kind: "quantity", label: "Length", unitField: "lengthUnit" },
    { name: "lengthUnit", kind: "unit" },
    { name: "headCircumference", kind: "quantity", label: "Head circumference", unitField: "headUnit" },
    { name: "headUnit", kind: "unit" },
    { name: "temperature", kind: "quantity", label: "Temperature", unitField: "temperatureUnit" },
    { name: "temperatureUnit", kind: "unit" }
  ],
  milestone: [
    { name: "title", kind: "text", label: "Milestone", required: true },
    { name: "category", kind: "enum", label: "Category" }
  ],
  note: [
    { name: "category", kind: "enum", label: "Category" },
    { name: "text", kind: "text", label: "Entry", required: true }
  ],
  bath: [
    { name: "bathType", kind: "enum", label: "Bath type" },
    { name: "products", kind: "text", label: "Products" },
    { name: "waterTemp", kind: "text", label: "Water temperature" }
  ],
  play: [
    { name: "activityName", kind: "text", label: "Activity" },
    { name: "location", kind: "text", label: "Location" },
    { name: "intensity", kind: "enum", label: "Kind of play" }
  ],
  mood: [
    { name: "mood", kind: "enum", label: "Mood", required: true },
    { name: "intensity", kind: "scale", label: "Intensity" },
    { name: "context", kind: "text", label: "Context" }
  ],
  supplement: [
    { name: "name", kind: "text", label: "Supplement", required: true },
    { name: "dose", kind: "quantity", label: "Dose", unitField: "unit" },
    { name: "unit", kind: "unit" }
  ],
  vaccine: [
    { name: "name", kind: "text", label: "Vaccine", required: true },
    // A vaccine dose reads "1 of 5", not a number with a unit.
    { name: "dose", kind: "text", label: "Dose" },
    { name: "lot", kind: "text", label: "Lot" },
    { name: "provider", kind: "text", label: "Provider" },
    { name: "dueDate", kind: "date", label: "Due date" },
    {
      name: "documentUrl",
      kind: "text",
      label: "Document",
      omitted: {
        backup: "vaccine attachments are excluded from the backup format entirely, and restore clears it"
      }
    }
  ],
  milk_inventory: [
    { name: "action", kind: "enum", label: "Action", values: VOLUME_ACTIONS, required: true },
    { name: "amount", kind: "quantity", label: "Amount", unitField: "unit" },
    { name: "unit", kind: "unit" },
    { name: "storage", kind: "text", label: "Storage" },
    { name: "label", kind: "text", label: "Label" }
  ]
};

/** The relation each type's detail record hangs off, and the Prisma model behind it. */
export const ACTIVITY_DETAIL_RELATION: Record<ActivityTypeName, { property: string; model: string }> = {
  feeding: { property: "feeding", model: "FeedingLog" },
  diaper: { property: "diaper", model: "DiaperLog" },
  sleep: { property: "sleep", model: "SleepLog" },
  pumping: { property: "pumping", model: "PumpingLog" },
  medicine: { property: "medicine", model: "MedicineLog" },
  measurement: { property: "measurement", model: "MeasurementLog" },
  milestone: { property: "milestone", model: "MilestoneLog" },
  note: { property: "note", model: "NoteLog" },
  bath: { property: "bath", model: "BathLog" },
  play: { property: "play", model: "PlayLog" },
  mood: { property: "mood", model: "MoodLog" },
  supplement: { property: "supplement", model: "SupplementLog" },
  vaccine: { property: "vaccine", model: "VaccineLog" },
  milk_inventory: { property: "milkInventory", model: "MilkInventoryLog" }
};

export function activityFields(type: ActivityTypeName) {
  return ACTIVITY_FIELD_MATRIX[type];
}

/** The saved detail record for an activity, whichever relation holds it. */
export function activityDetailRecord(activity: { type: string } & Record<string, unknown>) {
  const relation = ACTIVITY_DETAIL_RELATION[activity.type as ActivityTypeName];
  if (!relation) return null;
  const record = activity[relation.property];
  return record && typeof record === "object" ? (record as Record<string, unknown>) : null;
}

/** The fields the detail view gives a row of its own, in the order it shows them. */
export function activityDetailFields(type: ActivityTypeName) {
  return activityFields(type).filter((field) => field.label !== undefined);
}

/** The keys a backup carries inside an activity's `detail`, in declaration order. */
export function activityBackupDetailKeys(type: ActivityTypeName) {
  return activityFields(type)
    .filter((field) => field.omitted?.backup === undefined)
    .map((field) => field.name);
}

/** The fields an edit form is given back, so a caregiver can correct what they saved. */
export function activityFormFields(type: ActivityTypeName) {
  return activityFields(type).filter((field) => field.omitted?.form === undefined);
}

/** Every field of every type, for checks that do not care which type a name belongs to. */
export function activityFieldNames(type: ActivityTypeName) {
  return activityFields(type).map((field) => field.name);
}

export function activityField(type: ActivityTypeName, name: string) {
  return activityFields(type).find((field) => field.name === name);
}

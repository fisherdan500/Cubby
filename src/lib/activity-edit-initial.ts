import { dateTimeInputValue } from "@/lib/timezone";

type NumberLike = { toString(): string } | number | null | undefined;

/**
 * The saved shape an activity edit starts from. Structural, so it accepts the Prisma record with its
 * relations (`getActivityForEdit`) and plain test fixtures alike.
 */
export type EditableActivity = {
  id: string;
  updatedAt: Date;
  babyId: string;
  occurredAt: Date;
  startedAt?: Date | null;
  endedAt?: Date | null;
  notes?: string | null;
  feeding?: { mode?: string | null; amount?: NumberLike; unit?: string | null; side?: string | null; bottleType?: string | null; food?: string | null; leftSeconds?: number | null; rightSeconds?: number | null } | null;
  diaper?: { kind?: string | null; color?: string | null; consistency?: string | null; rashConcern?: boolean | null; condition?: string | null; blowout?: boolean | null; creamApplied?: boolean | null } | null;
  sleep?: { sleepType?: string | null; location?: string | null; quality?: string | null } | null;
  pumping?: { amount?: NumberLike; leftAmount?: NumberLike; rightAmount?: NumberLike; unit?: string | null; inventoryAction?: string | null } | null;
  medicine?: { name?: string | null; dose?: NumberLike; unit?: string | null } | null;
  supplement?: { name?: string | null; dose?: NumberLike; unit?: string | null } | null;
  measurement?: { weight?: NumberLike; weightUnit?: string | null; length?: NumberLike; lengthUnit?: string | null; headCircumference?: NumberLike; headUnit?: string | null; temperature?: NumberLike; temperatureUnit?: string | null; measurementType?: string | null } | null;
  milestone?: { title?: string | null; category?: string | null } | null;
  note?: { text?: string | null; category?: string | null } | null;
  bath?: { bathType?: string | null; products?: string | null; waterTemp?: string | null } | null;
  play?: { activityName?: string | null; location?: string | null; intensity?: string | null } | null;
  mood?: { mood?: string | null; intensity?: number | null; context?: string | null } | null;
  vaccine?: { name?: string | null; dose?: string | null; lot?: string | null; provider?: string | null; dueDate?: Date | null; documentUrl?: string | null } | null;
  milkInventory?: { action?: string | null; amount?: NumberLike; unit?: string | null; storage?: string | null; label?: string | null } | null;
};

function localValue(date: Date | null | undefined, timeZone: string) {
  if (!date) return "";
  return dateTimeInputValue(date, timeZone);
}

/**
 * Maps a saved activity onto the field names ActivityForm submits, so reopening an activity shows exactly
 * what was saved. Field names that several types share (name, dose, unit, location, intensity, category)
 * come from whichever type's record exists; an activity has exactly one.
 */
export function activityEditInitial(activity: EditableActivity, timeZone: string) {
  return {
    id: activity.id,
    updatedAt: activity.updatedAt.toISOString(),
    babyId: activity.babyId,
    occurredAt: localValue(activity.occurredAt, timeZone),
    startedAt: localValue(activity.startedAt, timeZone),
    endedAt: localValue(activity.endedAt, timeZone),
    notes: activity.notes,
    mode: activity.feeding?.mode,
    amount: activity.feeding?.amount?.toString() ?? activity.pumping?.amount?.toString() ?? activity.milkInventory?.amount?.toString(),
    unit: activity.feeding?.unit ?? activity.pumping?.unit ?? activity.medicine?.unit ?? activity.supplement?.unit ?? activity.milkInventory?.unit,
    side: activity.feeding?.side,
    bottleType: activity.feeding?.bottleType,
    food: activity.feeding?.food,
    leftSeconds: activity.feeding?.leftSeconds,
    rightSeconds: activity.feeding?.rightSeconds,
    kind: activity.diaper?.kind,
    color: activity.diaper?.color,
    consistency: activity.diaper?.consistency,
    rashConcern: activity.diaper?.rashConcern,
    condition: activity.diaper?.condition,
    blowout: activity.diaper?.blowout,
    creamApplied: activity.diaper?.creamApplied,
    sleepType: activity.sleep?.sleepType,
    location: activity.sleep?.location ?? activity.play?.location,
    quality: activity.sleep?.quality,
    leftAmount: activity.pumping?.leftAmount?.toString(),
    rightAmount: activity.pumping?.rightAmount?.toString(),
    inventoryAction: activity.pumping?.inventoryAction,
    name: activity.medicine?.name ?? activity.supplement?.name ?? activity.vaccine?.name,
    dose: activity.medicine?.dose?.toString() ?? activity.supplement?.dose?.toString() ?? activity.vaccine?.dose,
    weight: activity.measurement?.weight?.toString(),
    weightUnit: activity.measurement?.weightUnit,
    length: activity.measurement?.length?.toString(),
    lengthUnit: activity.measurement?.lengthUnit,
    headCircumference: activity.measurement?.headCircumference?.toString(),
    headUnit: activity.measurement?.headUnit,
    temperature: activity.measurement?.temperature?.toString(),
    temperatureUnit: activity.measurement?.temperatureUnit,
    measurementType: activity.measurement?.measurementType,
    title: activity.milestone?.title,
    category: activity.milestone?.category ?? activity.note?.category,
    text: activity.note?.text,
    bathType: activity.bath?.bathType,
    products: activity.bath?.products,
    waterTemp: activity.bath?.waterTemp,
    activityName: activity.play?.activityName,
    intensity: activity.play?.intensity ?? activity.mood?.intensity,
    mood: activity.mood?.mood,
    context: activity.mood?.context,
    lot: activity.vaccine?.lot,
    provider: activity.vaccine?.provider,
    // A due date is a calendar date stored as midnight UTC, so it is read back in UTC.
    dueDate: activity.vaccine?.dueDate ? activity.vaccine.dueDate.toISOString().slice(0, 10) : "",
    documentUrl: activity.vaccine?.documentUrl,
    action: activity.milkInventory?.action,
    storage: activity.milkInventory?.storage,
    label: activity.milkInventory?.label
  };
}

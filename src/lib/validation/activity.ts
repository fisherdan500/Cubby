import { z } from "zod";

const nullableNumber = z.union([z.coerce.number().nonnegative(), z.literal("").transform(() => undefined)]).optional();
const optionalString = z.string().trim().optional().transform((value) => value || undefined);
const dateString = z.string().min(1);

const common = z.object({
  babyId: z.string().min(1),
  occurredAt: dateString,
  startedAt: z.string().optional(),
  endedAt: z.string().optional(),
  timezone: z.string().min(1).default("UTC"),
  notes: optionalString,
  activeTimer: z.coerce.boolean().default(false)
});

export const activityCreateSchema = z.discriminatedUnion("type", [
    common.extend({
      type: z.literal("feeding"),
      mode: z.enum(["breast", "bottle", "formula", "solids"]),
      amount: nullableNumber,
      unit: optionalString,
      side: z.enum(["left", "right", "both"]).optional().or(z.literal("").transform(() => undefined)),
      bottleType: optionalString,
      food: optionalString,
      leftSeconds: nullableNumber,
      rightSeconds: nullableNumber
    }),
    common.extend({
      type: z.literal("diaper"),
      kind: z.enum(["wet", "dirty", "mixed", "dry"]),
      color: optionalString,
      consistency: optionalString,
      rashConcern: z.coerce.boolean().default(false),
      condition: optionalString,
      blowout: z.coerce.boolean().default(false),
      creamApplied: z.coerce.boolean().default(false)
    }),
    common.extend({
      type: z.literal("sleep"),
      sleepType: optionalString,
      location: optionalString,
      quality: optionalString
    }),
    common.extend({
      type: z.literal("pumping"),
      amount: nullableNumber,
      leftAmount: nullableNumber,
      rightAmount: nullableNumber,
      unit: optionalString,
      inventoryAction: z.enum(["stored", "fed", "discarded", "thawed", "donated", "expired"]).optional().or(z.literal("").transform(() => undefined))
    }),
    common.extend({
      type: z.literal("medicine"),
      name: z.string().trim().min(1),
      dose: nullableNumber,
      unit: optionalString,
      contactId: optionalString
    }),
    common.extend({
      type: z.literal("measurement"),
      weight: nullableNumber,
      weightUnit: optionalString,
      length: nullableNumber,
      lengthUnit: optionalString,
      headCircumference: nullableNumber,
      headUnit: optionalString,
      temperature: nullableNumber,
      temperatureUnit: optionalString,
      measurementType: optionalString
    }),
    common.extend({
      type: z.literal("milestone"),
      title: z.string().trim().min(1),
      category: optionalString
    }),
    common.extend({
      type: z.literal("note"),
      text: z.string().trim().min(1),
      category: optionalString
    }),
    common.extend({
      type: z.literal("bath"),
      bathType: optionalString,
      products: optionalString,
      waterTemp: optionalString
    }),
    common.extend({
      type: z.literal("play"),
      activityName: optionalString,
      location: optionalString,
      intensity: optionalString
    }),
    common.extend({
      type: z.literal("mood"),
      mood: z.string().trim().min(1),
      intensity: z.coerce.number().int().min(1).max(5).optional().or(z.literal("").transform(() => undefined)),
      context: optionalString
    }),
    common.extend({
      type: z.literal("supplement"),
      name: z.string().trim().min(1),
      dose: nullableNumber,
      unit: optionalString
    }),
    common.extend({
      type: z.literal("vaccine"),
      name: z.string().trim().min(1),
      dose: optionalString,
      lot: optionalString,
      provider: optionalString,
      dueDate: optionalString,
      documentUrl: optionalString
    }),
    common.extend({
      type: z.literal("milk_inventory"),
      action: z.enum(["stored", "fed", "discarded", "thawed", "donated", "expired"]),
      amount: nullableNumber,
      unit: optionalString,
      storage: optionalString,
      label: optionalString
    })
  ]);

export const activityUpdateSchema = activityCreateSchema.and(z.object({
  id: z.string().min(1)
}));

export type ActivityCreateInput = z.infer<typeof activityCreateSchema>;

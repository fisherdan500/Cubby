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
  notes: optionalString
});

export const activityCreateSchema = z.discriminatedUnion("type", [
    common.extend({
      type: z.literal("feeding"),
      mode: z.enum(["breast", "bottle", "formula", "solids"]),
      amount: nullableNumber,
      unit: optionalString,
      side: z.enum(["left", "right", "both"]).optional().or(z.literal("").transform(() => undefined))
    }),
    common.extend({
      type: z.literal("diaper"),
      kind: z.enum(["wet", "dirty", "mixed", "dry"]),
      color: optionalString,
      consistency: optionalString,
      rashConcern: z.coerce.boolean().default(false)
    }),
    common.extend({
      type: z.literal("sleep"),
      activeTimer: z.coerce.boolean().default(false)
    }),
    common.extend({
      type: z.literal("pumping"),
      amount: nullableNumber,
      leftAmount: nullableNumber,
      rightAmount: nullableNumber,
      unit: optionalString
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
      headUnit: optionalString
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
    })
  ]);

export const activityUpdateSchema = activityCreateSchema.and(z.object({
  id: z.string().min(1)
}));

export type ActivityCreateInput = z.infer<typeof activityCreateSchema>;

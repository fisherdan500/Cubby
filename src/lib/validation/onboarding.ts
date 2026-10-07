import { z } from "zod";

export const onboardingSchema = z.object({
  mode: z.undefined().optional(),
  householdName: z.string().trim().min(1).max(80),
  babyName: z.string().trim().min(1).max(80),
  birthDate: z.string().optional()
});

export const restoreOnboardingSchema = z.object({
  mode: z.literal("restore"),
  householdName: z.string().trim().min(1).max(80)
}).strict();

export const onboardingRequestSchema = z.union([restoreOnboardingSchema, onboardingSchema]);

export const babySchema = z.object({
  name: z.string().trim().min(1).max(80),
  birthDate: z.string().optional(),
  notes: z.string().trim().optional(),
  feedingWarningMinutes: z.coerce.number().int().positive().optional(),
  diaperWarningMinutes: z.coerce.number().int().positive().optional(),
  sleepWarningMinutes: z.coerce.number().int().positive().optional()
});

/**
 * Editing an existing baby. Every field is optional so a caller may change one thing without
 * resending the rest, but an empty name is still refused: `.optional()` permits absence, not blankness.
 */
export const babyUpdateSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  birthDate: z.string().optional(),
  notes: z.string().trim().max(2000).optional(),
  feedingWarningMinutes: z.coerce.number().int().positive().nullable().optional(),
  diaperWarningMinutes: z.coerce.number().int().positive().nullable().optional(),
  sleepWarningMinutes: z.coerce.number().int().positive().nullable().optional()
}).strict();

/**
 * What must be typed to delete a baby. The phrase includes the baby's own name so the action cannot
 * be completed by muscle memory, and the server compares it against the name it reads from the
 * database - never a name supplied alongside the confirmation.
 */
export function babyDeleteConfirmationPhrase(name: string) {
  return `Yes Delete Baby ${name}`;
}

export const babyDeleteSchema = z.object({
  confirmation: z.string()
}).passthrough();

export const inviteSchema = z.object({
  email: z.string().trim().email(),
  role: z.enum(["admin", "parent", "caretaker", "read_only"]),
  expiresInHours: z.preprocess(
    (value) => value === "" || value === null ? undefined : value,
    z.coerce.number().int().optional()
  )
});

export const bulkInviteRevokeSchema = z.object({
  acknowledgement: z.string()
}).strict();

export const memberRoleSchema = z.object({
  role: z.enum(["admin", "parent", "caretaker", "read_only"])
});

import { z } from "zod";

export const onboardingSchema = z.object({
  householdName: z.string().trim().min(1).max(80),
  babyName: z.string().trim().min(1).max(80),
  birthDate: z.string().optional()
});

export const babySchema = z.object({
  name: z.string().trim().min(1).max(80),
  birthDate: z.string().optional(),
  notes: z.string().trim().optional(),
  feedingWarningMinutes: z.coerce.number().int().positive().optional(),
  diaperWarningMinutes: z.coerce.number().int().positive().optional(),
  sleepWarningMinutes: z.coerce.number().int().positive().optional()
});

export const inviteSchema = z.object({
  email: z.string().trim().email(),
  role: z.enum(["admin", "parent", "caretaker", "read_only"])
});

export const memberRoleSchema = z.object({
  role: z.enum(["admin", "parent", "caretaker", "read_only"])
});

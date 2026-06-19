import { z } from "zod";

export const onboardingSchema = z.object({
  householdName: z.string().trim().min(1).max(80),
  babyName: z.string().trim().min(1).max(80),
  birthDate: z.string().optional(),
  timezone: z.string().min(1).default("UTC")
});

export const babySchema = z.object({
  name: z.string().trim().min(1).max(80),
  birthDate: z.string().optional(),
  timezone: z.string().min(1).default("UTC"),
  notes: z.string().trim().optional()
});

export const inviteSchema = z.object({
  email: z.string().trim().email(),
  role: z.enum(["parent", "caretaker", "read_only"])
});

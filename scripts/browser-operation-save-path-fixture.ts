import { afterAll, expect, it } from "vitest";
import { hashPassword } from "better-auth/crypto";
import { writeFile } from "node:fs/promises";
import { HouseholdRole } from "@prisma/client";

import { prisma } from "@/lib/db/prisma";

const handoffFile = process.env.REHEARSAL_HANDOFF_FILE;
const password = process.env.REHEARSAL_APP_PASSWORD;
if (!handoffFile || !password) throw new Error("browser_operation_save_path_fixture_environment_not_set");

const marker = {
  userId: "sp_usr_1a2b3c",
  accountId: "sp_acc_4d5e6f",
  householdId: "sp_hh_7a8b9c",
  memberId: "sp_mem_0d1e2f",
  babyId: "sp_bby_3a4b5c",
  email: "save-path-owner@rehearsal.invalid",
  householdName: "Save Path Rehearsal Nursery"
};

afterAll(async () => prisma.$disconnect());

it("seeds the fixed browser-operation save-path fixture", async () => {
  await prisma.user.create({ data: { id: marker.userId, name: "Save Path Owner", email: marker.email, emailVerified: true } });
  await prisma.account.create({ data: {
    id: marker.accountId, accountId: marker.userId, providerId: "credential", userId: marker.userId,
    password: await hashPassword(password)
  } });
  await prisma.household.create({ data: { id: marker.householdId, name: marker.householdName, createdByUserId: marker.userId } });
  await prisma.householdMember.create({ data: {
    id: marker.memberId, householdId: marker.householdId, userId: marker.userId,
    role: HouseholdRole.owner, displayName: "Save path owner"
  } });
  await prisma.baby.create({ data: {
    id: marker.babyId, householdId: marker.householdId, name: "Save Path Baby",
    birthDate: new Date("2026-01-10T00:00:00.000Z"), timezone: "Etc/UTC"
  } });
  await writeFile(handoffFile, JSON.stringify(marker), { mode: 0o600, flag: "wx" });
  expect(await prisma.baby.count({ where: { id: marker.babyId } })).toBe(1);
});

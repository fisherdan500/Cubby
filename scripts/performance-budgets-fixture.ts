import { afterAll, expect, it } from "vitest";
import { hashPassword } from "better-auth/crypto";
import { writeFile } from "node:fs/promises";
import { HouseholdRole } from "@prisma/client";

import { prisma } from "@/lib/db/prisma";
import { performanceDataset } from "../scripts/performance-dataset";

const handoffFile = process.env.REHEARSAL_HANDOFF_FILE;
const password = process.env.REHEARSAL_APP_PASSWORD;
const years = Number(process.env.REHEARSAL_DATASET_YEARS);
if (!handoffFile || !password || (years !== 1 && years !== 5)) throw new Error("performance_budgets_fixture_environment_not_set");

const marker = {
  userId: "pf_usr_1a2b3c",
  accountId: "pf_acc_4d5e6f",
  householdId: "pf_hh_7a8b9c",
  memberId: "pf_mem_0d1e2f",
  babyIds: ["pf_bby_first01", "pf_bby_second1"],
  email: "performance-owner@rehearsal.invalid",
  householdName: "Performance Rehearsal Nursery"
};

// The dataset's last day is fixed so timings never depend on the wall clock. It is not "today": the
// probes read it back from the handoff and pin every dated page to it (the household zone is Etc/UTC in
// the rehearsal compose file, so this UTC day is the household's day).
const endDate = new Date("2026-09-19T00:00:00.000Z");
const chunkSize = 2_000;

async function insertChunked<T>(rows: T[], insert: (chunk: T[]) => Promise<unknown>) {
  for (let index = 0; index < rows.length; index += chunkSize) await insert(rows.slice(index, index + chunkSize));
}

afterAll(async () => prisma.$disconnect());

it("seeds the deterministic performance dataset", async () => {
  await prisma.user.create({ data: { id: marker.userId, name: "Performance Owner", email: marker.email, emailVerified: true } });
  await prisma.account.create({ data: {
    id: marker.accountId, accountId: marker.userId, providerId: "credential", userId: marker.userId, password: await hashPassword(password)
  } });
  await prisma.household.create({ data: { id: marker.householdId, name: marker.householdName, createdByUserId: marker.userId } });
  await prisma.householdMember.create({ data: {
    id: marker.memberId, householdId: marker.householdId, userId: marker.userId, role: HouseholdRole.owner, displayName: "Performance owner"
  } });
  for (const [index, babyId] of marker.babyIds.entries()) {
    await prisma.baby.create({ data: {
      id: babyId,
      householdId: marker.householdId,
      name: index === 0 ? "Performance Baby One" : "Performance Baby Two",
      birthDate: new Date(index === 0 ? "2021-09-19T00:00:00.000Z" : "2023-09-19T00:00:00.000Z"),
      timezone: "Etc/UTC"
    } });
  }

  const dataset = performanceDataset({
    years: years as 1 | 5,
    householdId: marker.householdId,
    memberId: marker.memberId,
    babyIds: marker.babyIds,
    endDate
  });

  await insertChunked(dataset.activities, (chunk) => prisma.activityLog.createMany({ data: chunk as never }));
  await insertChunked(dataset.feedings, (chunk) => prisma.feedingLog.createMany({ data: chunk as never }));
  await insertChunked(dataset.diapers, (chunk) => prisma.diaperLog.createMany({ data: chunk as never }));
  await insertChunked(dataset.sleeps, (chunk) => prisma.sleepLog.createMany({ data: chunk as never }));
  await insertChunked(dataset.notes, (chunk) => prisma.noteLog.createMany({ data: chunk as never }));

  const stored = await prisma.activityLog.count({ where: { householdId: marker.householdId } });
  expect(stored).toBe(dataset.counts.activities);

  await writeFile(
    handoffFile,
    JSON.stringify({ ...marker, years, endDate: endDate.toISOString(), counts: dataset.counts }),
    { mode: 0o600, flag: "wx" }
  );
});

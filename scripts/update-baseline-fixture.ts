import { afterAll, expect, it } from "vitest";
import { hashPassword } from "better-auth/crypto";
import { readFile, writeFile } from "node:fs/promises";
import { ActivityType, HouseholdRole, TimerState } from "@prisma/client";

import { prisma } from "@/lib/db/prisma";

const handoffFile = process.env.REHEARSAL_HANDOFF_FILE;
const password = process.env.REHEARSAL_APP_PASSWORD;
const phase = process.env.UPDATE_BASELINE_PHASE;
if (!handoffFile || !password || !["seed", "verify"].includes(phase ?? "")) {
  throw new Error("update_baseline_fixture_environment_not_set");
}

const marker = {
  userId: "upd_usr_7f2c9a",
  accountId: "upd_acc_0d6e31",
  sessionId: "upd_ses_8b4a20",
  householdId: "upd_hh_3e91bd",
  memberId: "upd_mem_5c7a14",
  babyId: "upd_bby_2a8f60",
  timerId: "upd_tmr_4d19ce",
  playId: "upd_ply_6e30b8",
  runningTimerId: "upd_tmr_run_21d4f0",
  runningPlayId: "upd_ply_run_6ac918",
  stoppedTimerId: "upd_tmr_stop_f012a7",
  stoppedPlayId: "upd_ply_stop_b5d023",
  email: "baseline-owner@rehearsal.invalid",
  householdName: "Baseline Migration Nursery",
  startedAt: "2026-07-14T18:00:00.000Z",
  pausedAt: "2026-07-14T18:12:00.000Z",
  pausedSeconds: 180,
  runningStartedAt: "2026-07-14T19:00:00.000Z",
  stoppedStartedAt: "2026-07-14T16:00:00.000Z",
  stoppedAt: "2026-07-14T16:10:00.000Z",
  stoppedDurationSeconds: 480,
  stoppedPausedSeconds: 120
};

afterAll(async () => prisma.$disconnect());

it("seeds or verifies the fixed-baseline update fixture", async () => {
  if (phase === "seed") {
    await prisma.user.create({ data: { id: marker.userId, name: "Baseline Owner", email: marker.email, emailVerified: true } });
    await prisma.account.create({ data: {
      id: marker.accountId, accountId: marker.userId, providerId: "credential", userId: marker.userId,
      password: await hashPassword(password)
    } });
    await prisma.session.create({ data: {
      id: marker.sessionId, token: "disposable-baseline-session-token", userId: marker.userId,
      expiresAt: new Date("2030-07-14T18:00:00.000Z"), userAgent: "update-rehearsal"
    } });
    await prisma.household.create({ data: { id: marker.householdId, name: marker.householdName, createdByUserId: marker.userId } });
    await prisma.householdMember.create({ data: {
      id: marker.memberId, householdId: marker.householdId, userId: marker.userId,
      role: HouseholdRole.owner, displayName: "Baseline owner"
    } });
    await prisma.householdSettings.create({ data: {
      householdId: marker.householdId, activityOrder: ["play", "sleep"],
      unitPreferences: { volume: "mL", weight: "kg" }, dateFormat: "yyyy-MM-dd",
      timeFormat: "HH:mm", nurseryModeEnabled: true, accentTheme: "sage"
    } });
    await prisma.baby.create({ data: {
      id: marker.babyId, householdId: marker.householdId, name: "Baseline Baby",
      birthDate: new Date("2026-01-10T00:00:00.000Z"), timezone: "America/New_York",
      notes: "fixed update rehearsal marker", feedingWarningMinutes: 180
    } });
    await prisma.activityLog.create({ data: {
      id: marker.timerId, householdId: marker.householdId, babyId: marker.babyId,
      actorMemberId: marker.memberId, type: ActivityType.play,
      occurredAt: new Date(marker.startedAt), startedAt: new Date(marker.startedAt),
      timezone: "America/New_York", notes: "baseline paused timer",
      timerState: TimerState.paused, pausedAt: new Date(marker.pausedAt), pausedSeconds: marker.pausedSeconds,
      play: { create: { id: marker.playId, activityName: "Baseline floor time", location: "Nursery" } }
    } });
    await prisma.activityLog.create({ data: {
      id: marker.runningTimerId, householdId: marker.householdId, babyId: marker.babyId,
      actorMemberId: marker.memberId, type: ActivityType.play,
      occurredAt: new Date(marker.runningStartedAt), startedAt: new Date(marker.runningStartedAt),
      timezone: "America/New_York", notes: "baseline running timer",
      timerState: TimerState.running,
      play: { create: { id: marker.runningPlayId, activityName: "Baseline active play", location: "Nursery" } }
    } });
    await prisma.activityLog.create({ data: {
      id: marker.stoppedTimerId, householdId: marker.householdId, babyId: marker.babyId,
      actorMemberId: marker.memberId, type: ActivityType.play,
      occurredAt: new Date(marker.stoppedStartedAt), startedAt: new Date(marker.stoppedStartedAt),
      endedAt: new Date(marker.stoppedAt), durationSeconds: marker.stoppedDurationSeconds,
      timezone: "America/New_York", notes: "baseline stopped timer",
      timerState: TimerState.stopped, pausedSeconds: marker.stoppedPausedSeconds,
      play: { create: { id: marker.stoppedPlayId, activityName: "Baseline completed play", location: "Nursery" } }
    } });
    await writeFile(handoffFile, JSON.stringify(marker), { mode: 0o600, flag: "wx" });
    return;
  }

  const expected = JSON.parse(await readFile(handoffFile, "utf8")) as typeof marker;
  const migrations = await prisma.$queryRaw<Array<{ migration_name: string; finished_at: Date | null; rolled_back_at: Date | null }>>`
    SELECT migration_name, finished_at, rolled_back_at FROM "_prisma_migrations" ORDER BY migration_name
  `;
  const committed = (process.env.UPDATE_COMMITTED_MIGRATIONS ?? "").split(",").filter(Boolean);
  expect(migrations.map((migration) => migration.migration_name)).toEqual(committed);
  expect(migrations.every((migration) => migration.finished_at !== null && migration.rolled_back_at === null)).toBe(true);
  expect(await prisma.user.findUniqueOrThrow({ where: { id: expected.userId }, select: { email: true } })).toEqual({ email: expected.email });
  expect(await prisma.account.count({ where: { id: expected.accountId, userId: expected.userId } })).toBe(1);
  expect(await prisma.session.count({ where: { id: expected.sessionId, userId: expected.userId } })).toBe(1);
  expect(await prisma.household.findUniqueOrThrow({ where: { id: expected.householdId }, select: { name: true } })).toEqual({ name: expected.householdName });
  expect(await prisma.householdMember.count({ where: { id: expected.memberId, householdId: expected.householdId } })).toBe(1);
  expect(await prisma.baby.count({ where: { id: expected.babyId, householdId: expected.householdId } })).toBe(1);
  expect(await prisma.activityLog.findUniqueOrThrow({
    where: { id: expected.timerId },
    select: { startedAt: true, pausedAt: true, pausedSeconds: true, timerState: true }
  })).toEqual({
    startedAt: new Date(expected.startedAt), pausedAt: new Date(expected.pausedAt),
    pausedSeconds: expected.pausedSeconds, timerState: TimerState.paused
  });
  expect(await prisma.activityLog.findUniqueOrThrow({
    where: { id: expected.runningTimerId },
    select: { startedAt: true, endedAt: true, durationSeconds: true, timerState: true }
  })).toEqual({
    startedAt: new Date(expected.runningStartedAt), endedAt: null,
    durationSeconds: null, timerState: TimerState.running
  });
  expect(await prisma.activityLog.findUniqueOrThrow({
    where: { id: expected.stoppedTimerId },
    select: { startedAt: true, endedAt: true, durationSeconds: true, pausedSeconds: true, timerState: true }
  })).toEqual({
    startedAt: new Date(expected.stoppedStartedAt), endedAt: new Date(expected.stoppedAt),
    durationSeconds: expected.stoppedDurationSeconds,
    pausedSeconds: expected.stoppedPausedSeconds,
    timerState: TimerState.stopped
  });
});

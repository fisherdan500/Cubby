// Executed only inside the uniquely scoped disposable image, over stdin; no host database client.
import { PrismaClient } from "@prisma/client";
import { hashPassword } from "better-auth/crypto";
const url = process.env.REHEARSAL_SEED_URL;
const password = process.env.REHEARSAL_APP_PASSWORD;
if (!url || new URL(url).hostname !== "postgres" || !password) throw new Error("freshness_fixture_scope");
const prisma = new PrismaClient({ datasourceUrl: url });
try {
  if (await prisma.user.count() !== 0 || await prisma.household.count() !== 0) throw new Error("freshness_fixture_not_empty");
  for (const suffix of ["own", "foreign"]) {
    const userId = `fresh-user-${suffix}`;
    const householdId = `fresh-household-${suffix}`;
    const memberId = `fresh-member-${suffix}`;
    const babyId = `fresh-baby-${suffix}`;
    await prisma.user.create({ data: { id: userId, name: suffix === "foreign" ? "FOREIGN_FRESHNESS_SENTINEL" : "Fixture own", email: `${suffix}@freshness.invalid`, emailVerified: true } });
    await prisma.account.create({ data: { id: `fresh-account-${suffix}`, userId, accountId: userId, providerId: "credential", password: await hashPassword(password) } });
    await prisma.household.create({ data: { id: householdId, name: suffix === "foreign" ? "FOREIGN_FRESHNESS_SENTINEL" : "Fixture own", createdByUserId: userId } });
    await prisma.householdMember.create({ data: { id: memberId, householdId, userId, displayName: suffix === "foreign" ? "FOREIGN_FRESHNESS_SENTINEL" : "Fixture own", role: "owner" } });
    await prisma.baby.create({ data: { id: babyId, householdId, name: suffix === "foreign" ? "FOREIGN_FRESHNESS_SENTINEL" : "Freshness baby", birthDate: new Date("2026-01-01T00:00:00Z"), timezone: "Etc/UTC" } });
  }
  const foreign = { householdId: 'fresh-household-foreign', babyId: 'fresh-baby-foreign' };
  const now = new Date();
  await prisma.activityLog.create({ data: { ...foreign, actorMemberId: 'fresh-member-foreign', type: 'note', occurredAt: now, timezone: 'Etc/UTC', note: { create: { text: 'FOREIGN_FRESHNESS_SENTINEL' } } } });
  await prisma.activityLog.create({ data: { ...foreign, actorMemberId: 'fresh-member-foreign', type: 'sleep', occurredAt: now, startedAt: now, timezone: 'Etc/UTC', timerState: 'running', sleep: { create: {} } } });
  await prisma.feedPost.create({ data: { ...foreign, authorMemberId: 'fresh-member-foreign', body: 'FOREIGN_FRESHNESS_SENTINEL' } });
  await prisma.feedPost.create({ data: { householdId: foreign.householdId, babyId: null, authorMemberId: 'fresh-member-foreign', body: 'FOREIGN_FRESHNESS_SENTINEL' } });
  await prisma.calendarEvent.create({ data: { householdId: foreign.householdId, title: 'FOREIGN_FRESHNESS_SENTINEL', startTime: now } });
} finally { await prisma.$disconnect(); }

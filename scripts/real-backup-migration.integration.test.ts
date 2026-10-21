/**
 * The migration the User actually described: carry a REAL household backup, taken from their own
 * running instance, into a brand-new Cubby whose household is fresh.
 *
 * Every other backup rehearsal builds its own payload from fixtures, so the shapes it restores are
 * the shapes the code already expects. This one reads an archive the User's instance genuinely
 * produced - 2,825 activities, 2 babies, real timers, real corrections - and is therefore the only
 * test here that can meet a shape nobody anticipated. That is precisely the class of failure
 * `Something went wrong` reports: every error the restore service THROWS is mapped to a specific
 * message in http.ts, so the generic fallback means something ELSE threw - a database constraint, a
 * deferred trigger, or a Prisma error - which no fixture-built payload has ever produced.
 *
 * SCOPE, STATED PLAINLY. This exercises the restore SERVICE against a real database with the
 * household context mocked, like its sibling rehearsals. It does NOT go through the HTTP route, so
 * the route's parsing, headers and upload limits are untested here. What it adds over the existing
 * matrix is the one thing a fixture cannot: real data.
 *
 * The backup file is OPTIONAL. Point REAL_BACKUP_FILE at one to run; without it the suite skips
 * rather than failing, so CI - which has no household data - stays green. No content from the file
 * is ever printed: only counts, and only counts that came back out of the database.
 */
import { afterAll, describe, expect, it, vi } from "vitest";
import { HouseholdRole } from "@prisma/client";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";

const auth = vi.hoisted(() => ({
  context: null as null | { userId: string; householdId: string; memberId: string; role: HouseholdRole },
  user: null as null | { id: string; name: string; email: string; emailVerified: boolean },
  sessionIds: new Map<string, string>()
}));

vi.mock("@/server/auth/context", () => ({
  getEffectiveHouseholdContext: vi.fn(async () => {
    if (!auth.context) throw new Error("rehearsal_context_not_set");
    return auth.context;
  }),
  getHouseholdContext: vi.fn(async () => {
    if (!auth.context) throw new Error("rehearsal_context_not_set");
    return auth.context;
  }),
  requirePermission: (context: { role: HouseholdRole }) => {
    if (context.role !== HouseholdRole.owner) throw new Error("forbidden");
  }
}));

vi.mock("@/server/auth/session", () => ({
  getSession: vi.fn(async () => {
    if (!auth.context) return null;
    const sessionId = auth.sessionIds.get(auth.context.userId);
    if (!sessionId) return null;
    return { user: { id: auth.context.userId }, session: { id: sessionId } };
  }),
  requireUser: vi.fn(async () => {
    if (!auth.user) throw new Error("rehearsal_user_not_set");
    return auth.user;
  })
}));

import { prisma } from "@/lib/db/prisma";
import { previewBackupJson, restoreBackupJson } from "@/server/services/backups";
import { refreshHouseholdAuditCheckpoint } from "@/server/services/audit-checkpoints";

const REAL_BACKUP_FILE = process.env.REAL_BACKUP_FILE;
const available = Boolean(REAL_BACKUP_FILE && existsSync(REAL_BACKUP_FILE));

function mail(slug: string) {
  return `${slug}-${randomBytes(4).toString("hex")}@rehearsal.invalid`;
}

/** A brand-new Cubby's first household: one owner, nothing else. The migration target. */
async function seedFreshHousehold(slug: string, name: string) {
  const ownerUser = await prisma.user.create({
    data: { name: `${slug} owner`, email: mail(`${slug}-owner`), emailVerified: true }
  });
  const household = await prisma.household.create({
    data: { name, createdByUserId: ownerUser.id }
  });
  const ownerMember = await prisma.householdMember.create({
    data: { householdId: household.id, userId: ownerUser.id, role: HouseholdRole.owner, displayName: `${slug} owner` }
  });
  const session = await prisma.session.create({
    data: {
      token: `${slug}-owner-token-${randomBytes(4).toString("hex")}`,
      expiresAt: new Date("2099-01-01T00:00:00.000Z"),
      userId: ownerUser.id
    }
  });
  auth.sessionIds.set(ownerUser.id, session.id);
  await refreshHouseholdAuditCheckpoint(household.id, prisma);

  auth.user = { id: ownerUser.id, name: ownerUser.name, email: ownerUser.email, emailVerified: true };
  auth.context = {
    userId: ownerUser.id,
    householdId: household.id,
    memberId: ownerMember.id,
    role: HouseholdRole.owner
  };
  return { ownerUser, household, ownerMember };
}

type Envelope = {
  version: number;
  checksum: string;
  payload: {
    activities?: unknown[];
    babies?: unknown[];
    contacts?: unknown[];
    calendarEvents?: unknown[];
    reminders?: unknown[];
    catalogs?: unknown[];
    household?: unknown;
    settings?: unknown;
  };
};

function loadRealBackup(): Envelope {
  return JSON.parse(readFileSync(REAL_BACKUP_FILE!, "utf8")) as Envelope;
}

afterAll(async () => {
  await prisma.$disconnect();
});

describe.skipIf(!available)("a real household backup restored into a brand-new Cubby", () => {
  it("passes preview with its checksum verified", async () => {
    await seedFreshHousehold("real-preview", "Real Preview");
    const backup = loadRealBackup();
    await expect(previewBackupJson(backup)).resolves.toMatchObject({ checksumVerified: true });
  });

  it("restores completely, and every activity arrives", async () => {
    const { household } = await seedFreshHousehold("real-restore", "Real Restore");
    const backup = loadRealBackup();
    const expectedActivities = backup.payload.activities?.length ?? 0;
    const expectedBabies = backup.payload.babies?.length ?? 0;

    // The assertion that matters: this must not throw. A throw here IS the User's
    // `Something went wrong`, and whatever it names is the defect.
    await restoreBackupJson(backup, { confirmation: "Real Restore", previewChecksum: backup.checksum });

    const [activities, babies] = await Promise.all([
      prisma.activityLog.count({ where: { householdId: household.id, deletedAt: null } }),
      prisma.baby.count({ where: { householdId: household.id, deletedAt: null } })
    ]);
    expect(activities).toBe(expectedActivities);
    expect(babies).toBe(expectedBabies);
  });

  it("refuses a second restore into the household it just filled", async () => {
    const { household } = await seedFreshHousehold("real-twice", "Real Twice");
    const backup = loadRealBackup();
    await restoreBackupJson(backup, { confirmation: "Real Twice", previewChecksum: backup.checksum });

    // The restore adopts the backup's own household name, and the confirmation is matched against
    // the CURRENT name (backups.ts:724) BEFORE freshness is checked (backups.ts:734). So a second
    // attempt has to type the name the household now has, or it fails on confirmation first and
    // never reaches the guard this test is about.
    const renamed = await prisma.household.findUniqueOrThrow({ where: { id: household.id } });

    // Exactly the User's same-machine case: the target is no longer fresh.
    await expect(
      restoreBackupJson(backup, { confirmation: renamed.name, previewChecksum: backup.checksum })
    ).rejects.toThrow("backup_target_not_empty");

    // ...and the first restore's data is untouched by the refusal.
    const activities = await prisma.activityLog.count({ where: { householdId: household.id, deletedAt: null } });
    expect(activities).toBe(backup.payload.activities?.length ?? 0);
  });
});

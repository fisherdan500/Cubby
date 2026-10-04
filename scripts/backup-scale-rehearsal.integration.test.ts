/**
 * A restore at the size a real household actually reaches.
 *
 * Every other backup test runs on a handful of entries. A household that has been tracked daily for
 * a couple of years holds thousands, and the restore writes them one awaited round-trip at a time
 * inside a single serializable transaction with a fixed 120-second budget (backups.ts). Whether that
 * budget is adequate is a question about wall-clock time on real hardware, so no amount of
 * small-fixture testing answers it - a Prisma P2024 or P2028 at the three-thousandth row would reach
 * the person as a failed migration, and the only honest way to know is to measure.
 *
 * This file measures. It is deliberately not a pass/fail assertion on a stopwatch: a timing test that
 * fails on a slow CI runner teaches people to ignore it. Instead it asserts CORRECTNESS at scale -
 * every row arrives, nothing is dropped, the transaction commits - and REPORTS the timing with its
 * margin against the real budget, so a regression that doubles the cost is visible in the log even
 * when it still fits.
 *
 * The one hard timing assertion is the budget itself: if a restore of this size cannot finish inside
 * the transaction timeout the product has a defect, not the test.
 */
import { randomBytes } from "node:crypto";
import { HouseholdRole, ActivityType, FeedingKind, DiaperKind, TimerState } from "@prisma/client";
import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";

const auth = {
  context: null as null | { userId: string; householdId: string; memberId: string; role: HouseholdRole },
  sessionIds: new Map<string, string>()
};

vi.mock("@/server/auth/context", () => ({
  getEffectiveHouseholdContext: vi.fn(async () => {
    if (!auth.context) throw new Error("rehearsal_context_not_set");
    return auth.context;
  }),
  // Narrower than production on purpose: the real hasPermission grants backup.manage to owner AND
  // admin (src/domain/roles.ts). Every case here restores as an owner, and the subject is throughput,
  // not the permission table.
  requirePermission: (context: { role: HouseholdRole }) => {
    if (context.role !== HouseholdRole.owner) throw new Error("forbidden");
  }
}));

vi.mock("@/server/auth/session", () => ({
  getSession: vi.fn(async () => {
    if (!auth.context) throw new Error("rehearsal_context_not_set");
    const sessionId = auth.sessionIds.get(auth.context.userId);
    if (!sessionId) throw new Error("rehearsal_session_not_set");
    return { session: { id: sessionId, userId: auth.context.userId }, user: { id: auth.context.userId } };
  })
}));

import { prisma } from "@/lib/db/prisma";
import { exportHouseholdBackupJson, restoreBackupJson, restoreTimeoutForRecords } from "@/server/services/backups";
import { refreshHouseholdAuditCheckpoint } from "@/server/services/audit-checkpoints";

type Envelope = {
  format: "cubby-household-backup";
  version: 2;
  exportedAt: string;
  checksum: string;
  payload: Record<string, any>;
};

/**
 * The budget the restore actually grants a payload this size. Read from production rather than copied,
 * because a copy would keep passing while the real budget shrank underneath it - which is exactly how
 * the original fixed 120-second ceiling went unnoticed until a real household could not be restored.
 */
function budgetFor(records: number) {
  return restoreTimeoutForRecords(records).timeoutMs;
}

/**
 * The shape of a real household after about two years of daily tracking. Taken from an actual
 * install rather than invented, because the question is whether THAT survives, and a round number
 * would be a different question.
 */
const SCALE = {
  activities: Number(process.env.SCALE_ACTIVITIES ?? 3_273),
  babies: 4,
  caregivers: 3,
  feedPosts: 8,
  contacts: 4,
  catalogs: 6,
  calendarEvents: 12,
  reminders: 5
};

const RUN = randomBytes(3).toString("hex");
const mail = (slug: string) => `${slug}-${RUN}@scale.invalid`;

function asOwner(ctx: { userId: string; householdId: string; memberId: string; role: HouseholdRole }) {
  auth.context = ctx;
}

async function seedHousehold(options: { slug: string; name: string; caregivers: number; babies: number }) {
  const ownerUser = await prisma.user.create({
    data: { name: `${options.slug} owner`, email: mail(`${options.slug}-owner`), emailVerified: true }
  });
  const household = await prisma.household.create({
    data: { name: options.name, createdByUserId: ownerUser.id }
  });
  const ownerMember = await prisma.householdMember.create({
    data: { householdId: household.id, userId: ownerUser.id, role: HouseholdRole.owner, displayName: `${options.slug} owner` }
  });
  const session = await prisma.session.create({
    data: {
      token: `${options.slug}-token-${randomBytes(4).toString("hex")}`,
      expiresAt: new Date("2099-01-01T00:00:00.000Z"),
      userId: ownerUser.id
    }
  });
  auth.sessionIds.set(ownerUser.id, session.id);

  // A household cannot receive a restore until its audit chain is verifiable.
  await refreshHouseholdAuditCheckpoint(household.id, prisma);

  const members = [{ user: ownerUser, member: ownerMember }];
  for (let index = 0; index < options.caregivers; index += 1) {
    const user = await prisma.user.create({
      data: { name: `${options.slug} carer ${index}`, email: mail(`${options.slug}-carer-${index}`), emailVerified: true }
    });
    const member = await prisma.householdMember.create({
      data: { householdId: household.id, userId: user.id, role: HouseholdRole.parent, displayName: `carer ${index}` }
    });
    members.push({ user, member });
  }

  const babies = [];
  for (let index = 0; index < options.babies; index += 1) {
    babies.push(
      await prisma.baby.create({
        data: {
          householdId: household.id,
          name: `${options.slug} baby ${index}`,
          birthDate: new Date("2024-03-01T00:00:00.000Z"),
          timezone: "America/New_York"
        }
      })
    );
  }

  return {
    household,
    ownerUser,
    ownerMember,
    members,
    babies,
    ctx: { userId: ownerUser.id, householdId: household.id, memberId: ownerMember.id, role: HouseholdRole.owner }
  };
}

/**
 * Two years of entries, spread across babies and caregivers and across real dates, with the detail
 * row each kind requires. Written with createMany per chunk rather than one call per row: seeding is
 * not what is being measured, and a few thousand sequential inserts would dominate the run.
 *
 * Detail rows cannot be created by createMany alongside their parent, so each kind is inserted in its
 * own pass against the ids that came back.
 */
async function seedActivitiesAtScale(options: {
  householdId: string;
  babyIds: string[];
  memberIds: string[];
  total: number;
}) {
  const types = [ActivityType.feeding, ActivityType.diaper, ActivityType.sleep, ActivityType.note];
  const start = new Date("2024-06-01T07:00:00.000Z").getTime();
  const rows: Array<{
    id: string;
    householdId: string;
    babyId: string;
    actorMemberId: string;
    type: ActivityType;
    occurredAt: Date;
    timezone: string;
    notes: string | null;
  }> = [];

  for (let index = 0; index < options.total; index += 1) {
    const type = types[index % types.length];
    rows.push({
      id: `scale-${RUN}-${index.toString().padStart(5, "0")}`,
      householdId: options.householdId,
      babyId: options.babyIds[index % options.babyIds.length],
      actorMemberId: options.memberIds[index % options.memberIds.length],
      type,
      // Spread across roughly two years, several entries a day, as a tracked household looks.
      occurredAt: new Date(start + index * 5 * 60 * 60 * 1000),
      timezone: "America/New_York",
      notes: index % 11 === 0 ? `entry ${index}` : null
    });
  }

  for (let offset = 0; offset < rows.length; offset += 500) {
    await prisma.activityLog.createMany({ data: rows.slice(offset, offset + 500) });
  }

  const feeding = rows.filter((row) => row.type === ActivityType.feeding);
  const diaper = rows.filter((row) => row.type === ActivityType.diaper);
  const sleep = rows.filter((row) => row.type === ActivityType.sleep);
  const note = rows.filter((row) => row.type === ActivityType.note);

  for (let offset = 0; offset < feeding.length; offset += 500) {
    await prisma.feedingLog.createMany({
      data: feeding.slice(offset, offset + 500).map((row, position) => ({
        activityId: row.id,
        mode: position % 2 === 0 ? FeedingKind.bottle : FeedingKind.breast,
        amount: position % 2 === 0 ? 120 : null,
        unit: position % 2 === 0 ? "mL" : null
      }))
    });
  }
  for (let offset = 0; offset < diaper.length; offset += 500) {
    await prisma.diaperLog.createMany({
      data: diaper.slice(offset, offset + 500).map((row, position) => ({
        activityId: row.id,
        kind: position % 3 === 0 ? DiaperKind.dirty : DiaperKind.wet
      }))
    });
  }
  for (let offset = 0; offset < sleep.length; offset += 500) {
    await prisma.sleepLog.createMany({
      data: sleep.slice(offset, offset + 500).map((row) => ({ activityId: row.id }))
    });
  }
  // NoteLog.text is NOT optional, and the restore re-parses every entry through
  // activityRestoreSchema - so a note seeded without its detail row produces a backup that cannot be
  // restored at all. Worth stating because it is invisible until a fixture uses `note`.
  for (let offset = 0; offset < note.length; offset += 500) {
    await prisma.noteLog.createMany({
      data: note.slice(offset, offset + 500).map((row, position) => ({
        activityId: row.id,
        text: `a note worth keeping ${position}`
      }))
    });
  }

  return {
    total: rows.length,
    feeding: feeding.length,
    diaper: diaper.length,
    sleep: sleep.length,
    note: note.length
  };
}

async function countsFor(householdId: string) {
  const [activities, babies, members, posts, contacts, catalogs, events, reminders] = await Promise.all([
    prisma.activityLog.count({ where: { householdId } }),
    prisma.baby.count({ where: { householdId } }),
    prisma.householdMember.count({ where: { householdId, deletedAt: null } }),
    prisma.feedPost.count({ where: { householdId } }),
    prisma.contact.count({ where: { householdId } }),
    prisma.medicineCatalog.count({ where: { householdId } }),
    prisma.calendarEvent.count({ where: { householdId } }),
    prisma.reminder.count({ where: { householdId } })
  ]);
  return { activities, babies, members, posts, contacts, catalogs, events, reminders };
}

async function detailCountsFor(householdId: string) {
  const [feeding, diaper, sleep, note] = await Promise.all([
    prisma.feedingLog.count({ where: { activity: { householdId } } }),
    prisma.diaperLog.count({ where: { activity: { householdId } } }),
    prisma.sleepLog.count({ where: { activity: { householdId } } }),
    prisma.noteLog.count({ where: { activity: { householdId } } })
  ]);
  return { feeding, diaper, sleep, note };
}

let source: Awaited<ReturnType<typeof seedHousehold>>;
let seeded: Awaited<ReturnType<typeof seedActivitiesAtScale>>;
let backup: Envelope;
let exportMs = 0;

beforeAll(async () => {
  source = await seedHousehold({
    slug: "scale-src",
    name: "Scale Source",
    caregivers: SCALE.caregivers,
    babies: SCALE.babies
  });

  for (let index = 0; index < SCALE.contacts; index += 1) {
    await prisma.contact.create({
      data: { householdId: source.household.id, name: `contact ${index}`, kind: "doctor" }
    });
  }
  for (let index = 0; index < SCALE.catalogs; index += 1) {
    await prisma.medicineCatalog.create({
      data: { householdId: source.household.id, name: `medicine ${index}`, unit: "mL" }
    });
  }
  for (let index = 0; index < SCALE.calendarEvents; index += 1) {
    await prisma.calendarEvent.create({
      data: {
        householdId: source.household.id,
        title: `appointment ${index}`,
        startTime: new Date(`2026-0${(index % 9) + 1}-10T14:00:00.000Z`)
      }
    });
  }
  for (let index = 0; index < SCALE.feedPosts; index += 1) {
    await prisma.feedPost.create({
      data: {
        householdId: source.household.id,
        authorMemberId: source.members[index % source.members.length].member.id,
        body: `a moment worth keeping ${index}`,
        occurredAt: new Date(`2026-0${(index % 9) + 1}-11T09:00:00.000Z`)
      }
    });
  }

  seeded = await seedActivitiesAtScale({
    householdId: source.household.id,
    babyIds: source.babies.map((baby) => baby.id),
    memberIds: source.members.map((entry) => entry.member.id),
    total: SCALE.activities
  });

  asOwner(source.ctx);
  const exportStarted = Date.now();
  backup = (await exportHouseholdBackupJson(source.household.id)) as Envelope;
  exportMs = Date.now() - exportStarted;
}, 600_000);

afterAll(async () => {
  await prisma.$disconnect();
});

describe("a restore at the size a real household reaches", () => {
  it("carries every one of a household's thousands of entries, inside the transaction budget", async () => {
    // The file itself must hold everything before any claim about the restore means anything.
    expect(seeded.total).toBe(SCALE.activities);
    expect(backup.payload.activities).toHaveLength(SCALE.activities);
    expect(backup.payload.babies).toHaveLength(SCALE.babies);
    expect(backup.payload.members).toHaveLength(SCALE.caregivers + 1);
    expect(backup.payload.feedPosts).toHaveLength(SCALE.feedPosts);

    const serialized = Buffer.byteLength(JSON.stringify(backup), "utf8");

    // Counted the same way production counts it, so the reported budget is the real one.
    const records =
      (backup.payload.activities?.length ?? 0) +
      (backup.payload.babies?.length ?? 0) +
      (backup.payload.feedPosts?.length ?? 0) +
      (backup.payload.feedComments?.length ?? 0) +
      (backup.payload.feedReactions?.length ?? 0) +
      (backup.payload.calendarEvents?.length ?? 0) +
      (backup.payload.reminders?.length ?? 0) +
      (backup.payload.contacts?.length ?? 0) +
      (backup.payload.catalogs?.length ?? 0) +
      (backup.payload.plannedSchedules?.length ?? 0) +
      (backup.payload.feedPhotos?.length ?? 0);

    const target = await seedHousehold({ slug: "scale-dst", name: "Scale Target", caregivers: 0, babies: 0 });
    asOwner(target.ctx);

    const started = Date.now();
    const result = await restoreBackupJson(backup, {
      confirmation: "Scale Target",
      previewChecksum: backup.checksum
    });
    const restoreMs = Date.now() - started;

    // CORRECTNESS FIRST. Everything arrived, and the aggregate rows kept their detail rows: a restore
    // that dropped the far side of a join would leave entries that render as blanks in the app.
    const after = await countsFor(target.household.id);
    const details = await detailCountsFor(target.household.id);

    expect(after.activities).toBe(SCALE.activities);
    expect(after.babies).toBe(SCALE.babies);
    expect(after.posts).toBe(SCALE.feedPosts);
    expect(after.contacts).toBe(SCALE.contacts);
    expect(after.catalogs).toBe(SCALE.catalogs);
    expect(after.events).toBe(SCALE.calendarEvents);
    expect(details.feeding).toBe(seeded.feeding);
    expect(details.diaper).toBe(seeded.diaper);
    expect(details.sleep).toBe(seeded.sleep);
    expect(details.note).toBe(seeded.note);

    // Nobody gained membership from the file; everyone in it is reported for invitation.
    expect(after.members).toBe(1);
    expect(result.members.needInvite).toHaveLength(SCALE.caregivers + 1);
    expect(result.members.matched).toBe(0);

    // THE ONE HARD TIMING ASSERTION. If a household this size cannot be restored inside the
    // transaction's own budget, the product cannot migrate a real family and that is a defect.
    // The budget is derived from the payload, so this asserts the product's own promise for a
    // household this size rather than a number the test invented.
    const budgetMs = budgetFor(records);
    if (!process.env.SCALE_MEASURE_ONLY) {
      expect(restoreMs).toBeLessThan(budgetMs);
    }

    // Reported rather than asserted, so a regression that doubles the cost is visible even while it
    // still fits, and so the margin is a number somebody can act on.
    const perActivity = (restoreMs / SCALE.activities).toFixed(2);
    const headroom = (budgetMs / restoreMs).toFixed(1);
    console.info(
      [
        "",
        "  restore at scale",
        `    entries              ${SCALE.activities}`,
        `    backup file          ${(serialized / 1024 / 1024).toFixed(2)} MiB`,
        `    export               ${exportMs} ms`,
        `    restore              ${restoreMs} ms`,
        `    per entry            ${perActivity} ms`,
        `    transaction budget   ${budgetMs} ms (derived from ${records} records)`,
        `    headroom             ${headroom}x`,
        ""
      ].join("\n")
    );
  }, 600_000);

  it("refuses a household this size when the target is not empty, without writing a single row", async () => {
    // The expensive refusal: a target holding data must be rejected BEFORE thousands of inserts begin,
    // not partway through. A restore that wrote half a household and then failed would be the worst
    // outcome of all, and at this size a late check would be plainly visible in the timing.
    const populated = await seedHousehold({ slug: "scale-busy", name: "Scale Busy", caregivers: 0, babies: 1 });
    asOwner(populated.ctx);
    const before = await countsFor(populated.household.id);

    const started = Date.now();
    await expect(
      restoreBackupJson(backup, { confirmation: "Scale Busy", previewChecksum: backup.checksum })
    ).rejects.toThrow("backup_target_not_empty");
    const refusedMs = Date.now() - started;

    expect(await countsFor(populated.household.id)).toEqual(before);
    // A refusal that took as long as a restore would mean the check runs too late to protect anybody.
    expect(refusedMs).toBeLessThan(30_000);
    console.info(`  refused a ${SCALE.activities}-entry restore in ${refusedMs} ms, nothing written`);
  }, 600_000);
});

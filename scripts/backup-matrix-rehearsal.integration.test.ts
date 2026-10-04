/**
 * Backup and restore, for households that are not the simple case.
 *
 * The existing rehearsal proves one household with one member. A real install is not that: this
 * household has four people and four babies, and an install can hold several households whose
 * members overlap. The scenarios below are the ones a family actually meets when they move Cubby to
 * a new machine, and the ones that decide whether their history survives the trip.
 *
 * SCOPE, STATED PLAINLY. These exercise the backup and restore SERVICES against a real database, with
 * the household context and session resolution mocked. They do NOT go through the HTTP route, so the
 * route's parsing, headers, upload limits and error mapping are untested here, and neither is the
 * browser. A failure reported as "Something went wrong" is the route's fallback for an error it does
 * not recognise - nothing in this file can reproduce or rule that out.
 *
 * Every assertion here is about OBSERVED behaviour, not about what a backup file ought to contain.
 * Where the answer is surprising - a membership claiming to be an owner is ignored, an entry's author
 * becomes whoever ran the restore - the test states the behaviour and why, so a future change that
 * breaks it has to argue with the reason rather than with a bare expectation.
 */
import { afterAll, describe, expect, it, vi } from "vitest";
import { ActivityType, DiaperKind, FeedingKind, HouseholdRole, TimerState } from "@prisma/client";
import { randomBytes } from "node:crypto";

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
import {
  exportHouseholdBackupJson,
  previewBackupJson,
  restoreBackupJson
} from "@/server/services/backups";
import { payloadChecksum } from "@/server/services/backup-format";
import { refreshHouseholdAuditCheckpoint } from "@/server/services/audit-checkpoints";

type Envelope = {
  format: "cubby-household-backup";
  version: 2;
  exportedAt: string;
  checksum: string;
  payload: Record<string, any>;
};

/**
 * Emails are unique per run. The real harness gets a brand-new database each time, but a fixture that
 * silently depends on that cannot be re-run while diagnosing a failure, and two scenarios sharing an
 * address would collide for a reason that looks like a product bug.
 */
const RUN = randomBytes(3).toString("hex");
const mail = (slug: string) => `${slug}-${RUN}@matrix.invalid`;

/** A household, its owner, and however many other people belong to it. */
async function seedHousehold(options: {
  slug: string;
  name: string;
  members: Array<{ slug: string; role: HouseholdRole; displayName?: string | null }>;
  babies: string[];
}) {
  const ownerUser = await prisma.user.create({
    data: { name: `${options.slug} owner`, email: mail(`${options.slug}-owner`), emailVerified: true }
  });
  const household = await prisma.household.create({
    data: { name: options.name, createdByUserId: ownerUser.id }
  });
  const ownerMember = await prisma.householdMember.create({
    data: { householdId: household.id, userId: ownerUser.id, role: HouseholdRole.owner, displayName: `${options.slug} owner` }
  });
  await prisma.session.create({
    data: { token: `${options.slug}-owner-token-${randomBytes(4).toString("hex")}`, expiresAt: new Date("2099-01-01T00:00:00.000Z"), userId: ownerUser.id }
  }).then((session) => auth.sessionIds.set(ownerUser.id, session.id));

  // A household's audit chain must be verifiable before it can receive a restore, and a household
  // created directly like this has no checkpoint until one is written.
  await refreshHouseholdAuditCheckpoint(household.id, prisma);

  const others: Array<{ user: { id: string; email: string }; member: { id: string }; role: HouseholdRole }> = [];
  for (const spec of options.members) {
    const user = await prisma.user.create({
      data: { name: `${spec.slug}`, email: mail(spec.slug), emailVerified: true }
    });
    const member = await prisma.householdMember.create({
      data: {
        householdId: household.id,
        userId: user.id,
        role: spec.role,
        displayName: spec.displayName === undefined ? spec.slug : spec.displayName
      }
    });
    others.push({ user, member, role: spec.role });
  }

  const babies: Array<{ id: string; name: string }> = [];
  for (const babyName of options.babies) {
    const baby = await prisma.baby.create({
      data: {
        householdId: household.id,
        name: babyName,
        birthDate: new Date("2026-01-15T00:00:00.000Z"),
        timezone: "America/New_York"
      }
    });
    babies.push(baby);
  }

  return {
    ownerUser,
    household,
    ownerMember,
    others,
    babies,
    ctx: { userId: ownerUser.id, householdId: household.id, memberId: ownerMember.id, role: HouseholdRole.owner }
  };
}

/**
 * An entry logged BY a particular member. Seeded directly rather than through the service so each
 * entry can be attributed to a different person, which is the thing a multi-caregiver household
 * needs a backup to survive.
 *
 * `timerState` is left at its default rather than set to `stopped`: a stopped timer is a database
 * promise that `startedAt`, `endedAt` and `durationSeconds` all exist and reconcile to the second,
 * enforced by a trigger. These entries are moments, not timed activities, so they carry no timer.
 */
async function logEntryAs(options: {
  householdId: string;
  babyId: string;
  actorMemberId: string;
  type: ActivityType;
  occurredAt: string;
  notes?: string;
}) {
  // Each kind of entry carries its own detail row, and the export reads through it: an entry without
  // one is not a thing the app can create, so seeding the aggregate alone would be testing a shape
  // that never reaches a backup.
  const detail =
    options.type === ActivityType.feeding
      ? { feeding: { create: { mode: FeedingKind.bottle, amount: 120, unit: "mL" } } }
      : options.type === ActivityType.diaper
        ? { diaper: { create: { kind: DiaperKind.wet } } }
        : options.type === ActivityType.sleep
          ? { sleep: { create: {} } }
          : {};
  return prisma.activityLog.create({
    data: {
      householdId: options.householdId,
      babyId: options.babyId,
      actorMemberId: options.actorMemberId,
      type: options.type,
      occurredAt: new Date(options.occurredAt),
      timezone: "America/New_York",
      notes: options.notes ?? null,
      ...detail
    }
  });
}

/**
 * A timed activity that really ran: a nap with a start, an end and a duration that agree. Included
 * because a backup must carry timer state as faithfully as it carries a moment, and because the
 * trigger above means a malformed one cannot even be written.
 */
async function logTimedEntryAs(options: {
  householdId: string;
  babyId: string;
  actorMemberId: string;
  startedAt: string;
  endedAt: string;
  notes?: string;
}) {
  const startedAt = new Date(options.startedAt);
  const endedAt = new Date(options.endedAt);
  const durationSeconds = Math.round((endedAt.getTime() - startedAt.getTime()) / 1000);
  return prisma.activityLog.create({
    data: {
      householdId: options.householdId,
      babyId: options.babyId,
      actorMemberId: options.actorMemberId,
      type: ActivityType.sleep,
      occurredAt: startedAt,
      startedAt,
      endedAt,
      durationSeconds,
      pausedSeconds: 0,
      timerState: TimerState.stopped,
      timezone: "America/New_York",
      notes: options.notes ?? null,
      sleep: { create: {} }
    }
  });
}

function asOwner(ctx: { userId: string; householdId: string; memberId: string; role: HouseholdRole }) {
  auth.context = ctx;
}

async function countsFor(householdId: string) {
  const [babies, activities, posts, members] = await Promise.all([
    prisma.baby.count({ where: { householdId, deletedAt: null } }),
    prisma.activityLog.count({ where: { householdId, deletedAt: null } }),
    prisma.feedPost.count({ where: { householdId, deletedAt: null } }),
    prisma.householdMember.count({ where: { householdId, deletedAt: null } })
  ]);
  return { babies, activities, posts, members };
}

afterAll(async () => {
  await prisma.$disconnect();
});

describe("A - a household with several caregivers and several babies", () => {
  it("carries every baby and entry, and reports which people the new server does not know", async () => {
    const source = await seedHousehold({
      slug: "a-src",
      name: "Matrix Source",
      members: [
        { slug: "a-partner", role: HouseholdRole.parent },
        { slug: "a-grandma", role: HouseholdRole.caretaker, displayName: "Grandma" },
        { slug: "a-sitter", role: HouseholdRole.read_only }
      ],
      babies: ["Avery", "Blake", "Cory", "Devon"]
    });

    // Four people logging across four babies, the way a week actually looks.
    const authors = [source.ownerMember, ...source.others.map((other) => other.member)];
    let seeded = 0;
    for (const [babyIndex, baby] of source.babies.entries()) {
      for (const [authorIndex, author] of authors.entries()) {
        await logEntryAs({
          householdId: source.household.id,
          babyId: baby.id,
          actorMemberId: author.id,
          type: authorIndex % 2 === 0 ? ActivityType.feeding : ActivityType.diaper,
          occurredAt: `2026-09-${String(10 + babyIndex).padStart(2, "0")}T${String(8 + authorIndex).padStart(2, "0")}:00:00.000Z`,
          notes: `entry ${babyIndex}-${authorIndex}`
        });
        seeded += 1;
      }
    }
    expect(seeded).toBe(16);

    // One real nap with a start, an end and a duration, so the backup has timer state to carry.
    await logTimedEntryAs({
      householdId: source.household.id,
      babyId: source.babies[0].id,
      actorMemberId: source.others[0].member.id,
      startedAt: "2026-09-14T19:30:00.000Z",
      endedAt: "2026-09-15T06:15:00.000Z",
      notes: "overnight"
    });

    asOwner(source.ctx);
    const backup = (await exportHouseholdBackupJson(source.household.id)) as Envelope;

    // The file carries all four babies, all seventeen entries, and all four people.
    expect(backup.payload.babies).toHaveLength(4);
    expect(backup.payload.activities).toHaveLength(17);
    expect(backup.payload.members).toHaveLength(4);
    const carriedEmails = (backup.payload.members as Array<{ email: string }>).map((m) => m.email.toLowerCase()).sort();
    expect(carriedEmails).toEqual([
      mail("a-grandma"),
      mail("a-partner"),
      mail("a-sitter"),
      mail("a-src-owner")
    ]);

    // A backup must never be able to carry a login.
    const serialized = JSON.stringify(backup);
    for (const forbidden of ["password", "passwordHash", "sessionToken", "token", "secret"]) {
      expect(serialized.toLowerCase()).not.toContain(`"${forbidden}":`);
    }

    // The new server: a fresh household whose owner is one of the SAME people, and where one other
    // caregiver already has an account. The partner is the SAME person as in the source household -
    // one account, two households - which is exactly how a real family and a real backup overlap.
    const target = await seedHousehold({ slug: "a-tgt", name: "Matrix Target", members: [], babies: [] });
    const knownPartner = await prisma.user.findUniqueOrThrow({ where: { email: mail("a-partner") } });
    await prisma.householdMember.create({
      data: { householdId: target.household.id, userId: knownPartner.id, role: HouseholdRole.parent, displayName: "a-partner" }
    });

    // Two members now, so the target is no longer a sole-owner household: restore must refuse. This
    // is the exact error the User hit, and it is worth proving it fires for THIS reason too.
    asOwner(target.ctx);
    await expect(
      restoreBackupJson(backup, { confirmation: "Matrix Target", previewChecksum: backup.checksum })
    ).rejects.toThrow("backup_target_not_empty");

    // Restore onto a genuinely fresh household, set up by the SAME person who owned the source: on a
    // new machine they sign up with their own email, create a household, and restore into it. That is
    // the real migration, and it is what makes `matched` meaningful rather than always zero.
    //
    // The source owner's account is reused directly, because one human has one account per server and
    // the file recognises people by the address they already have. They get their own session on this
    // household, because the restore verifies the session really belongs to the person running it.
    const fresh = await seedHousehold({ slug: "a-fresh", name: "Matrix Fresh", members: [], babies: [] });
    const arrivingOwner = await prisma.householdMember.update({
      where: { id: fresh.ownerMember.id },
      data: { userId: source.ownerUser.id }
    });
    const arrivingSession = await prisma.session.create({
      data: {
        token: `a-arriving-${randomBytes(4).toString("hex")}`,
        expiresAt: new Date("2099-01-01T00:00:00.000Z"),
        userId: source.ownerUser.id
      }
    });
    auth.sessionIds.set(source.ownerUser.id, arrivingSession.id);
    asOwner({ ...fresh.ctx, userId: source.ownerUser.id, memberId: arrivingOwner.id });
    await expect(previewBackupJson(backup)).resolves.toMatchObject({ checksumVerified: true });
    const restored = await restoreBackupJson(backup, { confirmation: "Matrix Fresh", previewChecksum: backup.checksum });

    // Everything that is data came across.
    const after = await countsFor(fresh.household.id);
    expect(after.babies).toBe(4);
    expect(after.activities).toBe(17);

    // The nap came back as a finished timer, with its start, end and duration still agreeing - the
    // database would refuse to hold it otherwise, so this also proves the restore wrote a valid one.
    const restoredNap = await prisma.activityLog.findFirstOrThrow({
      where: { householdId: fresh.household.id, type: ActivityType.sleep, deletedAt: null }
    });
    expect(restoredNap.timerState).toBe(TimerState.stopped);
    expect(restoredNap.startedAt?.toISOString()).toBe("2026-09-14T19:30:00.000Z");
    expect(restoredNap.endedAt?.toISOString()).toBe("2026-09-15T06:15:00.000Z");
    expect(restoredNap.durationSeconds).toBe(38_700);

    // The owner was recognised because their address is already here. Nobody else was granted
    // membership by the file: the other three are reported for invitation instead.
    expect(after.members).toBe(1);
    expect(restored.members.matched).toBe(1);
    expect([...restored.members.needInvite].sort()).toEqual([
      mail("a-grandma"),
      mail("a-partner"),
      mail("a-sitter")
    ]);

    // No account was created for the people who need inviting.
    for (const email of [mail("a-grandma"), mail("a-sitter")]) {
      const memberships = await prisma.householdMember.count({
        where: { householdId: fresh.household.id, user: { email } }
      });
      expect(memberships).toBe(0);
    }

    // And no session or credential was minted for anyone by the restore.
    const sessionsForSource = await prisma.session.count({
      where: { user: { email: { in: [mail("a-grandma"), mail("a-sitter")] } } }
    });
    expect(sessionsForSource).toBe(0);

    // Every restored entry belongs to the person who ran the restore, because an entry's author is a
    // membership and memberships do not travel. The history is preserved; its attribution is not.
    // A family moving servers should expect the log to read as "restored by me", not as a loss.
    const actors = await prisma.activityLog.findMany({
      where: { householdId: fresh.household.id, deletedAt: null },
      select: { actorMemberId: true }
    });
    expect(new Set(actors.map((a) => a.actorMemberId))).toEqual(new Set([arrivingOwner.id]));
  });
});

describe("B - an install holding several households", () => {
  it("exports one household only, and leaves every other household untouched", async () => {
    const first = await seedHousehold({
      slug: "b-one",
      name: "B One",
      members: [{ slug: "b-shared", role: HouseholdRole.parent }],
      babies: ["One-A", "One-B"]
    });
    const second = await seedHousehold({
      slug: "b-two",
      name: "B Two",
      members: [{ slug: "b-two-helper", role: HouseholdRole.caretaker }],
      babies: ["Two-A", "Two-B"]
    });
    const third = await seedHousehold({
      slug: "b-three",
      name: "B Three",
      members: [],
      babies: ["Three-A"]
    });

    // One person belongs to two households, which is the case most likely to leak across tenants.
    const shared = await prisma.user.findUniqueOrThrow({ where: { email: mail("b-shared") } });
    await prisma.householdMember.create({
      data: { householdId: second.household.id, userId: shared.id, role: HouseholdRole.caretaker, displayName: "b-shared" }
    });

    for (const household of [first, second, third]) {
      for (const baby of household.babies) {
        await logEntryAs({
          householdId: household.household.id,
          babyId: baby.id,
          actorMemberId: household.ownerMember.id,
          type: ActivityType.feeding,
          occurredAt: "2026-09-20T09:00:00.000Z",
          notes: `${household.household.name} ${baby.name}`
        });
      }
    }

    // Counts alone would miss an in-place change - a renamed baby, a rewritten note, a flipped role -
    // so the whole exported payload of each uninvolved household is fingerprinted instead. The
    // checksum covers every field of every table the export reaches.
    const fingerprint = async (household: { household: { id: string }; ctx: typeof first.ctx }) => {
      asOwner(household.ctx);
      const snapshot = (await exportHouseholdBackupJson(household.household.id)) as Envelope;
      return payloadChecksum(snapshot.payload);
    };
    const before = {
      one: await fingerprint(first),
      two: await fingerprint(second),
      three: await fingerprint(third)
    };

    asOwner(second.ctx);
    const backup = (await exportHouseholdBackupJson(second.household.id)) as Envelope;

    // The file is strictly the second household: its babies, its entries, its people.
    expect((backup.payload.babies as Array<{ name: string }>).map((b) => b.name).sort()).toEqual(["Two-A", "Two-B"]);
    expect(backup.payload.activities).toHaveLength(2);

    const text = JSON.stringify(backup);
    for (const foreign of ["One-A", "One-B", "Three-A", "B One", "B Three", mail("b-one-owner"), mail("b-three-owner")]) {
      expect(text).not.toContain(foreign);
    }
    // The shared person appears, because they really are a member of this household - and they appear
    // in their SECOND-household capacity. A lookup that found the membership by account alone would
    // return their first-household role instead, and this is what catches that.
    expect(text).toContain(mail("b-shared"));
    // Household two has three people: its own owner, its own helper, and the shared person.
    expect((backup.payload.members as Array<{ email: string }>).map((m) => m.email.toLowerCase()).sort()).toEqual([
      mail("b-shared"),
      mail("b-two-helper"),
      mail("b-two-owner")
    ]);
    expect((backup.payload.members as Array<{ email: string; role: string; displayName: string | null }>)
      .find((m) => m.email.toLowerCase() === mail("b-shared"))).toMatchObject({
        role: "caretaker",
        displayName: "b-shared"
      });

    // Restoring it elsewhere must not disturb the households that were not involved.
    const fresh = await seedHousehold({ slug: "b-fresh", name: "B Fresh", members: [], babies: [] });
    asOwner(fresh.ctx);
    await restoreBackupJson(backup, { confirmation: "B Fresh", previewChecksum: backup.checksum });

    expect(await fingerprint(first)).toBe(before.one);
    expect(await fingerprint(second)).toBe(before.two);
    expect(await fingerprint(third)).toBe(before.three);

    // And the restored household holds only what the file carried.
    const restoredBabies = await prisma.baby.findMany({
      where: { householdId: fresh.household.id, deletedAt: null },
      select: { name: true }
    });
    expect(restoredBabies.map((b) => b.name).sort()).toEqual(["Two-A", "Two-B"]);
  });
});

describe("C - a target that cannot accept a restore", () => {
  it("refuses a populated household, and refuses a two-member household, without writing anything", async () => {
    const source = await seedHousehold({
      slug: "c-src",
      name: "C Source",
      members: [],
      babies: ["Casey"]
    });
    await logEntryAs({
      householdId: source.household.id,
      babyId: source.babies[0].id,
      actorMemberId: source.ownerMember.id,
      type: ActivityType.feeding,
      occurredAt: "2026-09-21T09:00:00.000Z"
    });
    asOwner(source.ctx);
    const backup = (await exportHouseholdBackupJson(source.household.id)) as Envelope;

    // Restoring onto itself: the data that makes it worth keeping is what makes it refuse.
    const beforeSelf = await countsFor(source.household.id);
    await expect(
      restoreBackupJson(backup, { confirmation: "C Source", previewChecksum: backup.checksum })
    ).rejects.toThrow("backup_target_not_empty");
    expect(await countsFor(source.household.id)).toEqual(beforeSelf);

    // A household with no data but a second person: also refused, and for the member half of the
    // rule rather than the emptiness half.
    const twoPeople = await seedHousehold({
      slug: "c-two",
      name: "C Two People",
      members: [{ slug: "c-helper", role: HouseholdRole.caretaker }],
      babies: []
    });
    asOwner(twoPeople.ctx);
    const beforeTwo = await countsFor(twoPeople.household.id);
    await expect(
      restoreBackupJson(backup, { confirmation: "C Two People", previewChecksum: backup.checksum })
    ).rejects.toThrow("backup_target_not_empty");
    expect(await countsFor(twoPeople.household.id)).toEqual(beforeTwo);

    // A fresh household with a single baby and nothing else is still not empty.
    const oneBaby = await seedHousehold({ slug: "c-baby", name: "C One Baby", members: [], babies: ["Placeholder"] });
    asOwner(oneBaby.ctx);
    await expect(
      restoreBackupJson(backup, { confirmation: "C One Baby", previewChecksum: backup.checksum })
    ).rejects.toThrow("backup_target_not_empty");

    // Proving the refusals above were about the TARGET and not about the file: the same file
    // restores cleanly into a household that is genuinely fresh.
    const fresh = await seedHousehold({ slug: "c-fresh", name: "C Fresh", members: [], babies: [] });
    asOwner(fresh.ctx);
    await restoreBackupJson(backup, { confirmation: "C Fresh", previewChecksum: backup.checksum });
    expect((await countsFor(fresh.household.id)).activities).toBe(1);
  });
});

describe("D - the new-server migration, where nobody is known yet", () => {
  it("restores a multi-caregiver household onto a server that knows none of them, with a specific error or none at all", async () => {
    const source = await seedHousehold({
      slug: "d-src",
      name: "D Source",
      members: [
        { slug: "d-partner", role: HouseholdRole.parent },
        { slug: "d-nan", role: HouseholdRole.caretaker }
      ],
      babies: ["Dana", "Drew"]
    });
    for (const baby of source.babies) {
      await logEntryAs({
        householdId: source.household.id,
        babyId: baby.id,
        actorMemberId: source.others[0].member.id,
        type: ActivityType.sleep,
        occurredAt: "2026-09-22T20:00:00.000Z"
      });
    }
    asOwner(source.ctx);
    const backup = (await exportHouseholdBackupJson(source.household.id)) as Envelope;

    // The new server: a brand-new household whose owner is a DIFFERENT person entirely, so not one
    // email in the file matches anybody here. This is the shape of the migration the User could not
    // complete.
    //
    // WHAT THIS DOES AND DOES NOT SHOW. It exercises the service, not the HTTP route: the route's own
    // parsing, header handling, upload limits and - crucially - its error mapping are not in this call
    // path. The User's report of "Something went wrong" is the route's fallback for an error it does
    // not recognise, so this test cannot reproduce or rule that out. What it does show is that the
    // service's own refusals are named: if restore declines here, the message must be a recognised
    // backup_* code rather than a database or client error that the route would be unable to explain.
    const newServer = await seedHousehold({ slug: "d-new", name: "D New Server", members: [], babies: [] });
    asOwner(newServer.ctx);

    await expect(previewBackupJson(backup)).resolves.toMatchObject({ checksumVerified: true });

    let outcome: { ok: true; needInvite: string[] } | { ok: false; message: string };
    try {
      const result = await restoreBackupJson(backup, {
        confirmation: "D New Server",
        previewChecksum: backup.checksum
      });
      outcome = { ok: true, needInvite: [...result.members.needInvite].sort() };
    } catch (error) {
      outcome = { ok: false, message: error instanceof Error ? error.message : String(error) };
    }

    if (!outcome.ok) {
      // A recognised backup_* code is one the route can turn into a sentence. Anything else - a Prisma
      // error, a trigger's raise, a connection failure - is what becomes "Something went wrong".
      expect(outcome.message).toMatch(/^backup_[a-z_]+$/);
      throw new Error(`restore_onto_unknown_server_refused:${outcome.message}`);
    }

    // Every person in the file is unknown here, so all three are reported for invitation.
    expect(outcome.needInvite).toEqual([
      mail("d-nan"),
      mail("d-partner"),
      mail("d-src-owner")
    ]);

    // The history itself survived in full.
    const after = await countsFor(newServer.household.id);
    expect(after.babies).toBe(2);
    expect(after.activities).toBe(2);

    // The household still has exactly one member - the person who did the restore - and they are
    // still its owner. A file naming an owner must not change who owns the household.
    expect(after.members).toBe(1);
    const owner = await prisma.householdMember.findFirstOrThrow({
      where: { householdId: newServer.household.id, deletedAt: null }
    });
    expect(owner.id).toBe(newServer.ownerMember.id);
    expect(owner.role).toBe(HouseholdRole.owner);
  });
});

describe("E - a file that cannot be trusted", () => {
  it("refuses a tampered role, a missing photo, a dangling reference and a bad checksum, leaving nothing behind", async () => {
    const source = await seedHousehold({
      slug: "e-src",
      name: "E Source",
      members: [{ slug: "e-helper", role: HouseholdRole.caretaker }],
      babies: ["Ellis"]
    });
    await logEntryAs({
      householdId: source.household.id,
      babyId: source.babies[0].id,
      actorMemberId: source.ownerMember.id,
      type: ActivityType.feeding,
      occurredAt: "2026-09-23T09:00:00.000Z"
    });
    asOwner(source.ctx);
    const good = (await exportHouseholdBackupJson(source.household.id)) as Envelope;

    const freshFor = async (slug: string, name: string) => {
      const household = await seedHousehold({ slug, name, members: [], babies: [] });
      asOwner(household.ctx);
      return household;
    };

    /**
     * A tampered file that still vouches for itself.
     *
     * The checksum is computed over the whole payload and verified before anything else, so editing
     * the payload and leaving the old checksum means the file dies at `backup_checksum_mismatch` and
     * the rule being tested is never reached. Every case below that edits the payload has to re-sign
     * it, or it proves only that the checksum works - which the first case already proves.
     */
    const resign = (envelope: Envelope) => {
      envelope.checksum = payloadChecksum(envelope.payload);
      return envelope;
    };

    // A hand-edited checksum: the file no longer vouches for itself. Deliberately NOT re-signed.
    const badChecksum = structuredClone(good);
    badChecksum.checksum = "0".repeat(64);
    const t1 = await freshFor("e-sum", "E Checksum");
    await expect(
      restoreBackupJson(badChecksum, { confirmation: "E Checksum", previewChecksum: badChecksum.checksum })
    ).rejects.toThrow("backup_checksum_mismatch");
    expect((await countsFor(t1.household.id)).activities).toBe(0);

    // An entry pointing at a baby the file does not carry, re-signed so the reference check is what
    // refuses it rather than the checksum.
    //
    // The code is `backup_invalid`, not `backup_dangling_reference`: the reference rule is a Zod
    // refinement (backup-format.ts:397) and parseRecoveryBackup collapses every ZodError into one
    // code (backups.ts:711). So the file is refused for the right reason and the person is told only
    // that the file is unusable. Worth knowing before reading a support report.
    const dangling = structuredClone(good);
    dangling.payload.activities[0].babyId = "no-such-baby";
    resign(dangling);
    const t2 = await freshFor("e-dangle", "E Dangling");
    await expect(
      restoreBackupJson(dangling, { confirmation: "E Dangling", previewChecksum: dangling.checksum })
    ).rejects.toThrow("backup_invalid");
    expect((await countsFor(t2.household.id)).activities).toBe(0);

    // A file claiming photos it does not carry: JSON alone cannot restore them, and a half-restored
    // household with missing pictures is worse than a refusal. The entry has to be schema-VALID or it
    // is rejected as a malformed file instead, which would prove nothing about the photos rule.
    const claimsPhotos = structuredClone(good);
    claimsPhotos.payload.feedPhotos = [
      {
        id: "ghost-photo",
        postId: null,
        position: null,
        memberEmail: mail("e-src-owner"),
        width: 100,
        height: 100,
        byteSize: 1_024,
        sha256: "0".repeat(64)
      }
    ];
    resign(claimsPhotos);
    const t3 = await freshFor("e-photo", "E Photos");
    await expect(
      restoreBackupJson(claimsPhotos, { confirmation: "E Photos", previewChecksum: claimsPhotos.checksum })
    ).rejects.toThrow("backup_photos_missing");
    expect((await countsFor(t3.household.id)).activities).toBe(0);

    // The confirmation is the household's own name: a mismatch means the person is looking at a
    // different household than the one they are about to overwrite.
    const t4 = await freshFor("e-confirm", "E Confirm");
    await expect(
      restoreBackupJson(good, { confirmation: "Not The Household", previewChecksum: good.checksum })
    ).rejects.toThrow("backup_confirmation_mismatch");
    expect((await countsFor(t4.household.id)).activities).toBe(0);

    // A preview checksum from a different file: the person previewed one backup and submitted
    // another.
    const t5 = await freshFor("e-preview", "E Preview");
    await expect(
      restoreBackupJson(good, { confirmation: "E Preview", previewChecksum: "1".repeat(64) })
    ).rejects.toThrow("backup_preview_mismatch");
    expect((await countsFor(t5.household.id)).activities).toBe(0);

    // An imported membership claiming to be an owner, re-signed so the claim actually reaches the
    // member logic. A backup file must never be able to hand someone a household.
    //
    // The restore SUCCEEDS and the claim is simply ignored: memberships are not created or altered by
    // a restore at all, so the role in the file is read for the record and never applied. That is the
    // behaviour being pinned - not merely "one of two safe outcomes".
    const claimsOwner = structuredClone(good);
    (claimsOwner.payload.members as Array<{ email: string; role: string }>).forEach((member) => {
      member.role = "owner";
    });
    resign(claimsOwner);
    const t6 = await freshFor("e-owner", "E Owner Claim");
    const ownerClaimResult = await restoreBackupJson(claimsOwner, {
      confirmation: "E Owner Claim",
      previewChecksum: claimsOwner.checksum
    });

    // The household still has exactly one owner and one member: the person who restored. Nobody named
    // in the file was granted anything, however the file described them.
    const ownersAfter = await prisma.householdMember.findMany({
      where: { householdId: t6.household.id, deletedAt: null, role: HouseholdRole.owner }
    });
    expect(ownersAfter).toHaveLength(1);
    expect(ownersAfter[0].id).toBe(t6.ownerMember.id);
    expect(await prisma.householdMember.count({ where: { householdId: t6.household.id, deletedAt: null } })).toBe(1);
    // Both people in the file are strangers here, so both are reported for invitation rather than
    // being admitted as the owners the file claimed they were.
    expect([...ownerClaimResult.members.needInvite].sort()).toEqual([
      mail("e-helper"),
      mail("e-src-owner")
    ]);
    expect(ownerClaimResult.members.matched).toBe(0);
    // The data itself still arrived, which is what makes the ignored role a safe outcome rather than
    // a silent half-restore.
    expect((await countsFor(t6.household.id)).activities).toBe(1);

    // After all of those refusals, the source household is exactly as it was.
    expect((await countsFor(source.household.id)).activities).toBe(1);
  });
});

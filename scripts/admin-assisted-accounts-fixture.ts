import { afterAll, expect, it } from "vitest";
import { hashPassword } from "better-auth/crypto";
import { writeFile } from "node:fs/promises";
import { HouseholdRole } from "@prisma/client";

import { prisma } from "@/lib/db/prisma";

const handoffFile = process.env.REHEARSAL_HANDOFF_FILE;
const password = process.env.REHEARSAL_APP_PASSWORD;
if (!handoffFile || !password) throw new Error("admin_assisted_accounts_fixture_environment_not_set");

/**
 * Synthetic-only fixture. Every identifier and mailbox is fabricated and `.invalid`, so no real
 * household data, mailbox or credential can be reached by this rehearsal.
 */
const marker = {
  ownerUserId: "aa_usr_owner1",
  ownerAccountId: "aa_acc_owner1",
  ownerMemberId: "aa_mem_owner1",
  ownerEmail: "assisted-owner@rehearsal.invalid",

  adminUserId: "aa_usr_admin1",
  adminAccountId: "aa_acc_admin1",
  adminMemberId: "aa_mem_admin1",
  adminEmail: "assisted-admin@rehearsal.invalid",

  // An ordinary single-household member: the eligible reset target.
  memberUserId: "aa_usr_member1",
  memberAccountId: "aa_acc_member1",
  memberMemberId: "aa_mem_member1",
  memberEmail: "assisted-member@rehearsal.invalid",

  // A member who ALSO belongs to a second household: reset must be refused server-side.
  sharedUserId: "aa_usr_shared1",
  sharedAccountId: "aa_acc_shared1",
  sharedMemberId: "aa_mem_shared1",
  sharedForeignMemberId: "aa_mem_shared_foreign1",
  sharedEmail: "assisted-shared@rehearsal.invalid",

  householdId: "aa_hh_main1",
  householdName: "Assisted Accounts Rehearsal Nursery",
  foreignHouseholdId: "aa_hh_other1",
  foreignHouseholdName: "Assisted Accounts Other Nursery",

  // Never persisted by the fixture; the probe creates this account through the real endpoint.
  createdEmail: "assisted-created@rehearsal.invalid",
  createdCheckedEmail: "assisted-created-checked@rehearsal.invalid"
};

afterAll(async () => prisma.$disconnect());

it("seeds the fixed admin-assisted accounts fixture", async () => {
  const hashed = await hashPassword(password);

  for (const [userId, accountId, email, name] of [
    [marker.ownerUserId, marker.ownerAccountId, marker.ownerEmail, "Assisted Owner"],
    [marker.adminUserId, marker.adminAccountId, marker.adminEmail, "Assisted Admin"],
    [marker.memberUserId, marker.memberAccountId, marker.memberEmail, "Assisted Member"],
    [marker.sharedUserId, marker.sharedAccountId, marker.sharedEmail, "Assisted Shared Member"]
  ] as const) {
    await prisma.user.create({ data: { id: userId, name, email, emailVerified: true } });
    await prisma.account.create({ data: {
      id: accountId, accountId: userId, providerId: "credential", userId, password: hashed
    } });
  }

  await prisma.household.create({ data: {
    id: marker.householdId, name: marker.householdName, createdByUserId: marker.ownerUserId
  } });
  await prisma.household.create({ data: {
    id: marker.foreignHouseholdId, name: marker.foreignHouseholdName, createdByUserId: marker.sharedUserId
  } });

  await prisma.householdMember.create({ data: {
    id: marker.ownerMemberId, householdId: marker.householdId, userId: marker.ownerUserId,
    role: HouseholdRole.owner, displayName: "Assisted owner"
  } });
  await prisma.householdMember.create({ data: {
    id: marker.adminMemberId, householdId: marker.householdId, userId: marker.adminUserId,
    role: HouseholdRole.admin, displayName: "Assisted admin"
  } });
  await prisma.householdMember.create({ data: {
    id: marker.memberMemberId, householdId: marker.householdId, userId: marker.memberUserId,
    role: HouseholdRole.parent, displayName: "Assisted member"
  } });
  await prisma.householdMember.create({ data: {
    id: marker.sharedMemberId, householdId: marker.householdId, userId: marker.sharedUserId,
    role: HouseholdRole.parent, displayName: "Assisted shared member"
  } });
  await prisma.householdMember.create({ data: {
    id: marker.sharedForeignMemberId, householdId: marker.foreignHouseholdId, userId: marker.sharedUserId,
    role: HouseholdRole.owner, displayName: "Assisted shared member elsewhere"
  } });

  // Assisted create/reset read platform authority and settings and refuse when either is absent,
  // so a realistic deployment must have both. The platform owner is deliberately a user who is NOT
  // a reset target, so the protected-owner rule is exercised rather than accidentally bypassed.
  await prisma.platformAuthority.create({ data: { id: "platform", ownerUserId: marker.ownerUserId } });
  await prisma.platformSettings.create({ data: { id: "platform" } });

  // A synthetic account seeded directly has no credential history, so give every fixture user the
  // version-1 security state a real registration would have created.
  for (const userId of [marker.ownerUserId, marker.adminUserId, marker.memberUserId, marker.sharedUserId]) {
    await prisma.accountSecurityState.create({
      data: { userId, credentialVersion: 1, sessionSecurityVersion: 1 }
    });
  }

  await writeFile(handoffFile, JSON.stringify(marker), { mode: 0o600, flag: "wx" });

  expect(await prisma.householdMember.count({ where: { userId: marker.sharedUserId, deletedAt: null } })).toBe(2);
});

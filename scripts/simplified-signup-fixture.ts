import { createHash, randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { PrismaClient } from "@prisma/client";
import { expect, it } from "vitest";

// Seeds the synthetic fixture for the simplified invitation signup acceptance rehearsal:
// one household, one platform owner who issues the invite, and one pending invitation addressed to
// a synthetic mailbox that is never contacted. Runs through the bootstrap superuser connection
// after the app image has applied migrations and provisioned roles.
//
// Nothing here is a real household, mailbox or credential. The invitation token is generated per
// run and handed to the probe in a temp file; only its sha256 is persisted, exactly as the real
// invitation service does.

const handoffFile = process.env.REHEARSAL_HANDOFF_FILE;
const databaseUrl = process.env.DATABASE_URL;
if (!handoffFile || !databaseUrl) throw new Error("simplified_signup_fixture_environment_not_set");

const prisma = new PrismaClient({ datasourceUrl: databaseUrl });
const suffix = randomBytes(6).toString("hex");

it("seeds a synthetic household and a pending invitation for the simplified signup rehearsal", async () => {
  const householdId = `hh_probe_${suffix}`;
  const ownerId = `usr_probe_owner_${suffix}`;
  const inviteeEmail = `invitee.${suffix}@rehearsal.invalid`;
  const invitationToken = randomBytes(32).toString("base64url");
  const tokenHash = createHash("sha256").update(invitationToken, "utf8").digest("hex");
  const offeredRole = "parent";

  await prisma.user.create({
    data: { id: ownerId, name: "Probe Owner", email: `owner.${suffix}@rehearsal.invalid`, emailVerified: true }
  });
  await prisma.household.create({ data: { id: householdId, name: `Probe Household ${suffix}`, createdByUserId: ownerId } });
  await prisma.householdMember.create({
    data: { householdId, userId: ownerId, role: "owner" }
  });

  const invite = await prisma.invite.create({
    data: {
      householdId,
      email: inviteeEmail,
      role: offeredRole,
      tokenHash,
      status: "pending",
      invitedByUserId: ownerId,
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
    },
    select: { id: true }
  });

  expect(invite.id).toBeTruthy();

  writeFileSync(handoffFile, JSON.stringify({
    householdId, ownerId, inviteeEmail, invitationToken, offeredRole, inviteId: invite.id
  }), "utf8");

  await prisma.$disconnect();
});

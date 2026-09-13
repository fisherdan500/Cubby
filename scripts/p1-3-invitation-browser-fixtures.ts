import { randomBytes, randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { hashPassword, verifyPassword } from "better-auth/crypto";
import { invitationFingerprint } from "../src/server/services/invitation-attestation";
import { getInvitationServices } from "../src/server/services/invitation-service";
import { p13SeededFixtureEmail } from "./p1-3-invitation-browser-fixture-identity";

type Recipient = {
  invitationToken: string;
  email: string;
  password: string;
  displayName: string;
  householdName: string;
};

export type P13InvitationBrowserFixtures = {
  newUser: Recipient;
  existingUser: Recipient;
};

type Issuer = {
  userId: string;
  sessionId: string;
  memberId: string;
  householdId: string;
  householdName: string;
};

function fixtureDatabaseUrl() {
  const value = process.env.FIXTURE_DATABASE_URL;
  if (!value) throw new Error("p1_3_invitation_acceptance_browser_fixture_database_unavailable");
  return value;
}

function generatedPassword() {
  return `P13-${randomBytes(24).toString("base64url")}`;
}

async function seedIssuer(database: PrismaClient, suffix: string): Promise<Issuer> {
  const now = new Date();
  const issuer = {
    userId: `p13_browser_owner_${suffix}`,
    sessionId: `p13_browser_owner_session_${suffix}`,
    memberId: `p13_browser_owner_member_${suffix}`,
    householdId: `p13_browser_household_${suffix}`,
    householdName: `Invitation household ${suffix}`
  };
  const password = await hashPassword(generatedPassword());
  await database.$transaction(async (tx) => {
    await tx.user.create({ data: { id: issuer.userId, name: `Invitation owner ${suffix}`, email: p13SeededFixtureEmail("owner", suffix), emailVerified: true, createdAt: now, updatedAt: now } });
    await tx.account.create({ data: { id: `p13_browser_owner_account_${suffix}`, accountId: issuer.userId, providerId: "credential", userId: issuer.userId, password, createdAt: now, updatedAt: now } });
    await tx.accountSecurityState.create({ data: { userId: issuer.userId, credentialVersion: 1, sessionSecurityVersion: 1, securityUpdatedAt: now } });
    await tx.session.create({ data: { id: issuer.sessionId, token: randomBytes(32).toString("base64url"), userId: issuer.userId, expiresAt: new Date(now.getTime() + 86_400_000), createdAt: now, updatedAt: now } });
    await tx.household.create({ data: { id: issuer.householdId, name: issuer.householdName, createdByUserId: issuer.userId, createdAt: now, updatedAt: now } });
    await tx.householdMember.create({ data: { id: issuer.memberId, householdId: issuer.householdId, userId: issuer.userId, role: "owner", joinedAt: now, createdAt: now, updatedAt: now } });
  });
  return issuer;
}

async function seedExistingRecipient(database: PrismaClient, suffix: string, householdName: string): Promise<Recipient> {
  const now = new Date();
  const password = generatedPassword();
  const userId = `p13_browser_existing_${suffix}`;
  const email = p13SeededFixtureEmail("existing", suffix);
  await database.$transaction(async (tx) => {
    await tx.user.create({ data: { id: userId, name: `Existing recipient ${suffix}`, email, emailVerified: true, createdAt: now, updatedAt: now } });
    await tx.account.create({ data: { id: `p13_browser_existing_account_${suffix}`, accountId: userId, providerId: "credential", userId, password: await hashPassword(password), createdAt: now, updatedAt: now } });
    await tx.accountSecurityState.create({ data: { userId, credentialVersion: 1, sessionSecurityVersion: 1, securityUpdatedAt: now } });
  });
  return { invitationToken: "", email, password, displayName: `Existing recipient ${suffix}`, householdName };
}

/**
 * Proves the seeded credential verifies against the row actually persisted, not just against an
 * in-memory hash. A seed whose stored credential cannot verify would otherwise surface far downstream
 * as an ordinary sign-in rejection with no indication that the fixture was at fault.
 */
async function assertSeededCredentialVerifies(database: PrismaClient, recipient: Recipient) {
  const user = await database.user.findFirst({ where: { email: recipient.email }, select: { id: true } });
  const account = user
    ? await database.account.findFirst({ where: { userId: user.id, providerId: "credential" }, select: { password: true } })
    : null;
  const stored = account?.password;
  if (!stored || !(await verifyPassword({ hash: stored, password: recipient.password }))) {
    throw new Error("p1_3_invitation_acceptance_browser_fixture_credential_unverifiable");
  }
}

function invitationToken(receipt: unknown) {
  const value = receipt && typeof receipt === "object" ? (receipt as Record<string, unknown>).inviteToken : null;
  if (typeof value !== "string" || value.length < 32) throw new Error("p1_3_invitation_acceptance_browser_fixture_invite_invalid");
  return value;
}

async function issueInvitation(issuer: Issuer, recipient: Recipient, role: "parent" | "admin") {
  const services = await getInvitationServices();
  const operationId = randomUUID();
  const openingFingerprint = randomBytes(32);
  const request = {
    ordinarySessionId: issuer.sessionId,
    subjectUserId: issuer.userId,
    issuerMembershipEpisodeId: issuer.memberId,
    subjectMembershipEpisodeId: null,
    openingFingerprint,
    intentFingerprint: null
  };
  await services.manualCreate.reserve({
    operationId,
    householdId: issuer.householdId,
    role,
    expiresInHours: 24,
    recipientEmail: recipient.email,
    request
  });
  const receipt = await services.manualCreate.submit({
    operationId,
    householdId: issuer.householdId,
    request: {
      ...request,
      intentFingerprint: invitationFingerprint("manual_invite_create", { operationId, householdId: issuer.householdId, role })
    }
  });
  return invitationToken(receipt);
}

export async function createP13InvitationBrowserFixtures(): Promise<P13InvitationBrowserFixtures> {
  const database = new PrismaClient({ datasourceUrl: fixtureDatabaseUrl() });
  try {
    const suffix = randomBytes(18).toString("base64url");
    const issuer = await seedIssuer(database, suffix);
    const newUser: Recipient = {
      invitationToken: "",
      email: `p13-browser-new-${suffix}@acceptance.invalid`,
      password: generatedPassword(),
      displayName: `New recipient ${suffix}`,
      householdName: issuer.householdName
    };
    const existingUser = await seedExistingRecipient(database, suffix, issuer.householdName);
    await assertSeededCredentialVerifies(database, existingUser);
    newUser.invitationToken = await issueInvitation(issuer, newUser, "parent");
    existingUser.invitationToken = await issueInvitation(issuer, existingUser, "admin");
    return { newUser, existingUser };
  } catch {
    throw new Error("p1_3_invitation_acceptance_browser_fixture_failed");
  } finally {
    await database.$disconnect();
  }
}

export async function disposeP13InvitationBrowserFixtures(fixtures: P13InvitationBrowserFixtures | undefined) {
  if (fixtures) {
    fixtures.newUser.invitationToken = "";
    fixtures.newUser.email = "";
    fixtures.newUser.password = "";
    fixtures.newUser.displayName = "";
    fixtures.newUser.householdName = "";
    fixtures.existingUser.invitationToken = "";
    fixtures.existingUser.email = "";
    fixtures.existingUser.password = "";
    fixtures.existingUser.displayName = "";
    fixtures.existingUser.householdName = "";
  }
  const [{ invitationPrisma }, { prisma }, { authPrisma }, { invitationExpiryPrisma }, { invitationMaintenancePrisma }] = await Promise.all([
    import("../src/lib/db/invitation-prisma"),
    import("../src/lib/db/prisma"),
    import("../src/lib/db/auth-prisma"),
    import("../src/lib/db/invitation-expiry-prisma"),
    import("../src/lib/db/invitation-maintenance-prisma")
  ]);
  await Promise.all([invitationPrisma.$disconnect(), prisma.$disconnect(), authPrisma.$disconnect(), invitationExpiryPrisma.$disconnect(), invitationMaintenancePrisma.$disconnect()]);
}

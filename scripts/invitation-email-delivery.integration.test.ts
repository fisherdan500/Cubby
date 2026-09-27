import { createHash, randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Prisma, PrismaClient } from "@prisma/client";
import { createInvitationAttestationSigner } from "@/server/services/invitation-attestation";
import { createInvitationServices } from "@/server/services/invitation-service";
import { createEmailDeliveryCipher } from "@/server/services/email-change-delivery";
import { queueManualInvitationEmail } from "@/server/services/invitation-email-queue";
import { dispatchInvitationEmailDelivery } from "@/server/services/invitation-email-delivery";

// Runs only inside `verify:invitation-email-delivery`, against its throwaway PostgreSQL. Every effect goes
// through the production role that owns it; the owner connection only seeds fixtures and inspects rows.
const ownerUrl = process.env.DATABASE_URL ?? "";
const owner = new PrismaClient({ datasourceUrl: ownerUrl });
const attestationKey = randomBytes(32);
const emailKey = randomBytes(32);
const environment = {
  SMTP_HOST: "smtp.acceptance.invalid", SMTP_PORT: "587", SMTP_USER: "acceptance", SMTP_PASSWORD: randomBytes(12).toString("hex"), EMAIL_FROM: "Cubby <noreply@acceptance.invalid>",
  CUBBY_EMAIL_DELIVERY_KEYRING: `1:${emailKey.toString("base64url")}`, CUBBY_EMAIL_DELIVERY_ACTIVE_KEY_VERSION: "1",
  BETTER_AUTH_URL: "https://cubby.acceptance.invalid", APP_TIMEZONE: "UTC"
};
const passwords = { cubby_runtime: randomBytes(16).toString("hex"), cubby_invitation_runtime: randomBytes(16).toString("hex"), cubby_email_delivery: randomBytes(16).toString("hex") };
const clients: PrismaClient[] = [owner];
const connect = (role: keyof typeof passwords) => {
  const url = new URL(ownerUrl); url.username = role; url.password = passwords[role];
  const client = new PrismaClient({ datasourceUrl: url.toString() }); clients.push(client); return client;
};
const suffix = randomBytes(6).toString("hex");
const issuer = { userId: `iem_user_${suffix}`, sessionId: `iem_session_${suffix}`, householdId: `iem_household_${suffix}`, memberId: `iem_member_${suffix}` };
const sent: Array<{ recipient: string; subject: string; text: string; messageId: string }> = [];
const smtp = { send: async (payload: { recipient: string; subject: string; text: string; messageId: string }) => { sent.push(payload); return { responseCode: 250, messageId: payload.messageId, accepted: [payload.recipient] }; } };

let runtime: PrismaClient; let invitation: PrismaClient; let emailDelivery: PrismaClient;
let services: ReturnType<typeof createInvitationServices>;
const cipher = createEmailDeliveryCipher(environment);
const request = (intent: Buffer | null = null, opening = randomBytes(32)) => ({ ordinarySessionId: issuer.sessionId, subjectUserId: issuer.userId, issuerMembershipEpisodeId: issuer.memberId, subjectMembershipEpisodeId: null, openingFingerprint: opening, intentFingerprint: intent });
const workerToken = () => randomBytes(16).toString("base64url");
const tokenHash = (token: string) => createHash("sha256").update(token, "utf8").digest("hex");
const deliveryFor = (inviteId: string) => owner.$queryRaw<Array<{ state: string; lastFailureCode: string | null; ciphertext: Buffer | null }>>(Prisma.sql`SELECT "state"::text AS "state","lastFailureCode","ciphertext" FROM "InvitationEmailDelivery" WHERE "inviteId"=${inviteId}`);
const inviteByToken = async (token: string) => (await owner.$queryRaw<Array<{ id: string; status: string }>>(Prisma.sql`SELECT "id","status"::text AS "status" FROM "Invite" WHERE "tokenHash"=${tokenHash(token)}`))[0]!;

async function createInvitation(recipientEmail: string, sendEmail = true) {
  const operationId = randomUUID(); const opening = randomBytes(32); const intent = randomBytes(32);
  await services.manualCreate.reserve({ operationId, householdId: issuer.householdId, role: "caretaker", expiresInHours: 24, recipientEmail, request: request(null, opening) });
  const receipt = await services.manualCreate.submit({ operationId, householdId: issuer.householdId, request: request(intent, opening) }) as { status: string; inviteToken: string };
  expect(receipt.status).toBe("created");
  const email = sendEmail ? await queueManualInvitationEmail({ services, operationId, operationKind: "MANUAL_INVITE_CREATE", target: issuer.householdId, householdId: issuer.householdId, inviteToken: receipt.inviteToken, request: request(intent, opening) }, { database: runtime, environment }) : "not_requested";
  return { operationId, opening, intent, token: receipt.inviteToken, email };
}

async function drain() {
  const results = [];
  for (;;) { const result = await dispatchInvitationEmailDelivery(emailDelivery, workerToken(), { cipher, smtp }); if (result.status === "idle") return results; results.push(result); }
}

beforeAll(async () => {
  for (const [role, password] of Object.entries(passwords)) await owner.$executeRawUnsafe(`ALTER ROLE ${role} LOGIN PASSWORD '${password}'`);
  await owner.$executeRaw`INSERT INTO "FreshAuthAttestationKey" ("keyVersion","verificationKey","active") VALUES (1, ${attestationKey}, true)`;
  await owner.$executeRaw`INSERT INTO "EmailDeliveryEncryptionKey" ("keyVersion","keyDigest","activeWrite") VALUES (1, ${createHash("sha256").update(emailKey).digest()}, true)`;
  const now = new Date();
  await owner.user.create({ data: { id: issuer.userId, name: "Dana", email: `owner-${suffix}@acceptance.invalid`, emailVerified: true, createdAt: now, updatedAt: now } });
  await owner.accountSecurityState.create({ data: { userId: issuer.userId, credentialVersion: 1, sessionSecurityVersion: 1, securityUpdatedAt: now } });
  await owner.session.create({ data: { id: issuer.sessionId, token: randomBytes(32).toString("base64url"), userId: issuer.userId, expiresAt: new Date(now.getTime() + 86_400_000), createdAt: now, updatedAt: now } });
  await owner.household.create({ data: { id: issuer.householdId, name: "Acceptance Home", createdByUserId: issuer.userId, createdAt: now, updatedAt: now } });
  await owner.householdMember.create({ data: { id: issuer.memberId, householdId: issuer.householdId, userId: issuer.userId, role: "owner", joinedAt: now, createdAt: now, updatedAt: now } });
  runtime = connect("cubby_runtime"); invitation = connect("cubby_invitation_runtime"); emailDelivery = connect("cubby_email_delivery");
  const signer = createInvitationAttestationSigner({ CUBBY_FRESH_AUTH_ATTESTATION_KEYRING: `1:${attestationKey.toString("base64url")}`, CUBBY_FRESH_AUTH_ATTESTATION_ACTIVE_KEY_VERSION: "1" });
  services = createInvitationServices({ runtime: invitation, expiry: invitation, maintenance: invitation, signer });
});

afterAll(async () => { await Promise.all(clients.map((client) => client.$disconnect())); });

describe("invitation email delivery against real PostgreSQL and production roles", () => {
  it("queues an encrypted invitation email, sends it once, and clears the ciphertext", async () => {
    const created = await createInvitation("first@acceptance.invalid");
    expect(created.email).toBe("queued");
    const invite = await inviteByToken(created.token);
    const [queued] = await deliveryFor(invite.id);
    expect(queued).toMatchObject({ state: "queued", lastFailureCode: null });
    expect(Buffer.from(queued!.ciphertext!).toString("utf8")).not.toContain(created.token);
    const results = await drain();
    expect(results).toEqual([expect.objectContaining({ status: "accepted" })]);
    const message = sent.at(-1)!;
    expect(message.recipient).toBe("first@acceptance.invalid");
    expect(message.text).toContain(`https://cubby.acceptance.invalid/invite#c=${created.token}`);
    expect(message.text).toContain("Dana invited you to join Acceptance Home on Cubby.");
    expect(await deliveryFor(invite.id)).toEqual([{ state: "accepted", lastFailureCode: null, ciphertext: null }]);
    expect(await drain()).toEqual([]);
  });

  it("lets the runtime role read status but never the ciphertext", async () => {
    const created = await createInvitation("status@acceptance.invalid");
    const invite = await inviteByToken(created.token);
    const rows = await runtime.invitationEmailDelivery.findMany({ where: { householdId: issuer.householdId, inviteId: { in: [invite.id] } }, select: { inviteId: true, state: true } });
    expect(rows).toEqual([{ inviteId: invite.id, state: "queued" }]);
    await expect(runtime.$queryRaw`SELECT "ciphertext" FROM "InvitationEmailDelivery" LIMIT 1`).rejects.toThrow(/permission denied/);
    await expect(invitation.$queryRaw`SELECT "id" FROM "InvitationEmailDelivery" LIMIT 1`).rejects.toThrow(/permission denied/);
    await expect(emailDelivery.$queryRaw`SELECT "id" FROM "InvitationEmailDelivery" LIMIT 1`).rejects.toThrow(/permission denied/);
    await expect(runtime.$queryRaw`SELECT * FROM "claim_invitation_email_delivery"(${workerToken()})`).rejects.toThrow(/permission denied/);
    await drain();
  });

  it("queues at most one email per invitation and refuses a token it did not issue", async () => {
    const created = await createInvitation("once@acceptance.invalid");
    const again = await queueManualInvitationEmail({ services, operationId: created.operationId, operationKind: "MANUAL_INVITE_CREATE", target: issuer.householdId, householdId: issuer.householdId, inviteToken: created.token, request: request(created.intent, created.opening) }, { database: runtime, environment });
    expect(again).toBe("queued");
    expect(await deliveryFor((await inviteByToken(created.token)).id)).toHaveLength(1);
    const cipherPayload = cipher.encrypt({ deliveryId: `ied_${randomBytes(16).toString("hex")}`, userId: "x", operationId: created.operationId, kind: "household_invitation", recipientDigest: randomBytes(32) }, { recipient: "x", subject: "x", text: "x" });
    await expect(services.manualEmail.enqueue({ operationId: created.operationId, operationKind: "MANUAL_INVITE_CREATE", target: issuer.householdId, tokenHash: tokenHash("not-the-issued-token"), delivery: { deliveryId: `ied_${randomBytes(16).toString("hex")}`, recipientDigest: randomBytes(32), encrypted: cipherPayload }, request: request(created.intent, created.opening) })).rejects.toThrow(/invitation_email_enqueue_invalid/);
    await drain();
  });

  it("cancels an unsent email and destroys its ciphertext when the invitation is revoked", async () => {
    const created = await createInvitation("revoked@acceptance.invalid");
    const invite = await inviteByToken(created.token);
    await services.revoke({ inviteId: invite.id, operationId: randomUUID(), request: request(randomBytes(32)) });
    expect(await deliveryFor(invite.id)).toEqual([{ state: "permanent_failed", lastFailureCode: "cancelled", ciphertext: null }]);
    const before = sent.length;
    expect(await drain()).toEqual([]);
    expect(sent.length).toBe(before);
  });

  it("re-sends by emailing a replacement link, which cancels nothing already sent", async () => {
    const created = await createInvitation("resend@acceptance.invalid");
    await drain();
    const original = await inviteByToken(created.token);
    const operationId = randomUUID(); const opening = randomBytes(32); const intent = randomBytes(32);
    await services.manualReplace.reserve({ operationId, inviteId: original.id, expiresInHours: 24, request: request(null, opening) });
    const receipt = await services.manualReplace.submit({ operationId, inviteId: original.id, request: request(intent, opening) }) as { status: string; inviteToken: string };
    expect(receipt.status).toBe("replaced");
    const email = await queueManualInvitationEmail({ services, operationId, operationKind: "MANUAL_INVITE_REPLACE", target: original.id, householdId: issuer.householdId, inviteToken: receipt.inviteToken, request: request(intent, opening) }, { database: runtime, environment });
    expect(email).toBe("queued");
    expect(await drain()).toEqual([expect.objectContaining({ status: "accepted" })]);
    expect(sent.at(-1)!.text).toContain(`#c=${receipt.inviteToken}`);
    expect((await inviteByToken(created.token)).status).toBe("revoked");
    expect(await deliveryFor(original.id)).toEqual([{ state: "accepted", lastFailureCode: null, ciphertext: null }]);
  });

  it("keeps an encryption key while a queued email still needs it", async () => {
    await createInvitation("keyed@acceptance.invalid");
    await expect(owner.$executeRaw`DELETE FROM "EmailDeliveryEncryptionKey" WHERE "keyVersion"=1`).rejects.toThrow(/email_delivery_key_still_referenced/);
    await drain();
  });

  it("removes deliveries with their invitation", async () => {
    const created = await createInvitation("deleted@acceptance.invalid");
    const invite = await inviteByToken(created.token);
    await owner.$executeRaw`DELETE FROM "Invite" WHERE "id"=${invite.id}`;
    expect(await deliveryFor(invite.id)).toEqual([]);
  });
});

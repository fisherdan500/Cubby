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
const destination = new URL(ownerUrl);
if (destination.hostname !== "127.0.0.1" || destination.pathname !== "/cubby_invitation_email_acceptance") throw new Error("invitation_email_disposable_database_required");
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
let signer: ReturnType<typeof createInvitationAttestationSigner>;
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const transactionServices = (tx: Prisma.TransactionClient) => createInvitationServices({ runtime: tx, expiry: tx, maintenance: tx, signer });
const claim = (client: Prisma.TransactionClient, worker: string) => client.$queryRaw<Array<{ id: string; inviteId: string; attemptCount: number }>>(Prisma.sql`SELECT "id","inviteId","attemptCount" FROM "claim_invitation_email_delivery"(${worker})`);
const backendPid = async (tx: Prisma.TransactionClient) => (await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`)[0]!.pid;

async function waitForBlock(waiter: number, blocker: number) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const [row] = await owner.$queryRaw<Array<{ blocked: boolean }>>(Prisma.sql`SELECT ${blocker}::integer=ANY(pg_blocking_pids(${waiter}::integer)) AS blocked`);
    if (row?.blocked) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("invitation_email_expected_lock_wait_missing");
}

// Accelerate only fixture time, never state/attempt count. The production transition guard deliberately
// disallows same-state updates; disable only that guard inside a rollback-safe owner transaction.
async function ageDelivery(inviteId: string, field: "leaseExpiresAt" | "nextAttemptAt") {
  await owner.$transaction(async (tx) => {
    await tx.$executeRaw`ALTER TABLE "InvitationEmailDelivery" DISABLE TRIGGER "InvitationEmailDelivery_transition_guard"`;
    if (field === "leaseExpiresAt") await tx.$executeRaw`UPDATE "InvitationEmailDelivery" SET "leaseExpiresAt"=clock_timestamp()-INTERVAL '1 second' WHERE "inviteId"=${inviteId}`;
    else await tx.$executeRaw`UPDATE "InvitationEmailDelivery" SET "nextAttemptAt"=clock_timestamp()-INTERVAL '1 second' WHERE "inviteId"=${inviteId}`;
    await tx.$executeRaw`ALTER TABLE "InvitationEmailDelivery" ENABLE TRIGGER "InvitationEmailDelivery_transition_guard"`;
  });
}

async function expectCleared(inviteId: string, failure: string) {
  const [row] = await owner.$queryRaw<Array<Record<string, unknown>>>(Prisma.sql`SELECT "state"::text AS "state","lastFailureCode","ciphertext","iv","authTag","aadDigest","keyVersion","leaseOwner","leaseExpiresAt","nextAttemptAt" FROM "InvitationEmailDelivery" WHERE "inviteId"=${inviteId}`);
  expect(row).toEqual({ state: "permanent_failed", lastFailureCode: failure, ciphertext: null, iv: null, authTag: null, aadDigest: null, keyVersion: null, leaseOwner: null, leaseExpiresAt: null, nextAttemptAt: null });
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
  signer = createInvitationAttestationSigner({ CUBBY_FRESH_AUTH_ATTESTATION_KEYRING: `1:${attestationKey.toString("base64url")}`, CUBBY_FRESH_AUTH_ATTESTATION_ACTIVE_KEY_VERSION: "1" });
  services = createInvitationServices({ runtime: invitation, expiry: invitation, maintenance: invitation, signer });
});

afterAll(async () => { await Promise.all(clients.map((client) => client.$disconnect())); });

describe("invitation email delivery against real PostgreSQL and production roles", () => {
  it("abandons a prepared creation with the exact SQL purpose and creates no invitation", async () => {
    const operationId = randomUUID(); const opening = randomBytes(32);
    const recipientEmail = `abandon-${randomUUID()}@acceptance.invalid`;
    const input = { operationId, householdId: issuer.householdId, request: request(null, opening) };
    expect(await services.manualCreate.reserve({ ...input, role: "caretaker", expiresInHours: 24, recipientEmail })).toMatchObject({ status: "prepared" });
    expect(await services.manualCreate.abandon(input)).toMatchObject({ status: "abandoned" });
    expect(await services.manualCreate.status(input)).toMatchObject({ state: "ABANDONED" });
    expect(await owner.invite.count({ where: { householdId: issuer.householdId, email: recipientEmail } })).toBe(0);
  });

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

  it("allows a claimed in-flight delivery to finish while revoke waits on its row", async () => {
    const created = await createInvitation("claim-first@acceptance.invalid");
    const invite = await inviteByToken(created.token); const worker = workerToken();
    const ready = deferred<{ pid: number; deliveryId: string }>(); const release = deferred<void>();
    const waiterReady = deferred<number>();
    const holder = emailDelivery.$transaction(async (tx) => {
      const pid = await backendPid(tx); const rows = await claim(tx, worker);
      expect(rows).toEqual([expect.objectContaining({ inviteId: invite.id, attemptCount: 1 })]);
      ready.resolve({ pid, deliveryId: rows[0]!.id }); await release.promise;
    }, { timeout: 30_000, isolationLevel: "Serializable" }).catch((error) => { ready.reject(error); throw error; });
    void holder.catch(() => {});
    let waiter: Promise<unknown> | undefined;
    try {
      const held = await ready.promise;
      waiter = invitation.$transaction(async (tx) => {
        waiterReady.resolve(await backendPid(tx));
        return transactionServices(tx).revoke({ inviteId: invite.id, operationId: randomUUID(), request: request(randomBytes(32)) });
      }, { timeout: 30_000 }).catch((error) => { waiterReady.reject(error); throw error; });
      void waiter.catch(() => {});
      await waitForBlock(await waiterReady.promise, held.pid);
      release.resolve(); await holder; expect(await waiter).toMatchObject({ status: "revoked" });
      expect((await inviteByToken(created.token)).status).toBe("revoked");
      expect((await deliveryFor(invite.id))[0]).toMatchObject({ state: "dispatching" });
      await emailDelivery.$executeRaw`SELECT "accept_invitation_email_delivery"(${held.deliveryId},${worker},250,${randomBytes(32)})`;
      expect((await deliveryFor(invite.id))[0]).toEqual({ state: "accepted", lastFailureCode: null, ciphertext: null });
    } finally { release.resolve(); await Promise.allSettled([holder, ...(waiter ? [waiter] : [])]); }
  });

  it("skips a delivery locked by revoke and never claims it after revocation commits", async () => {
    const created = await createInvitation("revoke-first@acceptance.invalid"); const invite = await inviteByToken(created.token);
    const ready = deferred<void>(); const release = deferred<void>();
    const holder = invitation.$transaction(async (tx) => {
      expect(await transactionServices(tx).revoke({ inviteId: invite.id, operationId: randomUUID(), request: request(randomBytes(32)) })).toMatchObject({ status: "revoked" });
      ready.resolve(); await release.promise;
    }, { timeout: 30_000 }).catch((error) => { ready.reject(error); throw error; });
    void holder.catch(() => {});
    try {
      await ready.promise;
      expect(await claim(emailDelivery, workerToken())).toEqual([]);
      release.resolve(); await holder;
      await expectCleared(invite.id, "cancelled");
      expect(await claim(emailDelivery, workerToken())).toEqual([]);
    } finally { release.resolve(); await Promise.allSettled([holder]); }
  });

  it("recovers expired leases, rejects stale receipts, and exhausts exactly eight attempts", async () => {
    const created = await createInvitation("lease@acceptance.invalid"); const invite = await inviteByToken(created.token);
    for (let attempt = 1; attempt <= 8; attempt += 1) {
      const worker = workerToken(); const rows = await claim(emailDelivery, worker);
      expect(rows).toEqual([expect.objectContaining({ inviteId: invite.id, attemptCount: attempt })]);
      await ageDelivery(invite.id, "leaseExpiresAt");
      await expect(emailDelivery.$executeRaw`SELECT "accept_invitation_email_delivery"(${rows[0]!.id},${worker},250,${randomBytes(32)})`).rejects.toThrow(/email_delivery_lease_lost/);
      expect(await claim(emailDelivery, workerToken())).toEqual([]);
      if (attempt < 8) {
        const [row] = await owner.$queryRaw<Array<{ future: boolean; attemptCount: number; state: string }>>`SELECT "nextAttemptAt">clock_timestamp() AS future,"attemptCount","state"::text AS state FROM "InvitationEmailDelivery" WHERE "inviteId"=${invite.id}`;
        expect(row).toEqual({ future: true, attemptCount: attempt, state: "retryable_failed" });
        expect((await deliveryFor(invite.id))[0]!.ciphertext).not.toBeNull();
        await ageDelivery(invite.id, "nextAttemptAt");
      }
    }
    await expectCleared(invite.id, "attempts_exhausted");
    expect(await claim(emailDelivery, workerToken())).toEqual([]);
  });

  it.each(["queued", "retryable_failed"] as const)("cancels %s ciphertext when the invitation expires before claim", async (state) => {
    const created = await createInvitation(`${state}@acceptance.invalid`); const invite = await inviteByToken(created.token);
    if (state === "retryable_failed") {
      const worker = workerToken(); const [row] = await claim(emailDelivery, worker);
      await emailDelivery.$executeRaw`SELECT "fail_invitation_email_delivery"(${row!.id},${worker},'smtp_connection')`;
    }
    await owner.invite.update({ where: { id: invite.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect(await claim(emailDelivery, workerToken())).toEqual([]);
    await expectCleared(invite.id, "expired");
  });

  it.each(["accepted", "expired", "conflicted"] as const)("the database status trigger cancels unsent mail on %s", async (status) => {
    const created = await createInvitation(`${status}@acceptance.invalid`); const invite = await inviteByToken(created.token);
    // This is the database cancellation boundary, not browser acceptance or membership enrollment.
    await owner.invite.update({ where: { id: invite.id }, data: { status } });
    await expectCleared(invite.id, "cancelled");
    expect(await claim(emailDelivery, workerToken())).toEqual([]);
  });

  it("permits removal of an encryption key after ciphertext clearance while terminal rows remain", async () => {
    const created = await createInvitation("clear-key@acceptance.invalid"); const invite = await inviteByToken(created.token);
    await expect(owner.$executeRaw`DELETE FROM "EmailDeliveryEncryptionKey" WHERE "keyVersion"=1`).rejects.toThrow(/email_delivery_key_still_referenced/);
    await drain();
    expect((await deliveryFor(invite.id))[0]).toEqual({ state: "accepted", lastFailureCode: null, ciphertext: null });
    // Preserve the canonical exactly-one-active-key invariant while retiring the cleared old key.
    await owner.$transaction(async (tx) => {
      await tx.$executeRaw`UPDATE "EmailDeliveryEncryptionKey" SET "activeWrite"=false,"retiredAt"=clock_timestamp() WHERE "keyVersion"=1`;
      await tx.$executeRaw`INSERT INTO "EmailDeliveryEncryptionKey" ("keyVersion","keyDigest","activeWrite") VALUES (2,${randomBytes(32)},true)`;
    });
    expect(await owner.$executeRaw`DELETE FROM "EmailDeliveryEncryptionKey" WHERE "keyVersion"=1`).toBe(1);
    expect(await owner.$queryRaw`SELECT "keyVersion" FROM "EmailDeliveryEncryptionKey" WHERE "keyVersion"=1`).toEqual([]);
    expect(await deliveryFor(invite.id)).toHaveLength(1);
  });

  it("preserves the existing fail-closed deletion boundary for households with protocol tombstones", async () => {
    const [delivery] = await owner.$queryRaw<Array<{ inviteId: string }>>`SELECT "inviteId" FROM "InvitationEmailDelivery" WHERE "householdId"=${issuer.householdId} AND "state"='accepted' LIMIT 1`;
    expect(delivery).toBeDefined();
    await expect(owner.household.delete({ where: { id: issuer.householdId } })).rejects.toThrow(/invitation_tombstone_immutable/);
    expect(await deliveryFor(delivery!.inviteId)).toHaveLength(1);
    expect(await owner.household.count({ where: { id: issuer.householdId } })).toBe(1);
  });

  it("cascades the queue household FK in isolation without enabling protocol household deletion", async () => {
    // Exercise this queue's FK using a minimal owner-seeded relation fixture with no protocol tombstone.
    // The preceding test separately requires full protocol household deletion to remain forbidden.
    const otherId = `iem_other_${randomUUID()}`;
    await owner.household.create({ data: { id: otherId, name: "Other synthetic home", createdByUserId: issuer.userId } });
    const invite = await owner.invite.create({ data: { householdId: otherId, invitedByUserId: issuer.userId, email: "cascade@acceptance.invalid", role: "caretaker", tokenHash: tokenHash(randomUUID()), expiresAt: new Date(Date.now() + 3600_000) } });
    await owner.invitationEmailDelivery.create({ data: { id: `ied_${randomBytes(16).toString("hex")}`, householdId: otherId, inviteId: invite.id, operationId: randomUUID(), recipientDigest: createHash("sha256").update(invite.email).digest(), ciphertext: randomBytes(32), iv: randomBytes(12), authTag: randomBytes(16), aadDigest: randomBytes(32), keyVersion: 2 } });
    expect(await deliveryFor(invite.id)).toHaveLength(1);
    await owner.household.delete({ where: { id: otherId } });
    expect(await deliveryFor(invite.id)).toEqual([]);
    expect(await owner.invite.count({ where: { householdId: otherId } })).toBe(0);
    expect(await owner.household.count({ where: { id: issuer.householdId } })).toBe(1);
  });

});
